import json
import logging
import os
from uuid import uuid4
from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, cli, function_tool, room_io
from livekit.plugins import google

load_dotenv()

# The livekit-plugins-google reads GOOGLE_API_KEY from env.
# We alias GEMINI_API_KEY -> GOOGLE_API_KEY so both names work.
if not os.getenv("GOOGLE_API_KEY") and os.getenv("GEMINI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]

logger = logging.getLogger("tablo-agent")


class TabloAgent(Agent):
    def __init__(self, room):
        super().__init__(
            instructions=(
                "You are Tablo, a voice assistant for a collaborative learning whiteboard. "
                "IMPORTANT: You MUST use the execute_command tool to draw anything on the board. "
                "Never just say you drew something - you must actually call the execute_command tool. "
                "The tool takes a JSON command string. Examples: "
                '{"v":1,"id":"123","op":"create_geo","geo":"triangle","x":100,"y":100,"w":80,"h":80} '
                "to draw a triangle, or "
                '{"v":1,"id":"124","op":"create_text","text":"Hello","x":50,"y":50} '
                "to draw text. "
                "Keep responses short for voice. When you need to draw, call execute_command with the appropriate JSON."
            )
        )
        self._room = room

    async def _publish_board_command(self, command: dict) -> None:
        payload = json.dumps(command).encode("utf-8")
        await self._room.local_participant.publish_data(
            payload,
            reliable=True,
            topic="board.command",
        )

    @function_tool()
    async def execute_command(
        self,
        context: RunContext,
        command_json: str,
    ) -> str:
        """Execute any board command directly. Send a JSON command to the board.

        Args:
            command_json: Complete JSON command object as a string.

        IMPORTANT - Geo types mapping (use these EXACT values):
            - For CIRCLE use: "ellipse" (NOT "circle")
            - For BOX/SQUARE use: "rectangle" (NOT "box" or "square")
            - For RIGHT TRIANGLE use: "triangle" (NOT "right_triangle")
            - Valid geo types: "rectangle", "ellipse", "triangle", "diamond", "pentagon", "hexagon", "octagon", "star", "rhombus", "oval", "trapezoid"
            - For arrows, use the create_arrow command NOT create_geo

        IMPORTANT - For 3D shapes or complex shapes:
            - Use create_freehand command to draw freehand strokes
            - The AI can draw ANYTHING using freehand - this is the most flexible option
            - Example freehand: {"v":1,"id":"uuid","op":"create_freehand","points":[{"x":0,"y":0},{"x":50,"y":50},{"x":100,"y":0}]}

        Examples:
            - Draw circle: {"v":1,"id":"uuid","op":"create_geo","geo":"ellipse","x":100,"y":100,"w":80,"h":80}
            - Draw triangle: {"v":1,"id":"uuid","op":"create_geo","geo":"triangle","x":100,"y":100,"w":80,"h":80}
            - Draw text: {"v":1,"id":"uuid","op":"create_text","text":"Hello","x":50,"y":50}
            - Draw arrow: {"v":1,"id":"uuid","op":"create_arrow","x":0,"y":0,"toX":100,"toY":100}
            - Draw freehand (any shape): {"v":1,"id":"uuid","op":"create_freehand","points":[{"x":0,"y":0},{"x":25,"y":50},{"x":50,"y":25}]}
            - Clear board: {"v":1,"id":"uuid","op":"clear_board"}

        Supported operations (op values):
            - create_text: Draw text at x,y
            - create_geo: Draw geometric shapes (geo: rectangle, ellipse, triangle, diamond, pentagon, hexagon, octagon)
            - create_arrow: Draw arrow from x,y to toX,toY
            - create_text_on_target: Draw text relative to a target shape
            - create_arrow_between_targets: Draw arrow between two target shapes
            - create_freehand: Draw freehand strokes (points array)
            - create_3d_cube, create_3d_cylinder, create_3d_cone, create_3d_pyramid, create_3d_prism: Draw 3D shapes
            - create_formula: Draw math formulas (supports ^ superscript, _ subscript, sqrt(), Greek letters)
            - create_multiline_text: Draw multiple lines of text
            - create_side_label: Label a side of a shape (side: normal/inverted/side-inverted)
            - clear_board: Clear all shapes
            - clear_shapes: Clear specific shapes by ID
            - clear_region: Clear shapes in a region
            - get_board_state: Get info about what's on the board
            - get_shape_info: Get info about a specific shape
            - match_shapes: Find shapes by properties
            - get_position_info: Get board position info
            - calculate_position: Calculate position relative to a shape
            - snap_to_grid: Snap coordinates to grid
            - align_shapes: Align two shapes
            - place_with_collision_check: Place shape with collision detection
        """
        try:
            command = json.loads(command_json)
            # Ensure version and id fields
            if "v" not in command:
                command["v"] = 1
            if "id" not in command:
                command["id"] = str(uuid4())
            logger.info(f"Publishing board command: {command.get('op')} - {command}")
            await self._publish_board_command(command)
            return f"command executed: {command.get('op', 'unknown')}"
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in execute_command: {e}")
            return f"Error: Invalid JSON - {str(e)}"

    def _target_ref(self, target: str) -> dict:
        raw_target = (target or "selection").strip()
        normalized = raw_target.lower()

        if normalized in {"selection", "selected"}:
            return {"kind": "selection"}
        if normalized in {"pointer", "cursor"}:
            return {"kind": "pointer"}
        if normalized in {"this", "that"}:
            return {"kind": normalized}
        if normalized.startswith("shape:") and len(raw_target) > 6:
            return {"kind": "shape_id", "shapeId": raw_target[6:]}

        return {"kind": "selection"}


async def entrypoint(ctx: JobContext):
    logger.info("Connecting to room: %s", ctx.room.name)

    await ctx.connect()

    logger.info("Connected. Starting Gemini Live session...")

    model = google.beta.realtime.RealtimeModel(
        model="gemini-2.5-flash-native-audio-preview-12-2025",
        voice="Aoede",
        proactivity=True,
        enable_affective_dialog=True,
        instructions=(
            "You are Tablo, a Socratic voice assistant for a collaborative learning "
            "whiteboard. You help learners think through problems by asking guiding "
            "questions rather than giving direct answers. Keep your responses concise "
            "and natural for voice. You can inspect the learner's board snapshots. "
            "If they draw, label, or erase something, reference it directly. Use "
            "target-aware board tools for placement and use this/that references when "
            "the learner points to objects."
        ),
        temperature=0.8,
    )

    session = AgentSession(llm=model)
    tablo_agent = TabloAgent(ctx.room)

    await session.start(
        agent=tablo_agent,
        room=ctx.room,
        room_options=room_io.RoomOptions(video_input=True),
    )

    logger.info("Agent session started in room: %s", ctx.room.name)

    await session.generate_reply(
        instructions=(
            "Greet the learner in one sentence and tell them you can see the board. "
            "If they ask for a visual explanation, draw while speaking."
        )
    )

    @session.on("user_speech_committed")
    def on_user_speech_committed(msg):
        logger.info("User speech committed: %s", msg)

    @session.on("agent_speech_started")
    def on_agent_speech_started():
        logger.info("Agent started speaking")

    @session.on("error")
    def on_error(err):
        logger.error("Session error: %s", err)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        logger.info("Subscribed to track %s from %s (%s)", track.sid, participant.identity, track.kind)



if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="tablo-assistant",
        )
    )
