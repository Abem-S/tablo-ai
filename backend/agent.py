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

# The livekit-plugins-google reads GOOGLE_API_KEY from env.
# We alias GEMINI_API_KEY -> GOOGLE_API_KEY so both names work.
if not os.getenv("GOOGLE_API_KEY") and os.getenv("GEMINI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]

logger = logging.getLogger("tablo-agent")


class TabloAgent(Agent):
    def __init__(self, room, retrieval=None, rag_orchestrator=None, chroma_collection=None):
        super().__init__(
            instructions=(
                "You are Tablo, a voice-first AI teacher on a collaborative whiteboard. "
                "You teach by drawing on the board while speaking — like a real teacher at a blackboard.\n\n"

                "DOCUMENT-GROUNDED TEACHING:\n"
                "The learner may upload study materials (textbooks, lecture notes, PDFs). "
                "When they ask about any subject-matter topic, ALWAYS call search_documents first "
                "to check if their materials cover it. If relevant passages are found, base your "
                "explanation on those passages and tell the learner you're referencing their materials. "
                "Only fall back to general knowledge if search_documents returns nothing relevant.\n"
                "If search_documents mentions a diagram on a page, call draw_diagram with that page number "
                "to draw it on the board while explaining.\n\n"

                "CORE TEACHING BEHAVIOR:\n"
                "1. When working through a problem, ALWAYS write each step on the board using execute_command. Say it AND write it.\n"
                "2. Draw diagrams for visual topics. Write equations/steps for math topics.\n"
                "3. Do NOT write greetings or filler on the board. Only math, steps, diagrams, labels.\n"
                "4. Be Socratic: do ONE step at a time, write it, then ask the learner what comes next.\n"
                "5. If the learner goes SILENT, proactively ask a follow-up question.\n"
                "6. CRITICAL — ACTIONS REQUIRE TOOL CALLS:\n"
                "   - Saying 'I deleted it' does NOT delete it. You MUST call execute_command with delete_shape.\n"
                "   - Saying 'I drew it' does NOT draw it. You MUST call execute_command.\n"
                "   - Saying 'I moved it' does NOT move it. You MUST call execute_command with update_shape.\n"
                "   - If you want to fix a label position: call get_board_state to get the shape ID, then call delete_shape, then create a new one.\n"
                "   - NEVER claim you performed an action without actually calling the tool.\n"
                "7. After placing labels, call get_board_state to verify. If wrong, call delete_shape then redraw.\n"
                "8. For ANY math calculation, use the calculate tool. Never guess.\n\n"

                "DRAWING COMMANDS:\n"
                "- Math graphs y=f(x): use create_graph — frontend computes accurately\n"
                "  Example: {\"op\":\"create_graph\",\"expressions\":[{\"expr\":\"tan(x)\",\"label\":\"tan(x)\"},{\"expr\":\"1/tan(x)\",\"label\":\"cot(x)\"}],\"x\":50,\"y\":50,\"xMin\":-6.28,\"xMax\":6.28,\"yMin\":-5,\"yMax\":5}\n"
                "- Parametric curves (unit circle, spirals, Lissajous): use create_parametric_graph\n"
                "  Example: {\"op\":\"create_parametric_graph\",\"exprX\":\"cos(t)\",\"exprY\":\"sin(t)\",\"tMin\":0,\"tMax\":6.28,\"label\":\"unit circle\"}\n"
                "- Regular polygons (pentagon, hexagon, star): use create_polygon\n"
                "  Example: {\"op\":\"create_polygon\",\"sides\":6,\"x\":200,\"y\":200,\"radius\":80}\n"
                "- Static shapes (cube, cylinder, diagram): use create_svg\n"
                "- Text/labels: use create_text\n"
                "- Point to something: use create_arrow\n"
                "- Add label to existing shape: use update_shape with shapeId and label\n"
                "- Move/resize existing shape: use update_shape with shapeId and x/y/w/h\n"
                "- Remove a shape: use delete_shape with shapeId\n"
                "- Undo last action: {\"op\":\"undo\"}\n"
                "- Math calculations: use calculate tool — never guess arithmetic\n\n"
                "SVG RULES (critical — always follow these):\n"
                "- Always use fill='none' and stroke='black' stroke-width='2' for outlines\n"
                "- Always wrap content in <svg viewBox='x y w h'> where viewBox matches your coordinates\n"
                "- For <rect> ALWAYS include x, y, width, AND height attributes\n"
                "- Circle example: {\"op\":\"create_svg\",\"svg\":\"<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='none' stroke='black' stroke-width='2'/></svg>\",\"x\":100,\"y\":100,\"w\":150,\"h\":150}\n"
                "- Rectangle example: {\"op\":\"create_svg\",\"svg\":\"<svg viewBox='0 0 100 60'><rect x='5' y='5' width='90' height='50' fill='none' stroke='black' stroke-width='2'/></svg>\",\"x\":100,\"y\":100,\"w\":200,\"h\":120}\n"
                "- Square example: {\"op\":\"create_svg\",\"svg\":\"<svg viewBox='0 0 100 100'><rect x='5' y='5' width='90' height='90' fill='none' stroke='black' stroke-width='2'/></svg>\",\"x\":100,\"y\":100,\"w\":150,\"h\":150}\n"
                "- Triangle example: {\"op\":\"create_svg\",\"svg\":\"<svg viewBox='0 0 100 100'><polygon points='50,5 95,95 5,95' fill='none' stroke='black' stroke-width='2'/></svg>\",\"x\":100,\"y\":100,\"w\":150,\"h\":150}\n"
                "- Right-angle triangle: {\"op\":\"create_svg\",\"svg\":\"<svg viewBox='0 0 100 100'><polygon points='5,95 95,95 5,5' fill='none' stroke='black' stroke-width='2'/><rect x='5' y='85' width='10' height='10' fill='none' stroke='black' stroke-width='1.5'/></svg>\",\"x\":100,\"y\":100,\"w\":150,\"h\":150}\n"
                "- 3D Cube: {\"op\":\"create_svg\",\"svg\":\"<svg viewBox='0 0 120 100'><polygon points='60,10 100,30 100,70 60,90 20,70 20,30' fill='none' stroke='black' stroke-width='2'/><line x1='60' y1='10' x2='60' y2='50' stroke='black' stroke-width='2'/><line x1='20' y1='30' x2='60' y2='50' stroke='black' stroke-width='2'/><line x1='100' y1='30' x2='60' y2='50' stroke='black' stroke-width='2'/></svg>\",\"x\":100,\"y\":100,\"w\":180,\"h\":150}\n\n"

                "TEACHER WORKFLOW EXAMPLE:\n"
                "Learner: 'Explain the Pythagorean theorem'\n"
                "1. get_board_state → see what's there, find empty space\n"
                "2. create_svg → draw a right-angle triangle with sides labeled a, b, c\n"
                "3. create_text → write 'a² + b² = c²' below the triangle\n"
                "4. Ask: 'Can you tell me which side is the hypotenuse?'\n"
                "5. When learner answers, create_arrow → point to the correct side\n\n"

                "SOCRATIC APPROACH:\n"
                "- NEVER give the full answer. Do one step, ask the learner.\n"
                "- If the learner answers correctly, write the step and ask about the next.\n"
                "- If wrong, give a hint and let them try again.\n"
                "- If the learner is SILENT, don't wait — ask them a question to keep going.\n"
                "- After placing labels on a shape, verify with get_board_state and fix if wrong.\n\n"

                "Keep voice responses short. Draw while speaking, don't wait until after."
            )
        )
        self._room = room
        self._retrieval = retrieval
        self._rag_orchestrator = rag_orchestrator
        self._chroma_collection = chroma_collection
        self._pending_board_response = None  # type: asyncio.Future | None
        self._learner_context = None  # type: dict | None — {text, doc_name, page_number}

    async def _publish_board_command(self, command: dict) -> None:
        payload = json.dumps(command).encode("utf-8")
        await self._room.local_participant.publish_data(
            payload,
            reliable=True,
            topic="board.command",
        )

    def _on_board_response(self, data: bytes, *args, **kwargs) -> None:
        """Called when the frontend publishes board state back."""
        if self._pending_board_response and not self._pending_board_response.done():
            try:
                self._pending_board_response.set_result(data.decode("utf-8"))
            except Exception:
                pass

    @function_tool()
    async def execute_command(
        self,
        context: RunContext,
        command_json: str,
    ) -> str:
        """Execute any board command directly. Send a JSON command to the board.

        Args:
            command_json: Complete JSON command object as a string.

        STEP 1 - Always check the board first:
            {"op":"get_board_state"} → returns all shape IDs, positions, types, labels

        STEP 2 - Draw in empty space, update existing shapes, point to things:

        MATH GRAPHS (frontend computes accurately — never guess coordinates):
            {"op":"create_graph","expressions":[{"expr":"sin(x)","label":"sin(x)"},{"expr":"cos(x)","label":"cos(x)"}],"x":50,"y":50,"w":400,"h":300,"xMin":-6.28,"xMax":6.28}
            {"op":"create_graph","expressions":[{"expr":"tan(x)"},{"expr":"1/tan(x)"}],"x":50,"y":50,"yMin":-5,"yMax":5}
            {"op":"create_graph","expressions":[{"expr":"x^2 - 4"}],"x":50,"y":50,"xMin":-4,"xMax":4}
            Expression syntax: sin(x), cos(x), tan(x), 1/tan(x), x^2, sqrt(x), log(x), ln(x), exp(x), abs(x), pi, e

        PARAMETRIC GRAPHS (for circles, spirals, Lissajous, etc.):
            {"op":"create_parametric_graph","exprX":"cos(t)","exprY":"sin(t)","tMin":0,"tMax":6.28,"x":50,"y":50,"label":"unit circle"}
            {"op":"create_parametric_graph","exprX":"t*cos(t)","exprY":"t*sin(t)","tMin":0,"tMax":12.56,"label":"spiral"}

        REGULAR POLYGONS (mathematically precise):
            {"op":"create_polygon","sides":5,"x":200,"y":200,"radius":80}  (pentagon)
            {"op":"create_polygon","sides":6,"x":200,"y":200,"radius":80}  (hexagon)
            {"op":"create_polygon","sides":5,"x":200,"y":200,"radius":80,"star":true}  (5-pointed star)

        STATIC SHAPES (SVG — CRITICAL RULES: fill='none', stroke='black', viewBox must match coordinates):
            - Circle: {"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":150,"h":150}
            - Rectangle: {"op":"create_svg","svg":"<svg viewBox='0 0 100 60'><rect x='5' y='5' width='90' height='50' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":200,"h":120}
            - Square: {"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><rect x='5' y='5' width='90' height='90' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":150,"h":150}
            - Triangle: {"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><polygon points='50,5 95,95 5,95' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":150,"h":150}
            - Right-angle triangle: {"op":"create_svg","svg":"<svg viewBox='0 0 100 100'><polygon points='5,95 95,95 5,5' fill='none' stroke='black' stroke-width='2'/><rect x='5' y='85' width='10' height='10' fill='none' stroke='black' stroke-width='1.5'/></svg>","x":100,"y":100,"w":150,"h":150}
            - 3D Cube: {"op":"create_svg","svg":"<svg viewBox='0 0 120 100'><polygon points='60,10 100,30 100,70 60,90 20,70 20,30' fill='none' stroke='black' stroke-width='2'/><line x1='60' y1='10' x2='60' y2='50' stroke='black' stroke-width='2'/><line x1='20' y1='30' x2='60' y2='50' stroke='black' stroke-width='2'/><line x1='100' y1='30' x2='60' y2='50' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":180,"h":150}
            - Cylinder: {"op":"create_svg","svg":"<svg viewBox='0 0 100 150'><ellipse cx='50' cy='20' rx='40' ry='10' fill='none' stroke='black' stroke-width='2'/><line x1='10' y1='20' x2='10' y2='130' stroke='black' stroke-width='2'/><line x1='90' y1='20' x2='90' y2='130' stroke='black' stroke-width='2'/><ellipse cx='50' cy='130' rx='40' ry='10' fill='none' stroke='black' stroke-width='2'/></svg>","x":100,"y":100,"w":150,"h":200}
            IMPORTANT: For <rect>, ALWAYS include x, y, width, AND height attributes.

        UPDATE EXISTING SHAPE (use shape ID from get_board_state):
            {"op":"update_shape","shapeId":"shape:abc123","label":"r = 5"}
            {"op":"update_shape","shapeId":"shape:abc123","color":"blue","x":200,"y":100}
            {"op":"update_shape","shapeId":"shape:abc123","w":150,"h":150}

        DELETE A SHAPE:
            {"op":"delete_shape","shapeId":"shape:abc123"}

        POINT TO SOMETHING (draw arrow near a shape):
            {"op":"create_arrow","x":100,"y":100,"toX":200,"toY":200}

        OTHER:
            {"op":"create_text","text":"Hello","x":50,"y":50}
            {"op":"create_geo","geo":"rectangle","x":100,"y":100,"w":80,"h":50}
            {"op":"create_formula","formula":"x^2 + y^2 = r^2","x":100,"y":100}
            {"op":"undo"}
            {"op":"clear_board"}
        """
        try:
            command = json.loads(command_json)
            if "v" not in command:
                command["v"] = 1
            if "id" not in command:
                command["id"] = str(uuid4())
            if command.get("op") == "create_svg" and isinstance(command.get("svg"), str):
                command["svg"] = command["svg"].replace('\\"', "'")

            logger.info(f"Publishing board command: {command.get('op')} - {command}")
            await self._publish_board_command(command)

            # For get_board_state, wait for the frontend to publish the response
            if command.get("op") == "get_board_state":
                self._pending_board_response = asyncio.get_running_loop().create_future()
                try:
                    result = await asyncio.wait_for(self._pending_board_response, timeout=3.0)
                    self._pending_board_response = None
                    return f"board state: {result}"
                except asyncio.TimeoutError:
                    self._pending_board_response = None
                    return "board state: timeout - board may be empty or not connected"

            return f"command executed: {command.get('op', 'unknown')}"
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in execute_command: {e}")
            return f"Error: Invalid JSON - {str(e)}"

    @function_tool()
    async def search_documents(
        self,
        context: RunContext,
        query: str,
    ) -> str:
        """Search the learner's uploaded documents for relevant passages.

        ALWAYS call this tool first when the learner asks about a topic that
        might be covered in their uploaded study materials (textbooks, notes, PDFs).
        Use it before answering any subject-matter question.

        Args:
            query: A concise keyword-rich search query describing what to look for.
                   Examples: "OSI model layers", "TCP handshake", "data structures array"

        Returns:
            A concise summary of relevant content from the learner's documents,
            including page numbers of any diagrams that can be drawn.
        """
        try:
            from uuid import uuid4 as _uuid4
            if self._retrieval is None:
                return "No documents have been uploaded yet."

            # Prepend learner context if they pointed to a specific passage
            if self._learner_context:
                lc = self._learner_context
                query = f"[Learner is pointing to: \"{lc.get('text', '')[:200]}\" from {lc.get('doc_name', '')} p.{lc.get('page_number', '?')}] {query}"
                self._learner_context = None  # consume once

            result = await self._retrieval.retrieve(
                query=query,
                turn_id=str(_uuid4()),
                top_k=4,
                threshold=0.25,
            )

            if result.context.is_general_knowledge or not result.context.context_text:
                return "No relevant passages found in the uploaded documents for this query."

            # Publish sources to frontend for transparency (fire and forget)
            if self._rag_orchestrator is not None:
                asyncio.create_task(
                    self._rag_orchestrator.publish_sources(
                        result.context.sources,
                        turn_id=str(_uuid4()),
                        is_general_knowledge=False,
                    )
                )

            # Compress the retrieved content via gemini-2.5-flash to keep
            # the tool result small and avoid Gemini Live context overflow (1008 errors)
            return await self._compress_context(query, result.context)
        except Exception as e:
            logger.error("search_documents failed: %s", e)
            return f"Document search failed: {e}"

    async def _compress_context(self, query: str, context) -> str:
        """Reformat retrieved chunks for Gemini Live — preserve all facts, just restructure.

        Keeps tool results concise to prevent Gemini Live 1008 disconnects,
        but preserves all key facts, definitions, and terms from the source.
        """
        # Build diagram hint lines (very compact)
        diagram_hints = ""
        if context.diagram_recipes:
            hints = [f"p.{r.page_number}: {r.description}" for r in context.diagram_recipes]
            diagram_hints = "\nDiagrams available (call draw_diagram with page number): " + "; ".join(hints)

        try:
            from google import genai as _genai
            api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
            client = _genai.Client(api_key=api_key)

            prompt = (
                f"The learner asked: \"{query}\"\n\n"
                f"Retrieved document passages:\n{context.context_text[:2000]}\n\n"
                "Write a concise 3-4 sentence answer covering the key facts. "
                "Include document name and page numbers. No bullet points. "
                "Return ONLY the answer."
            )
            response = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
            summary = (response.text or "").strip()
            if summary:
                # Hard cap at 500 chars to prevent Gemini Live 1008/1011 disconnects
                if len(summary) > 500:
                    # Truncate at last sentence boundary before 500 chars
                    truncated = summary[:500]
                    last_period = max(truncated.rfind(". "), truncated.rfind(".\n"))
                    if last_period > 200:
                        summary = truncated[:last_period + 1]
                    else:
                        summary = truncated
                return summary + diagram_hints
        except Exception as e:
            logger.warning("Context compression failed: %s — returning truncated raw text", e)

        # Fallback: truncate raw text
        truncated = context.context_text[:300]
        return truncated + diagram_hints

    @function_tool()
    async def draw_diagram(
        self,
        context: RunContext,
        page_number: int,
    ) -> str:
        """Draw a diagram from the learner's uploaded document onto the board.

        Call this when search_documents mentions a diagram on a specific page.
        The diagram is drawn directly on the board — you do NOT need to call execute_command.

        Args:
            page_number: The page number of the diagram to draw (from search_documents result).

        Returns:
            Confirmation that the diagram was drawn, or an error message.
        """
        try:
            if self._chroma_collection is None:
                return "No documents available."

            # Look up the stored diagram description for this page
            results = self._chroma_collection.get(
                where={"page_number": page_number},
                include=["metadatas"],
                limit=1,
            )
            metadatas = results.get("metadatas", [])
            if not metadatas:
                return f"No diagram found for page {page_number}."

            recipe_raw = metadatas[0].get("diagram_recipe", "")
            if not recipe_raw:
                return f"No diagram stored for page {page_number}."

            import json as _json
            recipe_data = _json.loads(recipe_raw)
            description = recipe_data.get("description", "")
            image_b64 = recipe_data.get("image_b64", "")
            if not description and not image_b64:
                return f"Diagram data missing for page {page_number}."

            # Generate drawing commands on-demand via gemini-2.5-flash
            # Uses the actual page image when available for accurate reproduction
            from rag.diagram_extractor import DiagramExtractor
            from google import genai as _genai
            api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
            client = _genai.Client(api_key=api_key)
            extractor = DiagramExtractor(client)
            commands = await extractor.generate_commands(description, image_b64=image_b64)

            if not commands:
                return f"Could not generate drawing commands for the diagram on page {page_number}."

            # Publish commands directly to the board — bypasses Gemini Live context entirely
            published = 0
            for cmd in commands:
                try:
                    if "v" not in cmd:
                        cmd["v"] = 1
                    if "id" not in cmd:
                        cmd["id"] = str(uuid4())
                    await self._publish_board_command(cmd)
                    published += 1
                    await asyncio.sleep(0.05)  # small delay between commands
                except Exception as e:
                    logger.warning("Failed to publish diagram command: %s", e)

            logger.info("Drew diagram from page %d: %d commands published", page_number, published)
            return f"Drew the diagram from page {page_number} on the board ({published} shapes)."
        except Exception as e:
            logger.error("draw_diagram failed for page %d: %s", page_number, e)
            return f"Failed to draw diagram: {e}"

    @function_tool()
    async def calculate(
        self,
        context: RunContext,
        expression: str,
    ) -> str:
        """Evaluate a mathematical expression accurately.

        Use this for ANY arithmetic, algebra, or math computation.
        Never guess math — always use this tool.

        Args:
            expression: Math expression to evaluate. Examples:
                - "347 * 28"
                - "sqrt(144)"
                - "sin(pi/6)"
                - "2^10"
                - "log(100, 10)"  (log base 10 of 100)
                - "(3 + 4i) * (1 - 2i)"  (complex numbers)
                - "15% of 340"  → use "340 * 0.15"
                - "derivative of x^3"  → use "3*x^2" (symbolic not supported, state the rule)

        Returns the computed result as a string.
        """
        try:
            import math as _math
            # Use mathjs-compatible evaluation via Python math
            # Map common expressions
            expr = expression.strip()
            # Replace common notation
            expr = expr.replace("^", "**")
            expr = expr.replace("pi", str(_math.pi))
            expr = expr.replace("e", str(_math.e))

            # Safe eval with math functions
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
            return f"Could not evaluate '{expression}': {str(e)}"

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

    # Initialise RAG warm-path components
    kg = KnowledgeGraph()
    kg.load()
    ingestion = IngestionPipeline(knowledge_graph=kg)
    retrieval = RetrievalPipeline(
        knowledge_graph=kg,
        chroma_collection=ingestion._collection,
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
            "You are Tablo, a Socratic AI teacher on a whiteboard. "
            "ALWAYS write steps and equations on the board as you work through problems. "
            "Do one step at a time, write it, then ask the learner what comes next. "
            "If the learner goes silent, proactively ask a follow-up question — never let the conversation die. "
            "After placing labels, verify with get_board_state and fix mistakes by deleting and redrawing. "
            "Don't write greetings on the board — only math, steps, diagrams. "
            "Use calculate tool for arithmetic. Keep voice short.\n\n"
            "DOCUMENT GROUNDING: The learner may upload study materials. "
            "When they ask about any subject-matter topic, call search_documents first. "
            "If relevant passages are found, base your explanation on them and say you're referencing their materials. "
            "If the result mentions a diagram on a page number, call draw_diagram with that page number to draw it. "
            "Only use general knowledge if search_documents returns nothing relevant."
        ),
        temperature=0.8,
    )

    session = AgentSession(llm=model)

    # Create agent first with retrieval; wire orchestrator after
    tablo_agent = TabloAgent(ctx.room, retrieval=retrieval, rag_orchestrator=None, chroma_collection=ingestion._collection)

    # Wire RAG orchestrator — warm path only, never blocks voice
    rag_orchestrator = RAGOrchestrator(
        retrieval_pipeline=retrieval,
        tablo_agent=tablo_agent,
        room=ctx.room,
    )
    rag_orchestrator.set_base_instructions(tablo_agent.instructions or "")
    # Give the agent a reference back so search_documents can publish sources
    tablo_agent._rag_orchestrator = rag_orchestrator

    await session.start(
        agent=tablo_agent,
        room=ctx.room,
        room_options=room_io.RoomOptions(video_input=True),
    )

    logger.info("Agent session started in room: %s", ctx.room.name)

    await session.generate_reply(
        instructions=(
            "Greet the learner briefly in voice only — do NOT write anything on the board yet. "
            "Just say something like 'Hey! I can see your board. What would you like to work on today?'"
        )
    )

    @session.on("user_speech_committed")
    def on_user_speech_committed(msg):
        logger.info("User speech committed: %s", msg)
        # Fire RAG retrieval on warm path — never awaited, never blocks voice
        transcript = getattr(msg, "text", "") or str(msg)
        turn_id = str(uuid4())
        asyncio.create_task(
            rag_orchestrator.on_user_turn(
                transcript=transcript,
                board_summary="",  # board summary injected when available
                turn_id=turn_id,
            )
        )

    @session.on("agent_speech_started")
    def on_agent_speech_started():
        logger.info("Agent started speaking")

    @session.on("error")
    def on_error(err):
        logger.error("Session error: %s", err)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track, publication, participant):
        logger.info("Subscribed to track %s from %s (%s)", track.sid, participant.identity, track.kind)

    @ctx.room.on("data_received")
    def on_data_received(data_packet):
        """Listen for board.response from the frontend (board state replies)."""
        try:
            topic = getattr(data_packet, "topic", None)
            if topic == "board.response":
                payload = bytes(data_packet.data)
                tablo_agent._on_board_response(payload)
            elif topic == "tutor.sources":
                # Backend echo — log for debugging only
                logger.debug("tutor.sources echo received (backend no-op)")
            elif topic == "learner.context":
                # Learner selected a passage in the document viewer
                try:
                    ctx_data = json.loads(bytes(data_packet.data).decode("utf-8"))
                    tablo_agent._learner_context = ctx_data
                    logger.info("Learner context received: %s p.%s", ctx_data.get("doc_name", ""), ctx_data.get("page_number", ""))
                except Exception as e:
                    logger.warning("Failed to parse learner.context: %s", e)
        except Exception as e:
            logger.warning("Error handling data_received: %s", e)


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="tablo-assistant",
        )
    )