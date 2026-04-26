# GEMINI.md - Tablo Project Context

## Project Overview
Tablo is a **voice-first, board-first** real-time Socratic AI whiteboard designed for collaborative learning. It aims to provide a shared thinking space where an AI tutor (powered by Gemini) guides learners through the Socratic method rather than just providing answers.

## Current Implemented Capabilities

- **Realtime voice loop:** learner audio and AI audio run through LiveKit rooms with a backend-issued token.
- **Live board vision:** the frontend exports the `tldraw` page as image frames, paints them into an offscreen canvas, and publishes that as a LiveKit video track.
- **Gemini visual input:** the agent session is started with `room_io.RoomOptions(video_input=True)`, so Gemini Live can use the board feed during reasoning.
- **Deterministic board drawing:** the backend agent emits `board.command` messages via `execute_command` tool and the frontend applies them directly to `tldraw`.
- **`calculate` tool:** safe Python `eval` for arithmetic — the agent must use this instead of guessing math.
- **Board state feedback:** `get_board_state` publishes a `board.response` data packet from the frontend; the agent waits up to 3 seconds for the reply.
- **RAG with source transparency:** hybrid vector + knowledge graph retrieval from uploaded PDFs. Agent uses `search_documents` tool (result compressed to ≤500 chars) and `draw_diagram` tool (generates tldraw commands from stored page images via Gemini vision). Sources published to frontend via `tutor.sources` LiveKit topic.
- **Diagram-aware ingestion:** PDF pages rendered to PNG at ingestion time; Gemini vision extracts diagram descriptions and stores page images as base64. Commands generated on-demand at draw time from the actual page image for accurate reproduction.
- **Context window compression:** `ContextWindowCompressionConfig(trigger_tokens=25000, sliding_window=SlidingWindow(target_tokens=12000))` enabled on the RealtimeModel to prevent session context overflow.

### Full Drawing Command Set

The agent uses a single `execute_command(command_json)` tool. All commands share `v` (version) and `id` fields added automatically.

| Category | Commands |
| --- | --- |
| Text | `create_text`, `create_multiline_text`, `create_text_near_selection`, `create_formula`, `create_text_on_target` |
| Geometry | `create_geo` (rectangle/ellipse/diamond/triangle), `create_arrow`, `create_arrow_between_targets`, `create_freehand`, `create_freehand_stroke` |
| SVG | `create_svg` — agent writes raw SVG; frontend embeds it as a custom tldraw shape |
| Math graphs | `create_graph` — agent provides expressions (e.g. `sin(x)`, `x^2`); frontend evaluates with `mathjs` and renders an accurate canvas plot |
| Parametric graphs | `create_parametric_graph` — agent provides `exprX`/`exprY` as functions of `t` |
| Regular polygons | `create_polygon` — mathematically precise n-gons and stars by circumradius |
| Board state | `get_board_state`, `get_shape_info`, `match_shapes` |
| Shape mutation | `update_shape` (move/resize/relabel/recolor), `delete_shape`, `undo` |
| Cleanup | `clear_board`, `clear_shapes`, `clear_region` |
| Positioning | `get_position_info`, `calculate_position`, `get_distance`, `suggest_placement`, `place_with_collision_check` |
| Labels | `create_side_label` (normal / inverted / side-inverted placement relative to a shape edge) |
| Alignment | `snap_to_grid`, `snap_bounds_to_grid`, `align_shapes` |

Target references (`BoardTargetRef`) supported across target-aware commands: `selection`, `pointer`, `this`, `that`, `shape:<id>`.

### Core Technologies
- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS 4, `tldraw` for the whiteboard canvas, `mathjs` for graph expression evaluation.
- **Backend (API):** FastAPI for session management, token generation, and board state synchronization.
- **Backend (Agent):** `livekit-agents` v1.5.x with `google.beta.realtime.RealtimeModel` (`gemini-2.5-flash-native-audio-preview-12-2025`) for real-time speech-to-speech interaction.
- **Real-time Transport:** LiveKit (WebRTC) for audio, video, and data tracks.
- **RAG:** `google-genai` SDK, `gemini-embedding-2` (multimodal, 3072-dim), ChromaDB, PyMuPDF for PDF parsing and page image rendering.
- **Orchestration:** LangGraph (planned for complex tutoring policies).

## Building and Running

### Backend Setup
1. **Environment Variables:** Create a `.env` file in the `backend/` directory with:
    ```env
    LIVEKIT_URL=<your-livekit-url>
    LIVEKIT_API_KEY=<your-api-key>
    LIVEKIT_API_SECRET=<your-api-secret>
    GOOGLE_API_KEY=<your-gemini-api-key>
    ```
    *Note: `GOOGLE_API_KEY` is required by the LiveKit Google plugin. `GEMINI_API_KEY` is aliased to `GOOGLE_API_KEY` automatically in `agent.py` if only that is set.*

2. **Install Dependencies:**
    ```bash
    cd backend
    python -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    ```

3. **Run FastAPI Server:**
    ```bash
    uvicorn main:app --reload
    ```

4. **Run LiveKit Agent:**
    ```bash
    python agent.py dev
    ```

### Frontend Setup
1. **Install Dependencies:**
    ```bash
    cd frontend
    npm install
    ```

2. **Run Development Server:**
    ```bash
    npm run dev
    ```

    From the workspace root:
    ```bash
    npm --prefix frontend run dev
    ```

## Development Conventions & Rules

### Non-Negotiable UX Rules
- **Canvas-First:** The `tldraw` whiteboard must remain the primary surface.
- **Voice-First:** Interaction should prioritize voice and board events. Avoid typical "chatbot" text interfaces.
- **Socratic Tutoring:** The AI must guide, probe, and scaffold — never give final answers too early.

### Backend Implementation Guardrails
- **Agent API:** Using `livekit-agents` v1.5+. `AgentSession.start()` requires `agent=Agent(...)` and `room=ctx.room`.
- **Model namespace:** `google.beta.realtime.RealtimeModel` — note the `beta` namespace.
- **Model name:** `gemini-2.5-flash-native-audio-preview-12-2025` for the standard Gemini API. Use the dated preview, **not** `latest` — the `latest` alias routes to a version that rejects function calls with 1008 errors. The Vertex AI name (`gemini-live-2.5-flash-native-audio`) is different.
- **Single tool entry point:** all board drawing goes through `execute_command`. Do not add separate per-shape tools.
- **Math:** always use the `calculate` tool — never let the model guess arithmetic.
- **Normalization:** the backend acts as the audio normalization boundary between LiveKit (48 kHz) and Gemini (16 kHz in, 24 kHz out).

### Frontend Implementation Guardrails
- **Layout:** use full-screen or nearly full-screen board layouts. Keep overlays minimal.
- **Command validation:** the frontend validates all commands before execution and returns typed error codes. Do not bypass this layer.
- **SVG rules:** always use `fill='none'` and `stroke='black'`; always include a `viewBox`; for `<rect>` always include `x`, `y`, `width`, and `height`.
- **Next.js:** this project uses Next.js 16 with potential breaking changes. Always check `node_modules/next/dist/docs/` if unsure.

### Architecture Guidelines
- **Hot Path:** real-time conversation and whiteboard responsiveness (direct Gemini Live loop).
- **Warm Path:** slower operations like RAG retrieval, tool execution, and memory updates via LangGraph.
- **Interruption:** the system must support interruption; stale board actions from an interrupted turn should be discarded.

## Key Files
- `backend/main.py`: FastAPI routes, session bootstrap, document upload/management endpoints.
- `backend/agent.py`: LiveKit agent (`TabloAgent`), `execute_command`, `calculate`, `search_documents`, `draw_diagram` tools, board command publishing, and board state response handling.
- `backend/rag/ingestion.py`: Two-phase PDF ingestion — fast text chunking + background diagram extraction.
- `backend/rag/retrieval.py`: Hybrid vector + graph retrieval with RRF reranking and diagram recipe propagation.
- `backend/rag/diagram_extractor.py`: PDF page rendering and Gemini vision diagram extraction.
- `backend/rag/orchestrator.py`: Warm-path RAG orchestrator, source publishing to frontend.
- `frontend/src/components/tablo-workspace.tsx`: Main whiteboard UI, board video publisher, full board command handler, command validation layer, board state manager, and position intelligence engine.
- `frontend/src/components/source-panel.tsx`: RAG source transparency panel, listens on `tutor.sources` LiveKit topic.
- `frontend/src/components/document-upload.tsx`: Document upload UI.
- `AGENTS.md`: Detailed instructions and guardrails for AI agents working on this repo.
- `README.md`: Comprehensive vision and architectural documentation.
