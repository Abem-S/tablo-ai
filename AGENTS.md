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
- LiveKit for realtime transport (Cloud or self-hosted open-source)
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

### What is now implemented

#### Voice & Realtime

- **`backend/agent.py`** — a `livekit-agents` v1.5.x worker registered as `tablo-assistant`. On job dispatch it connects to the room, instantiates `google.beta.realtime.RealtimeModel` with `model="gemini-2.5-flash-native-audio-preview-12-2025"`, starts an `AgentSession` with a `TabloAgent` instance, and calls `await session.generate_reply()` to greet the learner.
- **`backend/main.py`** — `/livekit/token` issues a signed participant JWT and dispatches `tablo-assistant` to the room via `livekit_api.agent_dispatch.create_dispatch`.
- **Frontend** — `LiveKitRoom` from `@livekit/components-react` connects with the token from the backend. `RoomAudioRenderer` plays AI audio. `VoiceAssistantControlBar` appears when connected. Mic uses `echoCancellation`, `noiseSuppression`, `autoGainControl`.
- **Key env vars required:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GOOGLE_API_KEY` (the plugin reads `GOOGLE_API_KEY`, not `GEMINI_API_KEY`). `GEMINI_API_KEY` is aliased to `GOOGLE_API_KEY` automatically in `agent.py` if only the former is set.
- **Model note:** use `gemini-2.5-flash-native-audio-preview-12-2025` (dated preview, not `latest`) for stable function-calling support.

#### Board Vision — Triggered Snapshots (replaces continuous video stream)

The continuous video track (`CanvasVideoPublisher`) has been replaced with `BoardSnapshotPublisher`. This eliminates the 2-minute session limit caused by video token burn while preserving full visual awareness.

- **Frontend** — `BoardSnapshotPublisher` sends PNG snapshots via `board.snapshot` LiveKit data topic under three conditions:
  1. Local participant starts speaking → send immediately
  2. Board changes while AI is silent → debounce 1.5s then send
  3. Board changes while AI is speaking → send immediately
- **Agent** — `video_input=False` on `RoomOptions`. Receives `board.snapshot` data messages and stores the latest PNG as `_latest_board_snapshot`.
- **`get_board_image` tool** — agent calls this explicitly when it needs to see the board visually (freehand writing, student drawings, handwritten equations). Injects the stored snapshot into Gemini Live's chat context via `update_chat_ctx`.
- **Do NOT restore the continuous video track** — sessions now run indefinitely. The triggered snapshot approach covers 95%+ of real tutoring interactions.

#### Skills System

Agent behavior is defined in modular markdown files in `backend/skills/`, not hardcoded in `agent.py`:

- `core_teaching.md` — Socratic method, board-first rules, voice style
- `drawing_commands.md` — full execute_command reference with examples
- `document_grounding.md` — when/how to use RAG and diagrams
- `learner_adaptation.md` — how to read and update the learner profile

`backend/skills_loader.py` assembles the dynamic system prompt = skills + learner profile section at session start. Edit a skill file and restart the worker — no code changes needed.

#### Learner Memory

- `backend/learner_memory.py` — per-learner JSON profiles in `backend/data/learner_profiles/`
- `update_learner_profile` tool — agent writes observations mid-session (learning styles, struggle areas, mastered topics, hints that worked)
- Profile loaded at session start, injected into system prompt via `skills_loader.build_system_prompt()`
- Persists across sessions. `learner_id` derived from room name (will be real user ID once auth is added)
- API endpoints: `GET/PATCH/DELETE /learner/{id}/profile`

#### AI Drawing Capabilities

A full AI drawing system on top of the `board.command` data topic. The agent uses a single `execute_command` function tool.

**Agent tools (`backend/agent.py`):**
- `execute_command` — sends any board command as JSON over `board.command`. For `get_board_state`, waits up to 3s for `board.response` reply.
- `get_board_image` — injects the latest board snapshot into Gemini Live context for visual understanding of freehand content.
- `search_documents` — RAG retrieval, result compressed to ≤500 chars.
- `draw_diagram(page_number)` — generates tldraw commands from stored page image via Gemini vision.
- `calculate` — safe Python `eval` for arithmetic.
- `update_learner_profile` — writes learner observations to persistent profile.

**Frontend (`frontend/src/components/tablo-workspace.tsx`):**
- Full command set: text, geometry, SVG, math graphs, parametric graphs, polygons, board state, shape mutation, cleanup, positioning, labels, alignment
- Command validation layer rejects malformed commands with typed error codes
- All commands logged with success/failure status

#### RAG System

- **Vector store:** Qdrant (self-hosted Docker or Qdrant Cloud). `tablo_shared` collection for single-user/open-source mode. Per-user collections (`tablo_{user_id}`) when auth is added.
- **`backend/rag/vector_store.py`** — thin Qdrant wrapper (upsert, search, delete, scroll, payload update)
- **`backend/rag/ingestion.py`** — two-phase ingestion: fast text chunking + background diagram extraction. Diagram page images embedded directly via `gemini-embedding-2` multimodal alongside text chunks.
- **`backend/rag/retrieval.py`** — hybrid vector + knowledge graph search with RRF reranking. Threshold 0.1 (Qdrant cosine scores differ from ChromaDB distances).
- **`backend/rag/orchestrator.py`** — warm-path orchestrator triggered on `user_speech_committed`. Publishes sources to frontend via `tutor.sources`. Does NOT call `update_instructions` — RAG context flows through the `search_documents` tool only.
- **Embedding model:** `gemini-embedding-2` (multimodal, 3072-dim)
- **Generation model:** `gemini-2.5-flash` for concept extraction, query rewriting, context compression, diagram command generation

**Key implementation notes:**
- RAG context injection via `update_instructions` has been removed — it was getting compressed away by the sliding window. The `search_documents` tool is the only RAG path.
- Tool results returned to Gemini Live must be ≤500 chars. Larger results cause 1008/1011 WebSocket disconnects.
- `context_window_compression` is enabled on the RealtimeModel with `trigger_tokens=25000` and `target_tokens=12000`.
- The `google-genai` SDK (not the deprecated `google-generativeai`) is used for all Gemini calls in the RAG pipeline.
- Do NOT use `gemini-2.5-flash-native-audio-latest` — use the dated preview.

#### Document Viewer Panel

- Collapsible panel (📚 tab) overlaid on the right of the canvas
- `react-pdf` renders actual PDF pages at full panel width with prev/next navigation
- AI auto-opens panel, jumps to correct page, highlights referenced excerpt in PDF text layer
- Select text → "Ask AI about this" floating tooltip → sends via `learner.context` LiveKit topic → agent prepends to next `search_documents` query
- Text/image/HTML viewers for non-PDF formats
- `learner.context` is consumed once per `search_documents` call, then cleared

#### LiveKit — Cloud and Self-Hosted

- **Cloud (default):** set `LIVEKIT_URL=wss://your-project.livekit.cloud` in `backend/.env`
- **Self-hosted (open-source):** `docker compose --profile livekit up -d`. Copy `livekit.yaml.example` to `livekit.yaml`, set matching API key/secret, set `LIVEKIT_URL=ws://localhost:7880`.
- Same codebase works with both — only `LIVEKIT_URL` differs.
- `livekit.yaml` is gitignored (contains credentials).

#### Infrastructure

- `docker-compose.yml` — Qdrant + backend + agent worker + optional self-hosted LiveKit
- `backend/Dockerfile`
- `livekit.yaml.example` — template for self-hosted LiveKit config

## Frontend Implementation Guardrails

- Prefer full-screen or nearly full-screen board layouts.
- Keep overlays minimal and purposeful.
- The sidebar with "Realtime status", "Session readiness", "LiveKit setup" descriptions has been removed — do not re-add it.
- If status surfaces exist, they should reflect real system state.
- Do NOT restore `CanvasVideoPublisher` or `video_input=True` — use `BoardSnapshotPublisher`.

## Backend Implementation Guardrails

- Prefer small, honest endpoints over fake AI behavior that does not belong in the product.
- LiveKit + Gemini Live voice is **now working** — do not regress it.
- Board snapshot system is now working — do not regress it or restore the continuous video track.
- The full AI drawing command set is now working — do not regress it.
- Skills system is now working — agent behavior goes in `backend/skills/*.md`, not hardcoded in `agent.py`.
- Learner memory is now working — use `update_learner_profile` tool, not ad-hoc state.
- `livekit-agents` worker must be run separately from FastAPI: `python agent.py dev`.
- `AgentSession.start()` in v1.5+ requires `agent=Agent(...)` as the first positional arg and `room=ctx.room` as a keyword.
- The plugin env var is `GOOGLE_API_KEY`. `GEMINI_API_KEY` alone is not read by the plugin (though `agent.py` aliases it automatically).
- The agent uses `google.beta.realtime.RealtimeModel` — note the `beta` namespace.
- The `execute_command` tool is the single entry point for all board drawing. Do not add separate per-shape tools.
- The `calculate` tool must be used for all arithmetic — never let the model guess math.
- Qdrant must be running before starting the backend or agent: `docker compose up qdrant -d`.

## Agent Behavior for This Repo

When making changes:

1. Read the local Next.js docs before changing App Router behavior.
2. Check the README architecture before making product-shaping decisions.
3. Keep temporary development scaffolding explicitly temporary.
4. If unsure whether a UI element is meant to be final product UX, assume it is **not** unless it fits the voice-first, board-first direction.
5. Prefer honest progress over flashy but misleading demos.
