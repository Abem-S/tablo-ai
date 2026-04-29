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
from uuid import uuid4

from dotenv import load_dotenv

from livekit.agents import Agent, AgentSession, JobContext, RunContext, WorkerOptions, cli, function_tool, room_io
from livekit.plugins import google
from google.genai import types as genai_types

load_dotenv()

from rag.knowledge_graph import KnowledgeGraph
from rag.ingestion import IngestionPipeline
from rag.retrieval import RetrievalPipeline
from rag.orchestrator import RAGOrchestrator
from learner_memory import load_profile, save_profile, apply_update, format_profile_for_prompt
from skills_loader import build_system_prompt

# The livekit-plugins-google reads GOOGLE_API_KEY from env.
# We alias GEMINI_API_KEY -> GOOGLE_API_KEY so both names work.
if not os.getenv("GOOGLE_API_KEY") and os.getenv("GEMINI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]

logger = logging.getLogger("tablo-agent")


class TabloAgent(Agent):
    def __init__(
        self,
        room,
        learner_id: str,
        learner_profile: dict,
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
        self._learner_profile = learner_profile
        self._retrieval = retrieval
        self._rag_orchestrator = rag_orchestrator
        self._collection_name = collection_name
        self._pending_board_response: asyncio.Future | None = None
        self._learner_context: dict | None = None
        self._session: AgentSession | None = None  # set after session.start()
        self._latest_board_snapshot: str = ""  # latest PNG as base64

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
            self._latest_board_snapshot = image_b64
            logger.debug("Board snapshot stored (%d b64 chars)", len(image_b64))
        except Exception as e:
            logger.warning("Failed to handle board snapshot: %s", e)

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
        try:
            command = json.loads(command_json)
            if "v" not in command:
                command["v"] = 1
            if "id" not in command:
                command["id"] = str(uuid4())
            if command.get("op") == "create_svg" and isinstance(command.get("svg"), str):
                command["svg"] = command["svg"].replace('\\"', "'")

            logger.info("Board command: %s", command.get("op"))
            await self._publish_board_command(command)

            if command.get("op") == "get_board_state":
                self._pending_board_response = asyncio.get_running_loop().create_future()
                try:
                    result = await asyncio.wait_for(self._pending_board_response, timeout=3.0)
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

        Returns a description of what you can see on the board.
        """
        if not self._latest_board_snapshot:
            return "No board snapshot available yet. The board may be empty."

        try:
            from google import genai as _genai
            from google.genai import types as _types
            api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
            client = _genai.Client(api_key=api_key)

            import base64 as _b64
            png_bytes = _b64.b64decode(self._latest_board_snapshot)

            # Use gemini-2.5-flash to describe what's on the board, with fallback
            description = ""
            for model in ["gemini-2.5-flash", "gemini-2.5-flash-lite"]:
                try:
                    response = client.models.generate_content(
                        model=model,
                        contents=[
                            _types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                            "Describe what is written or drawn on this whiteboard. "
                            "Be specific about text content, equations, diagrams, shapes, and their positions. "
                            "If there is handwritten text, transcribe it exactly. "
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
            # Fallback: return that we have a snapshot but couldn't describe it
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
        logger.info("search_documents called with query: %s", query[:100])
        try:
            if self._retrieval is None:
                logger.warning("search_documents: retrieval pipeline is None")
                return "No documents have been uploaded yet."

            # Prepend learner context if they pointed to a specific passage
            if self._learner_context:
                lc = self._learner_context
                query = (
                    f"[Learner is pointing to: \"{lc.get('text', '')[:200]}\" "
                    f"from {lc.get('doc_name', '')} p.{lc.get('page_number', '?')}] {query}"
                )
                self._learner_context = None

            result = await self._retrieval.retrieve(
                query=query,
                turn_id=str(uuid4()),
                top_k=4,
                threshold=0.1,  # low threshold — Qdrant cosine scores differ from ChromaDB
            )

            logger.info("search_documents: retrieved %d chunks, is_general_knowledge=%s",
                        len(result.context.sources), result.context.is_general_knowledge)

            if result.context.is_general_knowledge or not result.context.context_text:
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

            compressed = await self._compress_context(query, result.context)
            logger.info("search_documents returning %d chars", len(compressed))
            return compressed
        except Exception as e:
            logger.error("search_documents failed: %s", e, exc_info=True)
            return f"Document search failed: {e}"

    async def _compress_context(self, query: str, context) -> str:
        """Compress retrieved chunks to ≤500 chars to prevent Gemini Live 1008 disconnects."""
        diagram_hints = ""
        if context.diagram_recipes:
            hints = [f"p.{r.page_number}: {r.description}" for r in context.diagram_recipes]
            diagram_hints = "\nDiagrams available (call draw_diagram): " + "; ".join(hints)

        prompt = (
            f"The learner asked: \"{query}\"\n\n"
            f"Retrieved passages:\n{context.context_text[:2000]}\n\n"
            "Write a concise 3-4 sentence answer covering key facts. "
            "Include document name and page numbers. No bullet points. Return ONLY the answer."
        )

        for model in ["gemini-2.5-flash", "gemini-2.5-flash-lite"]:
            try:
                from google import genai as _genai
                api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
                client = _genai.Client(api_key=api_key)
                response = client.models.generate_content(model=model, contents=prompt)
                summary = (response.text or "").strip()
                if summary:
                    if len(summary) > 500:
                        truncated = summary[:500]
                        last_period = max(truncated.rfind(". "), truncated.rfind(".\n"))
                        summary = truncated[:last_period + 1] if last_period > 200 else truncated
                    return summary + diagram_hints
            except Exception as e:
                logger.warning("Context compression failed with %s: %s — trying next model", model, e)

        # Final fallback: truncate raw text
        return context.context_text[:300] + diagram_hints

    @function_tool()
    async def draw_diagram(self, context: RunContext, page_number: int) -> str:
        """Draw a diagram from the learner's uploaded document onto the board.

        Call this when search_documents mentions a diagram on a specific page.
        The diagram is drawn directly — you do NOT need to call execute_command separately.

        Args:
            page_number: Page number of the diagram (from search_documents result).
        """
        try:
            if self._collection_name is None:
                return "No documents available."

            from rag.vector_store import get_points_by_doc_id, _get_client, collection_name
            client = _get_client()
            col = self._collection_name

            # Search all points for one with matching page_number and a diagram_recipe
            import json as _json
            # Scroll through collection to find diagram for this page
            from qdrant_client.models import Filter, FieldCondition, MatchValue
            results, _ = client.scroll(
                collection_name=col,
                scroll_filter=Filter(must=[FieldCondition(key="page_number", match=MatchValue(value=page_number))]),
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
            api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
            client = _genai.Client(api_key=api_key)
            extractor = DiagramExtractor(client)
            commands = await extractor.generate_commands(description, image_b64=image_b64)

            if not commands:
                return f"Could not generate drawing commands for page {page_number}."

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

            logger.info("Drew diagram from page %d: %d commands", page_number, published)
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
        try:
            import math as _math
            expr = expression.strip().replace("^", "**").replace("pi", str(_math.pi))
            safe_env = {
                "sqrt": _math.sqrt, "sin": _math.sin, "cos": _math.cos,
                "tan": _math.tan, "log": _math.log, "log10": _math.log10,
                "log2": _math.log2, "exp": _math.exp, "abs": abs,
                "floor": _math.floor, "ceil": _math.ceil, "round": round,
                "factorial": _math.factorial, "gcd": _math.gcd,
                "pow": pow, "pi": _math.pi, "e": _math.e,
                "asin": _math.asin, "acos": _math.acos, "atan": _math.atan,
                "atan2": _math.atan2, "sinh": _math.sinh, "cosh": _math.cosh,
                "tanh": _math.tanh, "degrees": _math.degrees, "radians": _math.radians,
            }
            result = eval(expr, {"__builtins__": {}}, safe_env)  # noqa: S307
            return f"Result: {result}"
        except Exception as e:
            return f"Could not evaluate '{expression}': {e}"

    @function_tool()
    async def update_learner_profile(self, context: RunContext, update_json: str) -> str:
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
        try:
            update = json.loads(update_json)
            self._learner_profile = apply_update(self._learner_profile, update)
            save_profile(self._learner_profile)
            logger.info("Updated learner profile for %s: %s", self._learner_id, list(update.keys()))
            return f"Learner profile updated: {list(update.keys())}"
        except json.JSONDecodeError as e:
            return f"Error: Invalid JSON — {e}"
        except Exception as e:
            logger.error("update_learner_profile failed: %s", e)
            return f"Failed to update profile: {e}"


# ─── Entrypoint ───────────────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext):
    logger.info("Connecting to room: %s", ctx.room.name)
    await ctx.connect()
    logger.info("Connected. Starting Gemini Live session...")

    # Derive learner_id from room name (format: tablo-{session_id}-{hex})
    # In production this would come from auth. For now use room name as key.
    learner_id = ctx.room.name.replace("tablo-", "").split("-")[0] or "default"

    # Load learner profile and build dynamic system prompt
    learner_profile = load_profile(learner_id)
    profile_section = format_profile_for_prompt(learner_profile)
    system_prompt = build_system_prompt(learner_profile_section=profile_section)

    logger.info("Loaded profile for learner '%s' — %d mastered, %d struggles",
                learner_id,
                len(learner_profile.get("mastered", [])),
                len(learner_profile.get("struggle_areas", [])))

    # Initialise RAG components
    # Use shared collection so agent and FastAPI both read/write the same data.
    # In production this becomes per-user once auth is added.
    kg = KnowledgeGraph()
    kg.load()
    ingestion = IngestionPipeline(knowledge_graph=kg, user_id=None)  # tablo_shared
    retrieval = RetrievalPipeline(
        knowledge_graph=kg,
        collection=ingestion._collection,
        user_id=None,
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
        retrieval=retrieval,
        rag_orchestrator=None,
        collection_name=ingestion._collection,
    )

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
        asyncio.create_task(
            rag_orchestrator.on_user_turn(
                transcript=transcript,
                board_summary="",
                turn_id=turn_id,
            )
        )

    @session.on("agent_speech_started")
    def on_agent_speech_started():
        logger.debug("Agent started speaking")

    @session.on("error")
    def on_error(err):
        logger.error("Session error: %s", err)

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
            elif topic == "learner.context":
                try:
                    ctx_data = json.loads(bytes(data_packet.data).decode("utf-8"))
                    tablo_agent._learner_context = ctx_data
                    logger.info("Learner context: %s p.%s",
                                ctx_data.get("doc_name", ""), ctx_data.get("page_number", ""))
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
