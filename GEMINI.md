# GEMINI.md — Tablo Project Context

## Project Overview

Tablo is a **voice-first, board-first** real-time Socratic AI whiteboard for collaborative learning. The AI teaches by drawing on the board while speaking — like a real teacher at a blackboard. It retrieves from the student's uploaded study materials, adapts to how each student learns, and remembers across sessions.

---

## What Is Currently Implemented

### Voice & Realtime

- **LiveKit room** — frontend connects with a backend-issued JWT, joins the room
- **Gemini Live voice loop** — `agent.py` runs as a separate worker (`python agent.py dev`), connects to the room, starts `google.beta.realtime.RealtimeModel` with `model="gemini-2.5-flash-native-audio-preview-12-2025"`
- **Agent greets on join** via `session.generate_reply()`
- **Mic** uses `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: true`
- **Context window compression** — `trigger_tokens=25000`, `target_tokens=12000` via `ContextWindowCompressionConfig`

### Board Vision — Triggered Snapshots

The continuous video track has been replaced with `BoardSnapshotPublisher`. Sessions now run indefinitely.

- Frontend sends PNG snapshots via `board.snapshot` LiveKit data topic (unreliable channel, 40% scale, 30KB cap) under three triggers:
  1. User starts speaking → send immediately
  2. Board changes while AI is silent → debounce 1.5s
  3. Board changes while AI is speaking → send immediately
- Agent stores latest snapshot as `_latest_board_snapshot`
- `get_board_image` tool — agent calls this explicitly to see the board. Calls `gemini-2.5-flash` (or `flash-lite` fallback) to describe the PNG and returns a text description as the tool result. Does NOT inject into Live session context (that caused 1008 disconnects).
- `video_input=False` on `RoomOptions` — no continuous video stream

### Skills System

Agent behavior is defined in modular markdown files, not hardcoded in `agent.py`:

```
backend/skills/
  core_teaching.md        — Socratic method, MANDATORY tool call sequence, board-first rules
  drawing_commands.md     — full execute_command reference with examples and SVG rules
  document_grounding.md   — when/how to use RAG and diagrams
  learner_adaptation.md   — how to read and update the learner profile
```

`backend/skills_loader.py` assembles: `skills + learner profile section` → system prompt at session start. Edit a skill file and restart the worker — no code changes needed.

**MANDATORY TOOL CALL SEQUENCE** (in `core_teaching.md`):
```
STEP 1: Call search_documents immediately — before saying anything.
STEP 2: Wait for the result.
STEP 3: Only then respond verbally and draw on the board.
NEVER skip Step 1.
```

### Learner Memory

- Per-learner JSON profiles in `backend/data/learner_profiles/`
- `update_learner_profile` tool — agent writes observations mid-session
- Fields: `learning_styles` (per-subject), `struggle_areas`, `mastered`, `hints_that_worked`, `preferred_pace`, `last_session_summary`, `session_history`
- Profile loaded at session start, injected into system prompt
- Persists across sessions
- API: `GET/PATCH/DELETE /learner/{id}/profile`

### RAG Pipeline

- **Vector store:** Qdrant (self-hosted Docker or Qdrant Cloud). `tablo_shared` collection for single-user mode. Per-user collections (`tablo_{user_id}`) when auth is added.
- **Payload indexes** on `doc_id`, `page_number`, `chunk_index` for fast filtering
- **Embedding:** `gemini-embedding-2` (multimodal, 3072-dim) — concurrent calls with semaphore(5)
- **Ingestion:** fully async — upload returns immediately with `status: "processing"`, ingestion runs in background
- **Retrieval:** hybrid vector + knowledge graph with RRF reranking, threshold 0.1
- **`search_documents` tool** — result compressed to ≤500 chars via `gemini-2.5-flash` (fallback: `gemini-2.5-flash-lite`) to prevent 1008 disconnects
- **`draw_diagram(page_number)` tool** — generates tldraw commands from stored page image via Gemini vision
- **Warm-path orchestrator** — fires on every `user_speech_committed`, runs retrieval, publishes sources to frontend, injects context into agent instructions as safety net (even if model skips `search_documents`)
- **RAG context flows through `search_documents` tool** — `update_instructions` injection was removed (gets compressed away by sliding window)

### Document Viewer Panel

- Collapsible panel (📚 tab) overlaid on the right of the canvas
- `react-pdf` renders actual PDF pages at full panel width with prev/next navigation
- AI auto-opens panel, jumps to correct page, highlights referenced excerpt in PDF text layer
- Select text → "Ask AI about this" floating tooltip → sends via `learner.context` LiveKit topic → agent prepends to next `search_documents` query
- Text/image/HTML viewers for non-PDF formats (DOCX/PPTX show extracted text)

### AI Drawing

Single `execute_command(command_json)` tool. Full command set:

| Category | Commands |
|----------|----------|
| Text | `create_text`, `create_multiline_text`, `create_text_near_selection`, `create_formula`, `create_text_on_target` |
| Geometry | `create_geo`, `create_arrow`, `create_arrow_between_targets`, `create_freehand` |
| SVG | `create_svg` — raw SVG embedded as custom tldraw shape |
| Math graphs | `create_graph` — frontend evaluates with mathjs (accurate) |
| Parametric | `create_parametric_graph` — exprX/exprY as functions of t |
| Polygons | `create_polygon` — precise n-gons and stars |
| Board state | `get_board_state`, `get_shape_info`, `match_shapes` |
| Mutation | `update_shape`, `delete_shape`, `undo` |
| Cleanup | `clear_board`, `clear_shapes`, `clear_region` |
| Positioning | `get_position_info`, `calculate_position`, `get_distance`, `suggest_placement`, `place_with_collision_check` |
| Labels | `create_side_label` |
| Alignment | `snap_to_grid`, `snap_bounds_to_grid`, `align_shapes` |

**SVG rules (CRITICAL):**
- Always `fill='none'` and `stroke='black'` `stroke-width='2'`
- `viewBox` is required — must match coordinate space
- Keep SVG under 400 characters — use simple shapes (`<rect>`, `<circle>`, `<line>`, `<polygon>`, `<text>`), never complex `<path>` elements
- For pie/bar charts: use `create_geo` + `create_text`, not SVG arc paths
- For math functions: use `create_graph`, not SVG

### Infrastructure

- `docker-compose.yml` — Qdrant + backend + agent + optional self-hosted LiveKit
- `backend/Dockerfile`
- `livekit.yaml.example` — template for self-hosted LiveKit config
- Self-hosted LiveKit: `docker compose --profile livekit up -d`, set `LIVEKIT_URL=ws://localhost:7880`

---

## Test Suite

```
backend/tests/
  test_skills.py          — 6 tests, no external deps (100% passing)
  test_formats.py         — 6 tests, no external deps (100% passing)
  test_rag.py             — 6 tests, requires Qdrant + Gemini API (100% passing)
  test_drawing.py         — 20 tests, requires Gemini API (95% passing)
  test_agent_behavior.py  — 4 tests, requires Gemini API + Qdrant
    - tool_call_rate: 10/10 (100%) — search_documents called on every subject question
    - board_image_description: 100%
    - socratic_quality: 80% (questions asked every turn, no full answers given immediately)
    - concurrent_qdrant: known blocker — requires auth for isolation
  run_all.py              — master runner, saves report.json
```

Run:
```bash
python tests/run_all.py --no-drawing   # fast, ~35s
python tests/run_all.py                # full suite
python tests/test_agent_behavior.py    # agent behavior only
```

---

## Building and Running

### Prerequisites
- Docker (for Qdrant)
- Python 3.12+
- Node.js 20+

### Backend
```bash
# 1. Start Qdrant
docker compose up qdrant -d

# 2. Create backend/.env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
GOOGLE_API_KEY=your-gemini-api-key
QDRANT_URL=http://localhost:6333

# 3. Install and run
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload        # FastAPI
python agent.py dev              # Agent worker (separate terminal)
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

---

## Key Files

| File | Purpose |
|------|---------|
| `backend/agent.py` | TabloAgent, all tools, board snapshot handler, session wiring |
| `backend/main.py` | FastAPI routes, document management, learner profile endpoints |
| `backend/learner_memory.py` | Load/save/merge learner profiles |
| `backend/skills_loader.py` | Load skill files, assemble dynamic system prompt |
| `backend/skills/` | Modular agent behavior markdown files |
| `backend/rag/vector_store.py` | Qdrant client wrapper with payload indexes |
| `backend/rag/ingestion.py` | Two-phase async ingestion, concurrent embeddings |
| `backend/rag/retrieval.py` | Hybrid vector + graph retrieval with RRF |
| `backend/rag/orchestrator.py` | Warm-path RAG, source publishing, context injection safety net |
| `backend/rag/diagram_extractor.py` | PDF page rendering, Gemini vision diagram extraction |
| `backend/tests/` | Full automated test suite |
| `frontend/src/components/tablo-workspace.tsx` | Main UI, BoardSnapshotPublisher, command handler |
| `frontend/src/components/document-viewer-panel.tsx` | react-pdf viewer, AI navigation, select-to-ask |
| `frontend/src/components/source-panel.tsx` | RAG source transparency overlay |
| `docker-compose.yml` | Qdrant + backend + agent + optional LiveKit |
| `livekit.yaml.example` | Self-hosted LiveKit config template |

---

## Implementation Guardrails

### Backend
- Model: `google.beta.realtime.RealtimeModel` — note the `beta` namespace
- Model name: `gemini-2.5-flash-native-audio-preview-12-2025` — use dated preview, **not** `latest`
- `AgentSession.start()` requires `agent=Agent(...)` and `room=ctx.room` as keyword
- Plugin reads `GOOGLE_API_KEY` — `GEMINI_API_KEY` is aliased automatically in `agent.py`
- All board drawing through `execute_command` — no separate per-shape tools
- Always use `calculate` tool for arithmetic — never let model guess
- Board vision: `BoardSnapshotPublisher` + `get_board_image` tool — do NOT restore `CanvasVideoPublisher` or `video_input=True`
- RAG: context through `search_documents` tool only — do NOT call `update_instructions` with RAG context
- Skills: agent behavior in `backend/skills/*.md` — do not hardcode in `agent.py`
- Qdrant must be running: `docker compose up qdrant -d`
- `get_board_image` uses a separate Gemini Flash call — does NOT inject into Live session context

### Frontend
- Full-screen board layout — no sidebar descriptions
- `turbopack: {}` in `next.config.ts` — not `webpack` config
- SVG: `fill='none'`, `stroke='black'`, `viewBox` required, under 400 chars, no complex `<path>`
- Board snapshots: unreliable channel, 40% scale, 30KB cap

### Known Production Blockers (pre-auth)
- All users share `tablo_shared` Qdrant collection — documents not isolated between users
- `learner_id` derived from room name — not a real user ID
- CORS only allows localhost — update for deployed domain
- No rate limiting on upload or token endpoints
