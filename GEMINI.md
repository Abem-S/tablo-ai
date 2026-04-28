# GEMINI.md - Tablo Project Context

## Project Overview
Tablo is a **voice-first, board-first** real-time Socratic AI whiteboard designed for collaborative learning. It aims to provide a shared thinking space where an AI tutor (powered by Gemini) guides learners through the Socratic method rather than just providing answers.

## Current Implemented Capabilities

- **Realtime voice loop:** learner audio and AI audio run through LiveKit rooms with a backend-issued token. Mic uses `echoCancellation`, `noiseSuppression`, `autoGainControl`.
- **Board vision via triggered snapshots:** the frontend captures PNG snapshots of the tldraw board and sends them via `board.snapshot` LiveKit data topic under three conditions: (1) user starts speaking, (2) board changes while AI is silent (1.5s debounce), (3) board changes while AI is speaking (immediate). This replaces the previous continuous video track and eliminates the 2-minute session limit.
- **`get_board_image` tool:** agent calls this explicitly to see the board visually — reads freehand writing, student drawings, handwritten equations. Injects the latest snapshot into Gemini Live's chat context via `update_chat_ctx`.
- **Deterministic board drawing:** the backend agent emits `board.command` messages via `execute_command` tool and the frontend applies them directly to `tldraw`.
- **`calculate` tool:** safe Python `eval` for arithmetic — the agent must use this instead of guessing math.
- **Board state feedback:** `get_board_state` publishes a `board.response` data packet from the frontend; the agent waits up to 3 seconds for the reply.
- **Skills system:** agent behavior defined in `backend/skills/*.md` files, not hardcoded in `agent.py`. `skills_loader.py` assembles the dynamic system prompt = skills + learner profile at session start.
- **Learner memory:** per-learner JSON profiles in `backend/data/learner_profiles/`. `update_learner_profile` tool writes observations mid-session. Profile loaded at session start and injected into system prompt. Persists across sessions.
- **RAG with source transparency:** hybrid vector + knowledge graph retrieval from uploaded documents. Agent uses `search_documents` tool (result compressed to ≤500 chars) and `draw_diagram` tool (generates tldraw commands from stored page images via Gemini vision). Sources published to frontend via `tutor.sources` LiveKit topic. RAG context flows through the tool only — `update_instructions` injection has been removed.
- **Qdrant vector store:** self-hosted (Docker) or Qdrant Cloud. `tablo_shared` collection for single-user mode. Per-user collections (`tablo_{user_id}`) when auth is added. Diagram page images embedded directly via `gemini-embedding-2` multimodal alongside text chunks.
- **Diagram-aware ingestion:** PDF pages rendered to PNG at ingestion time; Gemini vision extracts diagram descriptions and stores page images as base64. Commands generated on-demand at draw time from the actual page image.
- **Context window compression:** `ContextWindowCompressionConfig(trigger_tokens=25000, sliding_window=SlidingWindow(target_tokens=12000))` enabled on the RealtimeModel.
- **Multi-format document support:** 17 file types (pdf, txt, docx, doc, pptx, rtf, png, jpg, jpeg, webp, heif, xlsx, xls, csv, tsv, html, hwp). Per-format parsers in `backend/rag/parsers.py`.
- **Document viewer panel:** collapsible side panel. `react-pdf` renders actual PDF pages with prev/next navigation. AI auto-opens panel, jumps to correct page, highlights referenced excerpt. Select text → "Ask AI about this" tooltip → sends via `learner.context` topic.
- **LiveKit self-hosted support:** `docker compose --profile livekit up -d` starts an open-source LiveKit server. Switch between Cloud and self-hosted via `LIVEKIT_URL` env var only.

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

Use `get_board_image` (separate tool) when you need to SEE the board visually — to read handwritten text, check student drawings, or understand freehand content that `get_board_state` can't describe.

### Core Technologies
- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS 4, `tldraw` for the whiteboard canvas, `mathjs` for graph expression evaluation, `react-pdf` for document viewing.
- **Backend (API):** FastAPI for session management, token generation, document management, and learner profile endpoints.
- **Backend (Agent):** `livekit-agents` v1.5.x with `google.beta.realtime.RealtimeModel` (`gemini-2.5-flash-native-audio-preview-12-2025`) for real-time speech-to-speech interaction.
- **Real-time Transport:** LiveKit (WebRTC) for audio and data tracks. Supports both LiveKit Cloud and self-hosted open-source server.
- **RAG:** `google-genai` SDK, `gemini-embedding-2` (multimodal, 3072-dim), Qdrant vector store (self-hosted via Docker or Qdrant Cloud), PyMuPDF for PDF parsing and page image rendering.
- **Skills:** `backend/skills/*.md` — modular agent behavior files loaded at session start.
- **Learner Memory:** `backend/learner_memory.py` — JSON profiles per learner, persisted across sessions.
- **Orchestration:** LangGraph (planned for complex tutoring policies).

## Building and Running

### Prerequisites
- Docker (for Qdrant)
- Python 3.12+
- Node.js 20+

### Backend Setup
1. **Start Qdrant:**
    ```bash
    docker compose up qdrant -d
    ```

2. **Environment Variables:** Create `backend/.env`:
    ```env
    # LiveKit — Cloud (default) or self-hosted (ws://localhost:7880)
    LIVEKIT_URL=wss://your-project.livekit.cloud
    LIVEKIT_API_KEY=your-api-key
    LIVEKIT_API_SECRET=your-api-secret

    # Gemini — GOOGLE_API_KEY is required by the LiveKit plugin
    GOOGLE_API_KEY=your-gemini-api-key
    # GEMINI_API_KEY is aliased to GOOGLE_API_KEY automatically in agent.py

    # Qdrant — defaults to http://localhost:6333
    QDRANT_URL=http://localhost:6333
    # QDRANT_API_KEY=  # only needed for Qdrant Cloud
    ```

3. **Install Dependencies:**
    ```bash
    cd backend
    python -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    ```

4. **Run FastAPI Server:**
    ```bash
    uvicorn main:app --reload
    ```

5. **Run LiveKit Agent:**
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

### Self-Hosted LiveKit (optional)
```bash
cp livekit.yaml.example livekit.yaml
# Edit livekit.yaml — set keys matching LIVEKIT_API_KEY/SECRET in backend/.env
# Set LIVEKIT_URL=ws://localhost:7880 in backend/.env
docker compose --profile livekit up -d
```

## Development Conventions & Rules

### Non-Negotiable UX Rules
- **Canvas-First:** The `tldraw` whiteboard must remain the primary surface.
- **Voice-First:** Interaction should prioritize voice. Avoid typical "chatbot" text interfaces.
- **Socratic Tutoring:** The AI must guide, probe, and scaffold — never give final answers too early.
- **No sidebar descriptions:** The dev-notes sidebar has been removed. Do not re-add "Realtime status", "Session readiness", or "LiveKit setup" description panels.

### Backend Implementation Guardrails
- **Agent API:** Using `livekit-agents` v1.5+. `AgentSession.start()` requires `agent=Agent(...)` and `room=ctx.room`.
- **Model namespace:** `google.beta.realtime.RealtimeModel` — note the `beta` namespace.
- **Model name:** `gemini-2.5-flash-native-audio-preview-12-2025` — use the dated preview, **not** `latest`.
- **Single tool entry point:** all board drawing goes through `execute_command`. Do not add separate per-shape tools.
- **Math:** always use the `calculate` tool — never let the model guess arithmetic.
- **Board vision:** use `BoardSnapshotPublisher` + `get_board_image` tool. Do NOT restore `CanvasVideoPublisher` or `video_input=True`.
- **RAG injection:** context flows through `search_documents` tool only. Do NOT call `update_instructions` with RAG context — it gets compressed away by the sliding window.
- **Skills:** agent behavior goes in `backend/skills/*.md`. Do not hardcode long instructions in `agent.py`.
- **Qdrant:** must be running before backend/agent start. `docker compose up qdrant -d`.

### Frontend Implementation Guardrails
- **Layout:** full-screen or nearly full-screen board layouts. Keep overlays minimal.
- **Command validation:** the frontend validates all commands before execution. Do not bypass this layer.
- **SVG rules:** always `fill='none'` and `stroke='black'`; always include `viewBox`; for `<rect>` always include `x`, `y`, `width`, `height`.
- **Next.js:** uses Next.js 16 with Turbopack. Check `node_modules/next/dist/docs/` if unsure. Use `turbopack: {}` in `next.config.ts`, not `webpack` config.

## Key Files
- `backend/main.py` — FastAPI routes, session bootstrap, document upload/management, learner profile endpoints.
- `backend/agent.py` — `TabloAgent`, all tools (`execute_command`, `get_board_image`, `search_documents`, `draw_diagram`, `calculate`, `update_learner_profile`), board snapshot handler, session wiring.
- `backend/learner_memory.py` — load/save/merge learner profiles.
- `backend/skills_loader.py` — load skill files, assemble dynamic system prompt.
- `backend/skills/` — modular agent behavior markdown files.
- `backend/rag/vector_store.py` — Qdrant client wrapper.
- `backend/rag/ingestion.py` — two-phase document ingestion with Qdrant storage.
- `backend/rag/retrieval.py` — hybrid vector + graph retrieval with RRF reranking.
- `backend/rag/orchestrator.py` — warm-path RAG orchestrator, source publishing.
- `backend/rag/diagram_extractor.py` — PDF page rendering and Gemini vision diagram extraction.
- `frontend/src/components/tablo-workspace.tsx` — main whiteboard UI, `BoardSnapshotPublisher`, full board command handler, command validation, board state manager.
- `frontend/src/components/document-viewer-panel.tsx` — react-pdf viewer, AI navigation, select-to-ask.
- `frontend/src/components/source-panel.tsx` — RAG source transparency panel.
- `docker-compose.yml` — Qdrant + backend + agent + optional self-hosted LiveKit.
- `livekit.yaml.example` — template for self-hosted LiveKit config.
- `AGENTS.md` — detailed guardrails for AI agents working on this repo.
- `README.md` — comprehensive vision and architectural documentation.
