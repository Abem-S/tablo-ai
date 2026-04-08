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
                "You are Tablo, a Socratic voice assistant for a collaborative learning "
                "whiteboard. Help learners reason step by step by asking guiding questions. "
                "You can see the board through live video. When explaining visual ideas, "
                "draw incrementally while you talk by calling board tools. Keep responses concise "
                "for voice and avoid dumping too many shapes at once. When placing labels or arrows, "
                "prefer target-anchored tools so marks land on the intended shape. You can target "
                "selection, pointer, this/that references, or explicit shape IDs. If references are "
                "ambiguous, ask a short clarification question before drawing."
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

    @function_tool()
    async def draw_text(
        self,
        context: RunContext,
        text: str,
        x: float,
        y: float,
    ) -> str:
        """Draw short text at board coordinates.

        Args:
            text: Text label to draw.
            x: X position in board space.
            y: Y position in board space.
        """
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_text",
            "text": text,
            "x": x,
            "y": y,
        }
        await self._publish_board_command(command)
        return "text drawn"

    @function_tool()
    async def draw_box(
        self,
        context: RunContext,
        x: float,
        y: float,
        w: float,
        h: float,
        label: str = "",
    ) -> str:
        """Draw a rectangular box with an optional label.

        Args:
            x: Left position in board space.
            y: Top position in board space.
            w: Width of the rectangle.
            h: Height of the rectangle.
            label: Optional text shown inside the shape.
        """
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_geo",
            "geo": "rectangle",
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "label": label,
        }
        await self._publish_board_command(command)
        return "box drawn"

    @function_tool()
    async def draw_text_near_selection(
        self,
        context: RunContext,
        text: str,
        offset_x: float = 0.0,
        offset_y: float = 0.0,
    ) -> str:
        """Draw text anchored to the center of the currently selected shape(s).

        Ask the learner to select the target shape first for precise placement.

        Args:
            text: Label text to place.
            offset_x: Horizontal offset from selection center.
            offset_y: Vertical offset from selection center.
        """
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_text_near_selection",
            "text": text,
            "offsetX": offset_x,
            "offsetY": offset_y,
        }
        await self._publish_board_command(command)
        return "selection-anchored text drawn"

    @function_tool()
    async def draw_text_on_target(
        self,
        context: RunContext,
        text: str,
        target: str = "selection",
        placement: str = "top",
        offset: float = 24.0,
    ) -> str:
        """Draw text relative to a target shape.

        Supported target values:
            - selection (currently selected shape)
            - pointer (shape under latest pointer)
            - this, that (recently referenced shapes)
            - shape:<shape-id> (explicit shape id)

        Args:
            text: Label text to place.
            target: Target reference token.
            placement: One of center, top, bottom, left, right.
            offset: Extra distance from target anchor, in board units.
        """
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_text_on_target",
            "text": text,
            "target": self._target_ref(target),
            "placement": placement,
            "offset": float(offset),
        }
        await self._publish_board_command(command)
        return "target-anchored text drawn"

    @function_tool()
    async def draw_circle(
        self,
        context: RunContext,
        x: float,
        y: float,
        diameter: float,
        label: str = "",
    ) -> str:
        """Draw a circle (implemented as an ellipse with equal width/height).

        Args:
            x: Left position in board space.
            y: Top position in board space.
            diameter: Circle diameter.
            label: Optional text shown inside the circle.
        """
        d = max(diameter, 24.0)
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_geo",
            "geo": "ellipse",
            "x": x,
            "y": y,
            "w": d,
            "h": d,
            "label": label,
        }
        await self._publish_board_command(command)
        return "circle drawn"

    @function_tool()
    async def draw_arrow(
        self,
        context: RunContext,
        x: float,
        y: float,
        to_x: float,
        to_y: float,
    ) -> str:
        """Draw an arrow from one board point to another.

        Args:
            x: Start x in board space.
            y: Start y in board space.
            to_x: End x in board space.
            to_y: End y in board space.
        """
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_arrow",
            "x": x,
            "y": y,
            "toX": to_x,
            "toY": to_y,
        }
        await self._publish_board_command(command)
        return "arrow drawn"

    @function_tool()
    async def draw_arrow_between_targets(
        self,
        context: RunContext,
        from_target: str = "this",
        to_target: str = "that",
        label: str = "",
    ) -> str:
        """Draw an arrow between two target shapes.

        Supported target values:
            - selection
            - pointer
            - this, that
            - shape:<shape-id>

        Args:
            from_target: Source target token.
            to_target: Destination target token.
            label: Optional text near the arrow midpoint.
        """
        command = {
            "v": 1,
            "id": str(uuid4()),
            "op": "create_arrow_between_targets",
            "from": self._target_ref(from_target),
            "to": self._target_ref(to_target),
            "label": label,
        }
        await self._publish_board_command(command)
        return "target-anchored arrow drawn"


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
