<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Tablo Project Guide

## Product Direction

Tablo is a **voice-first, board-first** AI learning product.

The core product idea is:

- the board is the main surface
- voice is the main input/output mode
- text is secondary support, not the primary interaction model
- the AI should think with the learner on the board, not behave like a normal chatbot

## Non-Negotiable UX Rules

When editing the frontend, preserve these principles:

1. The canvas should dominate the screen.
2. Do not drift into a chat-app layout.
3. Do not introduce fake product flows that are only convenient for development.
4. If a temporary development-only UI is necessary, label it clearly as temporary and keep it visually subordinate.
5. Voice, transcript, links, and shared resources should eventually support the board, not replace it.

## Architecture Rules

The intended architecture includes:

- Next.js frontend
- `tldraw`-based board workspace
- FastAPI backend
- LangGraph orchestration
- LiveKit for realtime transport
- Gemini Live API for low-latency multimodal interaction
- RAG, tools, session memory, and persistent learner memory

Agents working in this repo should preserve that direction rather than simplifying it away.

In particular:

- do not remove live voice transport from architectural docs unless explicitly asked
- do not downgrade the system into a text-chat product
- do not replace long-term architecture with only what is currently implemented
- do make the architecture more accurate, more implementation-ready, and more technically grounded

## README Rules

When editing `README.md`:

1. Keep the full long-term product vision visible.
2. Improve the architecture rather than shrinking it.
3. If a model/version detail may change, prefer an accurate architectural description over a brittle hard-coded claim.
4. Separate current implementation state from long-term target architecture without weakening the vision.
5. Build plans should support the intended product, not redirect it into a different app shape.

## Day-by-Day Build Rules

For early implementation work:

- Day 1 should establish the real shell of the product, not a misleading fake product flow.
- It is acceptable to build infrastructure, backend readiness, board sync, and session bootstrap before full voice.
- It is not acceptable to let temporary text-input development hacks become the visible product direction.

### Day 2 — What is now implemented

Day 2 shipped a working LiveKit + Gemini Live voice loop:

- **`backend/agent.py`** — a `livekit-agents` v1.5.x worker registered as `tablo-assistant`. On job dispatch it connects to the room, instantiates `google.beta.realtime.RealtimeModel` with `model="gemini-2.5-flash-native-audio-preview-12-2025"`, starts an `AgentSession` with a `TabloAgent` instance, and calls `await session.generate_reply()` to greet the learner.
- **`backend/main.py`** — `/livekit/token` issues a signed participant JWT and dispatches `tablo-assistant` to the room via `livekit_api.agent_dispatch.create_dispatch`.
- **Frontend** — `LiveKitRoom` from `@livekit/components-react` connects with the token from the backend. `RoomAudioRenderer` plays AI audio. `VoiceAssistantControlBar` appears when connected.
- **Vision now implemented** — the frontend renders the `tldraw` page to PNG frames and publishes a board video track through LiveKit; the agent session is started with `room_io.RoomOptions(video_input=True)` so Gemini Live receives ongoing board visuals.
- **Key env vars required:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GOOGLE_API_KEY` (the plugin reads `GOOGLE_API_KEY`, not `GEMINI_API_KEY`). `GEMINI_API_KEY` is aliased to `GOOGLE_API_KEY` automatically in `agent.py` if only the former is set.
- **Model note:** `gemini-live-2.5-flash-native-audio` is the Vertex AI model name. The standard Gemini API key model is `gemini-2.5-flash-native-audio-preview-12-2025` (use the dated preview, not `latest`, for stable function-calling support).

### AI Drawing Capabilities — What is now implemented

A full AI drawing system has been built on top of the `board.command` data topic. The agent uses a single `execute_command` function tool that accepts a JSON command string. The frontend parses and applies commands directly to `tldraw`.

**Agent side (`backend/agent.py`):**
- `TabloAgent` extends `Agent` and holds a reference to the LiveKit room for publishing data.
- `execute_command` tool — sends any board command as a JSON string over `board.command`. For `get_board_state`, it waits up to 3 seconds for a `board.response` reply from the frontend.
- `calculate` tool — safe Python `eval` for arithmetic so the agent never guesses math.
- The agent system prompt includes detailed drawing instructions, SVG rules, and a Socratic teaching workflow.

**Frontend side (`frontend/src/components/tablo-workspace.tsx`):**
- Listens on `board.command` data topic and dispatches to a typed command handler.
- Full command set implemented:
  - **Text:** `create_text`, `create_multiline_text`, `create_text_near_selection`, `create_formula`, `create_text_on_target`
  - **Geometry:** `create_geo` (rectangle, ellipse, diamond, triangle), `create_arrow`, `create_arrow_between_targets`, `create_freehand`, `create_freehand_stroke`
  - **SVG:** `create_svg` — agent generates raw SVG; frontend embeds it as a custom tldraw shape
  - **Math graphs:** `create_graph` — agent provides expressions (e.g. `sin(x)`, `x^2`); frontend evaluates them with `mathjs` and renders an accurate canvas plot
  - **Parametric graphs:** `create_parametric_graph` — agent provides `exprX`/`exprY` as functions of `t`; frontend plots the curve
  - **Regular polygons:** `create_polygon` — mathematically precise n-gons and stars by circumradius
  - **Board state:** `get_board_state` returns all shape IDs, types, bounds, labels, and relationships; `get_shape_info` returns detail for one shape; `match_shapes` finds shapes by visual criteria
  - **Shape mutation:** `update_shape` (move, resize, relabel, recolor), `delete_shape`, `undo`
  - **Cleanup:** `clear_board`, `clear_shapes`, `clear_region`
  - **Positioning:** `get_position_info`, `calculate_position`, `get_distance`, `suggest_placement`, `place_with_collision_check`
  - **Labels:** `create_side_label` (normal / inverted / side-inverted placement relative to a shape edge)
  - **Alignment:** `snap_to_grid`, `snap_bounds_to_grid`, `align_shapes`
- Command validation layer rejects malformed commands with typed error codes before execution.
- All commands are logged with success/failure status for debugging.

## Frontend Implementation Guardrails

- Prefer full-screen or nearly full-screen board layouts.
- Keep overlays minimal and purposeful.
- Avoid bulky “marketing” framing inside the working app.
- If status surfaces exist, they should reflect real system state.
- If board summaries or session data are shown, they should update from actual board/backend events, not static placeholders.

## Backend Implementation Guardrails

- Prefer small, honest endpoints over fake AI behavior that does not belong in the product.
- Early backend work should expose real readiness, bootstrap, sync, or orchestration boundaries.
- LiveKit + Gemini Live voice is **now working** — do not regress it.
- Vision feed + board-command drawing are now working — do not regress them.
- The full AI drawing command set is now working — do not regress it. See the "AI Drawing Capabilities" section above for the complete command list.
- `livekit-agents` worker must be run separately from FastAPI: `python agent.py dev`.
- `AgentSession.start()` in v1.5+ requires `agent=Agent(...)` as the first positional arg and `room=ctx.room` as a keyword — not `session.start(ctx.room)`.
- The plugin env var is `GOOGLE_API_KEY`. `GEMINI_API_KEY` alone is not read by the plugin (though `agent.py` aliases it automatically).
- The agent uses `google.beta.realtime.RealtimeModel` — note the `beta` namespace.
- The `execute_command` tool is the single entry point for all board drawing. Do not add separate per-shape tools.
- The `calculate` tool must be used for all arithmetic — never let the model guess math.

### RAG System — What is now implemented

A full hybrid RAG pipeline is implemented in `backend/rag/`:

- **`ingestion.py`** — two-phase ingestion: `ingest_document_fast` (parse → chunk → embed → store, returns immediately) and `extract_and_attach_diagrams` (background task, vision-based diagram extraction).
- **`retrieval.py`** — hybrid vector + knowledge graph search with RRF reranking. Cosine similarity threshold applied before RRF. Returns `RetrievalContext` with sources and diagram recipes.
- **`orchestrator.py`** — warm-path orchestrator triggered on `user_speech_committed`. Publishes sources to frontend via `tutor.sources` LiveKit data topic.
- **`diagram_extractor.py`** — renders PDF pages to PNG (PyMuPDF, 150 DPI, in-memory), calls Gemini 2.5 Flash vision to extract diagram descriptions and store page images as base64. At draw time, uses the actual page image to generate accurate tldraw commands.
- **`models.py`** — `DiagramRecipe` (page_number, description, image_b64), `RetrievalContext` with `diagram_recipes`, `IngestionResult` with `diagram_count`.
- **Embedding model:** `gemini-embedding-2` (multimodal, 3072-dim) via `google-genai` SDK.
- **Generation model:** `gemini-2.5-flash` for concept extraction, query rewriting, context compression, and diagram command generation.
- **ChromaDB** persisted at `backend/data/chromadb/`.

**Agent tools for RAG:**
- `search_documents(query)` — retrieves chunks, compresses result to ≤500 chars via gemini-2.5-flash to prevent Gemini Live 1008 disconnects, includes diagram hints.
- `draw_diagram(page_number)` — fetches stored diagram recipe, generates tldraw commands from the actual page image via Gemini vision, publishes commands directly to `board.command` topic (bypasses Gemini Live context).

**FastAPI endpoints:**
- `POST /documents/upload` — fast ingest (returns in seconds), triggers background diagram extraction.
- `GET /documents` — list ingested documents.
- `DELETE /documents/{doc_id}` — remove document.
- `POST /documents/{doc_id}/extract-diagrams` — re-trigger diagram extraction for an existing document.

**Frontend:**
- `DocumentUploadButton` — upload UI shown when connected.
- `SourcePanel` — shows retrieved sources with relevance indicators, listens on `tutor.sources` LiveKit data topic.

**Key implementation notes:**
- Do NOT use `gemini-2.5-flash-native-audio-latest` — use `gemini-2.5-flash-native-audio-preview-12-2025`. The `latest` alias routes to a version that rejects function calls with 1008.
- Tool results returned to Gemini Live must be ≤500 chars. Larger results cause 1008/1011 WebSocket disconnects.
- `context_window_compression` is enabled on the RealtimeModel with `trigger_tokens=25000` and `target_tokens=12000` to prevent session context overflow.
- The `google-genai` SDK (not the deprecated `google-generativeai`) is used for all Gemini calls in the RAG pipeline.

## Agent Behavior for This Repo

When making changes:

1. Read the local Next.js docs before changing App Router behavior.
2. Check the README architecture before making product-shaping decisions.
3. Keep temporary development scaffolding explicitly temporary.
4. If unsure whether a UI element is meant to be final product UX, assume it is **not** unless it fits the voice-first, board-first direction.
5. Prefer honest progress over flashy but misleading demos.
