"""Tablo agent — LiveKit + Gemini Live voice worker.

Run separately from FastAPI:
    python agent.py dev

Architecture:
- Skills are loaded from backend/skills/*.md at startup
- Learner profile is loaded per-session and injected into the system prompt
- The agent can update the learner profile mid-session via update_learner_profile tool
- RAG retrieval runs on the warm path (never blocks voice)
"""

import asyncio
import json
import logging
import os
import time
from contextlib import contextmanager
from dataclasses import dataclass
from uuid import uuid4

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    WorkerOptions,
    cli,
    function_tool,
    room_io,
)
from livekit.plugins import google
from google.genai import types as genai_types

from rag.knowledge_graph import KnowledgeGraph
from rag.ingestion import IngestionPipeline
from rag.retrieval import RetrievalPipeline, compress_context
from rag.orchestrator import RAGOrchestrator
from learner_memory import (
    load_profile,
    save_profile,
    apply_update,
    format_profile_for_prompt,
)
from sessions import add_session_note, get_session
from skills_loader import build_system_prompt
from config import get_env
from math_eval import evaluate_expression, MathEvaluationError
from mcp_tools import bind_agent_tools
from auth import LOCAL_ADMIN_USER_ID
from observability import (
    AGENT_TOOL_CALLS_TOTAL,
    AGENT_TOOL_ERRORS_TOTAL,
    AGENT_TOOL_LATENCY_SECONDS,
    AGENT_UP,
    init_tracing,
    start_metrics_server,
)

load_dotenv()

# The livekit-plugins-google reads GOOGLE_API_KEY from env.
# We alias GEMINI_API_KEY -> GOOGLE_API_KEY so both names work, including secrets files.
google_key = get_env("GOOGLE_API_KEY")
if google_key:
    os.environ["GOOGLE_API_KEY"] = google_key
else:
    gemini_key = get_env("GEMINI_API_KEY")
    if gemini_key:
        os.environ["GOOGLE_API_KEY"] = gemini_key

logger = logging.getLogger("tablo-agent")
tracer = init_tracing("tablo-agent")


@dataclass
class AgentHealthState:
    status: str = "starting"
    room: str | None = None
    last_event: str = ""
    updated_at: float = 0.0

    def update(
        self, status: str, room: str | None = None, event: str | None = None
    ) -> None:
        self.status = status
        if room is not None:
            self.room = room
        if event is not None:
            self.last_event = event
        self.updated_at = time.time()

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "room": self.room or "",
            "last_event": self.last_event,
            "updated_at": self.updated_at,
        }


_agent_health = AgentHealthState()
AGENT_UP.set(0)


@contextmanager
def _observe_tool(tool_name: str):
    AGENT_TOOL_CALLS_TOTAL.labels(tool=tool_name).inc()
    start = time.monotonic()
    with tracer.start_as_current_span(f"tool.{tool_name}") as span:
        try:
            yield span
        except Exception as e:
            AGENT_TOOL_ERRORS_TOTAL.labels(tool=tool_name).inc()
            try:
                span.record_exception(e)
            except Exception:
                pass
            raise
        finally:
            duration = time.monotonic() - start
            AGENT_TOOL_LATENCY_SECONDS.labels(tool=tool_name).observe(duration)


class TabloAgent(Agent):
    def __init__(
        self,
        room,
        learner_id: str,
        learner_profile: dict,
        session_id: str = "",
        retrieval=None,
        rag_orchestrator=None,
        collection_name: str | None = None,
    ):
        # Build dynamic system prompt from skills + learner profile
        profile_section = format_profile_for_prompt(learner_profile)
        system_prompt = build_system_prompt(learner_profile_section=profile_section)

        super().__init__(instructions=system_prompt)

        self._room = room
        self._learner_id = learner_id
        self._session_id = session_id
        self._session_doc_ids: list[str] = []  # scopes RAG to session documents
        self._learner_profile = learner_profile
        self._retrieval = retrieval
        self._rag_orchestrator = rag_orchestrator
        self._collection_name = collection_name
        self._pending_board_response: asyncio.Future | None = None
        self._learner_context: dict | None = None
        self._session: AgentSession | None = None  # set after session.start()
        self._latest_board_snapshot: str = ""  # latest PNG as base64
        self._latest_board_description: str = (
            ""  # proactive description of latest snapshot
        )

        # Board context accumulated from board.delta / board.selection / board.cursor
        # These give the agent a live picture of what's on the board without
        # needing to call get_board_state every turn.
        self._board_delta_summary: str = ""  # latest board.delta payload
        self._board_selection: list[str] = []  # currently selected shape IDs
        self._board_cursor: dict | None = None  # latest cursor position {x, y}

    async def _publish_board_command(self, command: dict) -> None:
        payload = json.dumps(command).encode("utf-8")
        await self._room.local_participant.publish_data(
            payload,
            reliable=True,
            topic="board.command",
        )

    def _on_board_response(self, data: bytes, *args, **kwargs) -> None:
        if self._pending_board_response and not self._pending_board_response.done():
            try:
                self._pending_board_response.set_result(data.decode("utf-8"))
            except Exception:
                pass

    async def _handle_board_snapshot(self, data: bytes) -> None:
        """Receive a board.snapshot and store it for use when the agent calls get_board_image.

        Does NOT inject into chat context automatically — that caused 1008 disconnects.
        The agent calls get_board_image explicitly when it needs to see the board.
        """
        try:
            payload = json.loads(data.decode("utf-8"))
            image_b64 = payload.get("image_b64", "")
            if not image_b64:
                return
            prev_snapshot = self._latest_board_snapshot
            self._latest_board_snapshot = image_b64
            logger.debug("Board snapshot stored (%d b64 chars)", len(image_b64))

            # If the snapshot changed significantly and the session is active,
            # proactively describe it so the agent is aware of freehand content
            # without needing to be explicitly asked.
            # We only do this when the snapshot is new (not the initial empty board).
            if (
                prev_snapshot
                and image_b64 != prev_snapshot
                and self._session is not None
            ):
                asyncio.create_task(self._proactive_board_awareness())
        except Exception as e:
            logger.warning("Failed to handle board snapshot: %s", e)

    async def _proactive_board_awareness(self) -> None:
        """Silently describe the board snapshot and store the description.

        This runs in the background after a snapshot update. It does NOT
        inject into the live session context (that causes 1008 disconnects).
        Instead it updates _latest_board_description so the agent can
        reference it when the learner speaks next.
        """
        try:
            if not self._latest_board_snapshot:
                return
            from google import genai as _genai
            from google.genai import types as _types
            import base64 as _b64

            api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
            if not api_key:
                return
            client = _genai.Client(api_key=api_key)
            png_bytes = _b64.b64decode(self._latest_board_snapshot)
            for model in ["gemini-2.5-flash", "gemini-2.5-flash-lite"]:
                try:
                    response = client.models.generate_content(
                        model=model,
                        contents=[
                            _types.Part.from_bytes(
                                data=png_bytes, mime_type="image/png"
                            ),
                            "Describe what is written or drawn on this whiteboard. "
                            "Be specific about text content, equations, diagrams, shapes, and their positions. "
                            "If there is handwritten text or freehand drawing, transcribe/describe it exactly. "
                            "Keep the description concise (2-3 sentences max).",
                        ],
                    )
                    description = (response.text or "").strip()
                    if description:
                        self._latest_board_description = description
                        logger.debug(
                            "Proactive board description: %s", description[:80]
                        )
                        return
                except Exception as e:
                    logger.debug(
                        "Proactive board description failed with %s: %s", model, e
                    )
        except Exception as e:
            logger.debug("_proactive_board_awareness failed: %s", e)

    def _handle_board_delta(self, data: bytes) -> None:
        """Receive a board.delta and update the board summary.

        board.delta is published by the frontend whenever shapes are added,
        moved, or deleted. It carries a compact JSON summary of the change
        so the agent always has an up-to-date picture of the board state
        without polling get_board_state.

        Payload schema:
          { "op": "add"|"update"|"delete",
            "shapes": [{ "id": str, "type": str, "label": str,
                         "x": int, "y": int, "w": int, "h": int }],
            "shapeCount": int }
        """
        try:
            payload = json.loads(data.decode("utf-8"))
            op = payload.get("op", "")
            shape_count = payload.get("shapeCount", 0)
            shapes = payload.get("shapes", [])
            # Build a compact summary string the agent can reference
            if shapes:
                shape_desc = ", ".join(
                    f"{s.get('type', '?')}({s.get('label', '')[:20]})"
                    for s in shapes[:5]
                )
                self._board_delta_summary = (
                    f"[board.delta op={op} shapes={shape_count} changed={shape_desc}]"
                )
            else:
                self._board_delta_summary = (
                    f"[board.delta op={op} shapes={shape_count}]"
                )
            logger.debug("Board delta: %s", self._board_delta_summary)
        except Exception as e:
            logger.warning("Failed to handle board.delta: %s", e)

    def _handle_board_selection(self, data: bytes) -> None:
        """Receive a board.selection and update the selected shape IDs.

        board.selection is published whenever the user selects or deselects
        shapes. The agent can use this to understand what the learner is
        pointing at without needing to call get_board_state.

        Payload schema:
          { "selectedIds": [str, ...], "count": int }
        """
        try:
            payload = json.loads(data.decode("utf-8"))
            self._board_selection = payload.get("selectedIds", [])
            logger.debug(
                "Board selection: %d shapes selected", len(self._board_selection)
            )
        except Exception as e:
            logger.warning("Failed to handle board.selection: %s", e)

    def _handle_board_cursor(self, data: bytes) -> None:
        """Receive a board.cursor and update the cursor position.

        board.cursor is published on pointer move (throttled to ~10Hz).
        The agent can use this to understand where the learner is pointing.

        Payload schema:
          { "x": float, "y": float }
        """
        try:
            payload = json.loads(data.decode("utf-8"))
            x = payload.get("x")
            y = payload.get("y")
            if x is not None and y is not None:
                self._board_cursor = {"x": x, "y": y}
        except Exception as e:
            logger.warning("Failed to handle board.cursor: %s", e)

    def get_board_context_summary(self) -> str:
        """Return a compact summary of current board context for the RAG orchestrator."""
        parts = []
        if self._board_delta_summary:
            parts.append(self._board_delta_summary)
        if self._board_selection:
            parts.append(f"selected={len(self._board_selection)} shapes")
        if self._board_cursor:
            parts.append(
                f"cursor=({self._board_cursor['x']:.0f},{self._board_cursor['y']:.0f})"
            )
        return " ".join(parts) if parts else ""

    # ─── Tools ────────────────────────────────────────────────────────────────

    @function_tool()
    async def execute_command(self, context: RunContext, command_json: str) -> str:
        """Execute any board drawing command.

        Send a JSON command string to the tldraw board.
        Always call get_board_state first to see what's there.

        Common commands:
          {"op":"get_board_state"}
          {"op":"create_text","text":"a² + b² = c²","x":100,"y":100}
          {"op":"create_geo","geo":"rectangle","x":100,"y":100,"w":120,"h":80,"label":"Router"}
          {"op":"create_graph","expressions":[{"expr":"sin(x)","label":"sin(x)"}],"x":50,"y":50}
          {"op":"create_svg","svg":"<svg viewBox='0 0 100 100'>...</svg>","x":100,"y":100,"w":150,"h":150}
          {"op":"create_arrow","x":100,"y":100,"toX":300,"toY":100}
          {"op":"update_shape","shapeId":"shape:abc","label":"new label"}
          {"op":"delete_shape","shapeId":"shape:abc"}
          {"op":"undo"}
          {"op":"clear_board"}

        See drawing_commands skill for full reference.
        """
        with _observe_tool("execute_command"):
            try:
                command = json.loads(command_json)
                if "v" not in command:
                    command["v"] = 1
                if "id" not in command:
                    command["id"] = str(uuid4())
                if command.get("op") == "create_svg" and isinstance(
                    command.get("svg"), str
                ):
                    command["svg"] = command["svg"].replace('"', "'")

                logger.info("Board command: %s", command.get("op"))
                await self._publish_board_command(command)

                if command.get("op") == "get_board_state":
                    self._pending_board_response = (
                        asyncio.get_running_loop().create_future()
                    )
                    try:
                        result = await asyncio.wait_for(
                            self._pending_board_response, timeout=3.0
                        )
                        self._pending_board_response = None
                        return f"board state: {result}"
                    except asyncio.TimeoutError:
                        self._pending_board_response = None
                        return "board state: timeout — board may be empty"

                return f"command executed: {command.get('op', 'unknown')}"
            except json.JSONDecodeError as e:
                return f"Error: Invalid JSON — {e}"

    @function_tool()
    async def get_board_image(self, context: RunContext) -> str:
        """Get a visual snapshot of the current whiteboard as an image.

        Call this when you need to SEE what is currently on the board — including
        freehand writing, student drawings, handwritten equations, or anything
        the student has drawn that you need to understand visually.

        Use this:
        - When the student says "look at what I wrote" or "does this look right?"
        - When you need to read handwritten text or equations on the board
        - When you want to check the student's work visually
        - When you're about to explain something and want to see the current board state
        - ALWAYS call this before commenting on anything the student drew freehand

        Returns a description of what you can see on the board.
        """
        with _observe_tool("get_board_image"):
            if not self._latest_board_snapshot:
                return "No board snapshot available yet. The board may be empty."

            # Fast path: return the proactive description if it's fresh
            # (computed in the background after each snapshot update)
            if self._latest_board_description:
                desc = self._latest_board_description
                self._latest_board_description = (
                    ""  # consume it — next call gets a fresh one
                )
                logger.info("get_board_image (cached): %s", desc[:80])
                return f"Current board shows: {desc}"

            # Slow path: call Gemini vision directly
            try:
                from google import genai as _genai
                from google.genai import types as _types

                api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
                if not api_key:
                    return "Board snapshot available but Gemini API is not configured."
                client = _genai.Client(api_key=api_key)

                import base64 as _b64

                png_bytes = _b64.b64decode(self._latest_board_snapshot)

                description = ""
                for model in ["gemini-2.5-flash", "gemini-2.5-flash-lite"]:
                    try:
                        response = client.models.generate_content(
                            model=model,
                            contents=[
                                _types.Part.from_bytes(
                                    data=png_bytes, mime_type="image/png"
                                ),
                                "Describe what is written or drawn on this whiteboard. "
                                "Be specific about text content, equations, diagrams, shapes, and their positions. "
                                "If there is handwritten text or freehand drawing, transcribe/describe it exactly. "
                                "Keep the description concise (2-3 sentences max).",
                            ],
                        )
                        description = (response.text or "").strip()
                        if description:
                            break
                    except Exception as e:
                        logger.warning("get_board_image failed with %s: %s", model, e)
                if not description:
                    return "Board appears to be empty or content is unclear."
                logger.info("Board image described: %s", description[:100])
                return f"Current board shows: {description}"
            except Exception as e:
                logger.warning("get_board_image failed: %s", e)
                return f"Board snapshot available ({len(self._latest_board_snapshot)} chars) but description failed: {e}"

    @function_tool()
    async def search_documents(self, context: RunContext, query: str) -> str:
        """CALL THIS FIRST — mandatory before answering any subject-matter question.

        DO NOT answer questions about topics, concepts, definitions, or subjects
        without calling this tool first. This is not optional.

        When to call: ANY time the learner asks about a topic, concept, or subject.
        Examples: "what is X", "explain Y", "how does Z work", "solve this problem",
        "what are the layers of...", "define...", "show me how to..."

        Args:
            query: Concise keyword-rich search query describing what to look for.
                   Examples: "OSI model layers", "TCP handshake", "Pythagorean theorem"

        Returns:
            Relevant content from the learner's uploaded documents, including page
            numbers and any diagrams available to draw.
        """
        with _observe_tool("search_documents"):
            logger.info("search_documents called with query: %s", query[:100])
            try:
                if self._retrieval is None:
                    logger.warning("search_documents: retrieval pipeline is None")
                    return "No documents have been uploaded yet."

                # Prepend learner context if they pointed to a specific passage
                if self._learner_context:
                    lc = self._learner_context
                    query = (
                        f'[Learner is pointing to: "{lc.get("text", "")[:200]}" '
                        f"from {lc.get('doc_name', '')} p.{lc.get('page_number', '?')}] {query}"
                    )
                    self._learner_context = None

                # Refresh doc_ids from disk — picks up documents uploaded mid-session
                if self._session_id:
                    fresh = get_session(self._session_id)
                    if fresh:
                        self._session_doc_ids = fresh.get("doc_ids", [])

                if not self._session_doc_ids:
                    return "No documents have been uploaded to this session yet. Rely on your general knowledge."

                result = await self._retrieval.retrieve(
                    query=query,
                    turn_id=str(uuid4()),
                    top_k=4,
                    threshold=0.1,
                    allowed_doc_ids=self._session_doc_ids,
                )
                logger.info(
                    "search_documents: retrieved %d chunks, is_general_knowledge=%s",
                    len(result.context.sources),
                    result.context.is_general_knowledge,
                )

                if (
                    result.context.is_general_knowledge
                    or not result.context.context_text
                ):
                    return "No relevant passages found in uploaded documents for this query."

                # Publish sources to frontend so viewer navigates to the right page
                if self._rag_orchestrator is not None:
                    asyncio.create_task(
                        self._rag_orchestrator.publish_sources(
                            result.context.sources,
                            turn_id=str(uuid4()),
                            is_general_knowledge=False,
                        )
                    )

                compressed = await compress_context(query, result.context)
                logger.info("search_documents returning %d chars", len(compressed))
                return compressed
            except Exception as e:
                logger.error("search_documents failed: %s", e, exc_info=True)
                return f"Document search failed: {e}"

    # _compress_context moved to rag.retrieval.compress_context

    @function_tool()
    async def draw_diagram(self, context: RunContext, page_number: int) -> str:
        """Draw a diagram from the learner's uploaded document onto the board.

        Call this when search_documents mentions a diagram on a specific page.
        The diagram is drawn directly — you do NOT need to call execute_command separately.

        Args:
            page_number: Page number of the diagram (from search_documents result).
        """
        with _observe_tool("draw_diagram"):
            try:
                if self._collection_name is None:
                    return "No documents available."

                from rag.vector_store import _get_client

                client = _get_client()
                col = self._collection_name

                # Search all points for one with matching page_number and a diagram_recipe
                import json as _json

                # Scroll through collection to find diagram for this page
                from qdrant_client.models import Filter, FieldCondition, MatchValue

                results, _ = client.scroll(
                    collection_name=col,
                    scroll_filter=Filter(
                        must=[
                            FieldCondition(
                                key="page_number", match=MatchValue(value=page_number)
                            )
                        ]
                    ),
                    limit=10,
                    with_payload=True,
                    with_vectors=False,
                )
                recipe_raw = ""
                for pt in results:
                    r = pt.payload.get("diagram_recipe", "")
                    if r:
                        recipe_raw = r
                        break

                if not recipe_raw:
                    return f"No diagram found for page {page_number}."

                recipe_data = _json.loads(recipe_raw)
                description = recipe_data.get("description", "")
                image_b64 = recipe_data.get("image_b64", "")
                if not description and not image_b64:
                    return f"Diagram data missing for page {page_number}."

                from rag.diagram_extractor import DiagramExtractor
                from google import genai as _genai

                api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
                if not api_key:
                    return "Gemini API is not configured for diagram generation."
                client = _genai.Client(api_key=api_key)
                extractor = DiagramExtractor(client)
                commands = await extractor.generate_commands(
                    description, image_b64=image_b64
                )

                if not commands:
                    return (
                        f"Could not generate drawing commands for page {page_number}."
                    )

                published = 0
                for cmd in commands:
                    try:
                        if "v" not in cmd:
                            cmd["v"] = 1
                        if "id" not in cmd:
                            cmd["id"] = str(uuid4())
                        await self._publish_board_command(cmd)
                        published += 1
                        await asyncio.sleep(0.05)
                    except Exception as e:
                        logger.warning("Failed to publish diagram command: %s", e)

                logger.info(
                    "Drew diagram from page %d: %d commands", page_number, published
                )
                return f"Drew diagram from page {page_number} ({published} shapes)."
            except Exception as e:
                logger.error("draw_diagram failed for page %d: %s", page_number, e)
                return f"Failed to draw diagram: {e}"

    @function_tool()
    async def calculate(self, context: RunContext, expression: str) -> str:
        """Evaluate a mathematical expression accurately.

        Use for ANY arithmetic, algebra, or math computation. Never guess math.

        Args:
            expression: Math expression. Examples: "347 * 28", "sqrt(144)", "sin(pi/6)", "2^10"
        """
        with _observe_tool("calculate"):
            try:
                result = evaluate_expression(expression)
                return f"Result: {result}"
            except MathEvaluationError as e:
                return f"Could not evaluate '{expression}': {e}"

    @function_tool()
    async def update_learner_profile(
        self, context: RunContext, update_json: str
    ) -> str:
        """Update the learner's persistent profile based on what you've observed this session.

        Call this when you observe something meaningful about how this learner learns.
        The profile persists across sessions — use it to adapt your teaching style over time.

        Args:
            update_json: JSON string with any of these fields:
              {
                "learning_styles": {"math": "needs visual diagram before formula"},
                "struggle_areas": ["TCP handshake", "subnetting"],
                "remove_struggle": ["binary arithmetic"],
                "mastered": ["OSI model layers"],
                "hints_that_worked": {"subnetting": "pizza slice analogy"},
                "preferred_pace": "slow",
                "last_session_summary": "Working through network layer, got stuck on routing tables",
                "session_history_entry": {
                  "topic": "IP addressing",
                  "understood": true,
                  "notes": "needed the postal address analogy"
                }
              }

        Only include fields you actually observed — don't fill in guesses.
        Call this at natural breakpoints: when a topic is mastered, when a struggle is identified,
        or at the end of a session to write the summary.
        """
        with _observe_tool("update_learner_profile"):
            try:
                update = json.loads(update_json)
                self._learner_profile = apply_update(self._learner_profile, update)
                save_profile(self._learner_profile)
                logger.info(
                    "Updated learner profile for %s: %s",
                    self._learner_id,
                    list(update.keys()),
                )
                return f"Learner profile updated: {list(update.keys())}"
            except json.JSONDecodeError as e:
                return f"Error: Invalid JSON — {e}"
            except Exception as e:
                logger.error("update_learner_profile failed: %s", e)
                return f"Failed to update profile: {e}"

    @function_tool()
    async def save_session_note(self, context: RunContext, note: str) -> str:
        """Save a brief note about this session for future reference.

        Call this to record key moments so the learner can review what was covered.
        Good times to call this:
        - When a topic is fully explained ("Covered: Pythagorean theorem — visual proof + formula")
        - When the learner has a breakthrough ("Learner got it after the pizza analogy for subnetting")
        - When stopping a topic ("Stopped at: TCP 3-way handshake step 2 — resuming next session")
        - At the end of a session ("Session summary: covered X, Y, Z")

        Keep notes short — 1-2 sentences. Don't call this every turn.

        Args:
            note: Brief note to save (1-2 sentences max).
        """
        with _observe_tool("save_session_note"):
            try:
                if not self._session_id:
                    return "No session ID available — note not saved."
                add_session_note(self._session_id, note)
                logger.info(
                    "Session note saved for %s: %s", self._session_id, note[:80]
                )
                return f"Note saved: {note[:80]}"
            except Exception as e:
                logger.error("save_session_note failed: %s", e)
                return f"Failed to save note: {e}"


# ─── Entrypoint ───────────────────────────────────────────────────────────────


async def entrypoint(ctx: JobContext):
    _agent_health.update("starting", room=ctx.room.name, event="job_received")
    metrics_enabled = os.getenv("AGENT_METRICS_ENABLED", "true").lower() == "true"
    if metrics_enabled:
        port = int(os.getenv("AGENT_METRICS_PORT", "9091"))
        start_metrics_server(port, health_fn=_agent_health.as_dict)

    logger.info("Connecting to room: %s", ctx.room.name)
    await ctx.connect()
    _agent_health.update("connected", event="room_connected")
    AGENT_UP.set(1)
    logger.info("Connected. Starting Gemini Live session...")

    # Derive learner_id and session_id from room name
    # Room name format: tablo-{session_id}-{6char_hex}
    room = ctx.room.name
    raw = room[len("tablo-") :] if room.startswith("tablo-") else room
    parts = raw.rsplit("-", 1)
    session_id = parts[0] if (len(parts) == 2 and len(parts[1]) == 6) else raw
    # learner_id: keep existing derivation for profile compatibility
    learner_id = raw.split("-")[0] or "default"

    # Load learner profile and build dynamic system prompt
    learner_profile = load_profile(learner_id)
    profile_section = format_profile_for_prompt(learner_profile)
    system_prompt = build_system_prompt(learner_profile_section=profile_section)

    logger.info(
        "Loaded profile for learner '%s' — %d mastered, %d struggles",
        learner_id,
        len(learner_profile.get("mastered", [])),
        len(learner_profile.get("struggle_areas", [])),
    )

    # Initialise RAG components
    # Use LOCAL_ADMIN_USER_ID so the agent reads/writes the same per-user
    # Qdrant collection as the FastAPI document endpoints.
    # In a SaaS fork, replace this with the authenticated user's ID.
    kg = KnowledgeGraph()
    kg.load()
    ingestion = IngestionPipeline(knowledge_graph=kg, user_id=LOCAL_ADMIN_USER_ID)
    retrieval = RetrievalPipeline(
        knowledge_graph=kg,
        collection=ingestion._collection,
        user_id=LOCAL_ADMIN_USER_ID,
    )

    model = google.beta.realtime.RealtimeModel(
        model="gemini-2.5-flash-native-audio-preview-12-2025",
        voice="Aoede",
        proactivity=True,
        enable_affective_dialog=True,
        context_window_compression=genai_types.ContextWindowCompressionConfig(
            trigger_tokens=25000,
            sliding_window=genai_types.SlidingWindow(target_tokens=12000),
        ),
        instructions=(
            "You are Tablo, a Socratic AI teacher on a collaborative whiteboard. "
            "You MUST call search_documents before answering ANY subject-matter question — "
            "always check the learner's uploaded materials first. "
            "Draw on the board while speaking using execute_command. "
            "Use calculate for all math. Keep voice responses short and Socratic."
        ),
        temperature=0.8,
    )

    session = AgentSession(llm=model)

    tablo_agent = TabloAgent(
        room=ctx.room,
        learner_id=learner_id,
        learner_profile=learner_profile,
        session_id=session_id,
        retrieval=retrieval,
        rag_orchestrator=None,
        collection_name=ingestion._collection,
    )

    # Scope RAG to this session's documents
    session_data = get_session(session_id)
    if session_data:
        tablo_agent._session_doc_ids = session_data.get("doc_ids", [])
        logger.info(
            "Session %s has %d documents for RAG scoping",
            session_id,
            len(tablo_agent._session_doc_ids),
        )
    else:
        logger.warning("Could not load session %s for doc scoping", session_id)

    # Bind the agent's tools to the MCP registry so external MCP clients
    # and LangGraph sub-agents can call them without importing TabloAgent.
    bind_agent_tools(tablo_agent)

    rag_orchestrator = RAGOrchestrator(
        retrieval_pipeline=retrieval,
        tablo_agent=tablo_agent,
        room=ctx.room,
    )
    rag_orchestrator.set_base_instructions(system_prompt)
    tablo_agent._rag_orchestrator = rag_orchestrator

    await session.start(
        agent=tablo_agent,
        room=ctx.room,
        room_options=room_io.RoomOptions(video_input=False),
    )

    # Give the agent a reference to the session so it can forward board snapshots
    tablo_agent._session = session

    logger.info("Agent session started in room: %s", ctx.room.name)

    await session.generate_reply(
        instructions=(
            "Greet the learner briefly in voice only — do NOT write anything on the board yet. "
            "If you know them from a previous session (check the learner profile), acknowledge it naturally. "
            "Just say something like 'Hey! What would you like to work on today?' or "
            "'Welcome back! Ready to continue?' if you have session history."
        )
    )

    @session.on("user_speech_committed")
    def on_user_speech_committed(msg):
        transcript = getattr(msg, "text", "") or str(msg)
        turn_id = str(uuid4())
        # Include live board context (delta + selection + cursor) in the warm-path query
        board_summary = tablo_agent.get_board_context_summary()
        asyncio.create_task(
            rag_orchestrator.on_user_turn(
                transcript=transcript,
                board_summary=board_summary,
                turn_id=turn_id,
            )
        )

    @session.on("agent_speech_started")
    def on_agent_speech_started():
        logger.debug("Agent started speaking")
        _agent_health.update("speaking", event="agent_speech_started")

    @session.on("error")
    def on_error(err):
        logger.error("Session error: %s", err)
        _agent_health.update("error", event="session_error")
        AGENT_UP.set(0)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        logger.info("Track subscribed: %s from %s", track.sid, participant.identity)

    @ctx.room.on("data_received")
    def on_data_received(data_packet):
        try:
            topic = getattr(data_packet, "topic", None)
            if topic == "board.response":
                tablo_agent._on_board_response(bytes(data_packet.data))
            elif topic == "board.snapshot":
                # Forward board snapshot to Gemini Live as inline image
                asyncio.create_task(
                    tablo_agent._handle_board_snapshot(bytes(data_packet.data))
                )
            elif topic == "board.delta":
                # Incremental board change — update agent's board context summary
                tablo_agent._handle_board_delta(bytes(data_packet.data))
            elif topic == "board.selection":
                # Shape selection changed — update agent's selection state
                tablo_agent._handle_board_selection(bytes(data_packet.data))
            elif topic == "board.cursor":
                # Cursor moved — update agent's cursor position (high-frequency, sync)
                tablo_agent._handle_board_cursor(bytes(data_packet.data))
            elif topic == "learner.context":
                try:
                    ctx_data = json.loads(bytes(data_packet.data).decode("utf-8"))
                    tablo_agent._learner_context = ctx_data
                    logger.info(
                        "Learner context: %s p.%s",
                        ctx_data.get("doc_name", ""),
                        ctx_data.get("page_number", ""),
                    )
                except Exception as e:
                    logger.warning("Failed to parse learner.context: %s", e)
            elif topic == "tutor.sources":
                logger.debug("tutor.sources echo (no-op)")
        except Exception as e:
            logger.warning("data_received error: %s", e)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="tablo-assistant",
        )
    )
