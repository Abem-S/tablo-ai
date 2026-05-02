# TABLO 🎨🧠
**Real-time Socratic AI Whiteboard for Collaborative Learning**

Tablo is an interactive educational platform where learning is not a chat, but a shared thinking space. Built for **UN SDG 4 (Quality Education)**, Tablo is designed as a multimodal AI co-thinker that can see sketches, hear questions, retrieve source material, and guide learners through the Socratic method.

## 🚀 The Vision

Most AI tutors optimize for speed of answer.

Tablo optimizes for **quality of understanding**.

Instead of acting like a chatbot beside the lesson, Tablo should be able to:

- listen to the learner in real time
- see what the learner has drawn, labeled, or erased
- reason over a shared visual workspace
- retrieve grounded knowledge from textbooks and lesson materials
- use tools for precise scientific or mathematical reasoning
- remember what happened in the session and what matters across sessions
- respond with hints, prompts, counter-questions, and visual guidance

The core product idea is simple:

**the AI should not just answer on top of the board, it should think with the learner on the board.**

## 🚀 Quick Start (Local Docker)

The easiest way to run the entire stack locally (Frontend, Backend, AI Agent, Qdrant, and Local LiveKit) is to use the provided setup script. You only need a Google Gemini API Key.

```bash
git clone https://github.com/YOUR-USERNAME/tablo-ai.git
cd tablo-ai
./start.sh
```
The script will prompt for your API key, generate the `.env` files, and spin everything up via Docker Compose. Once running, open `http://localhost:3000` in your browser.

---

## 🛠️ The 2026 Tech Stack

- **Frontend:** Next.js 16 (App Router), React 19, Tailwind 4, `tldraw`
- **Backend:** FastAPI, LangGraph, Google Gen AI SDK
- **Realtime Transport:** LiveKit for WebRTC audio, video, and data transport
- **Intelligence:** Gemini Live API for low-latency multimodal sessions
- **Tools:** MCP-compatible tool layer and deterministic educational tools
- **Memory:** session memory, persistent learner memory, and multimodal RAG

### Repo Foundation

The current repository already has the core foundation for this direction:

- `frontend/` for the Next.js client and whiteboard UX
- `backend/` for FastAPI and orchestration logic
- `tldraw` installed on the frontend
- `fastapi`, `langgraph`, and `google-genai` declared for the backend

## 🏛️ Architectural Principles

Tablo’s architecture works best when it follows these principles:

1. **Realtime first:** voice, board events, and AI responses must feel interruptible and low-latency.
2. **Canvas first:** the whiteboard is the primary learning surface, not a decorative extra.
3. **Socratic by design:** the tutor should guide, probe, and scaffold before giving final answers.
4. **Grounded by default:** retrieval, memory, and tools should support correctness and continuity.
5. **Hot path vs. warm path:** immediate conversational response should stay fast, while retrieval, tools, and memory orchestration can enrich responses asynchronously.
6. **Model-swappable intelligence layer:** the architecture should depend on a Live multimodal API pattern, not on a single frozen model version string.

## 🧠 Feature Architecture

This is the architecture broken down by major capability so each feature has a clear place in the system.

### 1. Canvas Workspace Architecture

The frontend should be a board-first learning environment built around `tldraw`.

```
[Learner]
    |
    v
[Next.js Client]
    |
    +--> [tldraw Canvas]
    |      - freehand drawing
    |      - text labels
    |      - arrows / diagrams
    |      - region selection
    |
    +--> [Tutor Panel]
    |      - ask question
    |      - choose mode
    |      - review hints
    |
    +--> [Session UI State]
           - active board
           - selected objects
           - current topic
```

**Responsibilities**

- capture whiteboard state and interaction events
- stream visual context to the backend
- render tutor text, highlights, and future board actions
- support mode switching between hinting, explaining, and questioning

### 2. Realtime Voice and Transport Architecture

This is the live conversation layer that makes Tablo feel natural instead of turn-based.

LiveKit is a strong fit here because it provides a production-grade WebRTC SFU built around **rooms, participants, and tracks**, and it also supports realtime **data packets / streams** alongside media. That makes it a good transport layer for carrying:

- learner microphone audio
- future camera or screen-sharing tracks
- board events and whiteboard deltas
- AI audio responses
- structured control messages such as interruption, tutor mode changes, and board-action events

```
+-----------------------------+         +----------------------------+         +--------------------------------------+         +-----------------------------+
|      User Client            |         |      LiveKit Server        |         |          Backend Service             |         |       Gemini Live API       |
| (Next.js, tldraw, React)    |         |   (WebRTC SFU + Rooms)     |         | (FastAPI + LiveKit SDK + LangGraph)  |         |    (Bidirectional session)  |
+-----------------------------+         +----------------------------+         +--------------------------------------+         +-----------------------------+
              |                                      |                                           |                                            |
 1. Join room --------------------------------------------------------------->                   |                                            |
              |                                      |                                           |                                            |
              |<-------------------------------------+ 2. Backend AI agent joins as participant |                                            |
              |                                      |                                           |                                            |
 3. Publish tracks / data                            |                                           |                                            |
    - microphone audio ----------------------------->|                                           |                                            |
    - optional video/screen ------------------------>|                                           |                                            |
    - board deltas / cursor / selections ----------->|                                           |                                            |
    - tutor control events ------------------------->|                                           |                                            |
              |                                      | 4. Forward subscribed tracks/data ------->|                                            |
              |                                      |                                           |                                            |
              |                                      |                                           | 5. Session assembler                       |
              |                                      |                                           |    - decode / normalize audio             |
              |                                      |                                           |    - accumulate board state               |
              |                                      |                                           |    - map data topics to actions           |
              |                                      |                                           |    - maintain turn/session identifiers    |
              |                                      |                                           |                                            |
              |                                      |                                           | 6. Stream input to Gemini Live ---------->|
              |                                      |                                           |    - PCM audio                            |
              |                                      |                                           |    - text turns / system instructions     |
              |                                      |                                           |    - optional visual context metadata     |
              |                                      |                                           |                                            |
              |                                      |                                           |<----------- 7. Receive server events -----|
              |                                      |                                           |            - audio chunks                 |
              |                                      |                                           |            - text / transcriptions        |
              |                                      |                                           |            - interrupted / turn_complete  |
              |                                      |                                           |            - function/tool calls          |
              |                                      |                                           |                                            |
              |                                      |                                           | 8. Publish AI outputs back to room        |
              |<-------------------------------------+------------------------------------------|    - AI audio track                        |
              |                                      |                                           |    - tutor text/data events               |
              |                                      |                                           |    - board-action payloads                |
 9. Render audio, tutor responses, and board actions |                                           |                                            |
```

**Why this architecture fits**

- WebRTC is built for realtime media, not request-response polling.
- LiveKit rooms give a clean abstraction for user plus AI participation.
- Tracks handle media while data packets or higher-level streams handle board updates and tutor control events.
- Gemini Live supports low-latency bidirectional sessions with interruption support, which matches Tablo’s conversational goals well.
- The same room can carry audio and board-related data events together without inventing a separate custom realtime transport.

### 2.1 Transport Roles and Message Types

The transport layer becomes much easier to implement if each kind of data has a clear lane.

| Channel | Transport | Producer | Consumer | Purpose |
| --- | --- | --- | --- | --- |
| Learner audio | LiveKit audio track | Browser | Backend agent | realtime speech input |
| AI audio | LiveKit audio track | Backend agent | Browser | spoken tutor response |
| Board events | LiveKit data packets or text stream | Browser | Backend agent | shape deltas, selections, cursor intent |
| Tutor events | LiveKit data packets or text stream | Backend agent | Browser | hints, board commands, status updates |
| Model session | Gemini Live bidirectional session | Backend agent | Gemini | multimodal reasoning loop |

**Recommended event topics**

- `board.delta`
- `board.selection`
- `board.cursor`
- `tutor.status`
- `tutor.message`
- `tutor.board_action`
- `session.interrupt`
- `session.mode_change`

### 2.2 Interruption and Turn Control

Interruption is one of the most important parts of the architecture.

Gemini Live’s official behavior supports interruption: when new client activity arrives, current generation can be interrupted and discarded, and the server reports interruption state. Tablo should take advantage of that explicitly.

```
[Learner starts speaking again]
            |
            v
[Browser VAD or server VAD detects activity]
            |
            v
[Backend marks current AI turn as interrupted]
            |
            +--> stop local audio playback queue
            +--> stop publishing stale board actions
            +--> forward new user activity into Gemini Live
            |
            v
[Gemini Live interrupted -> new turn begins]
```

**Design rule**

Any board action that belongs to an interrupted tutor turn should be tagged with a turn ID and dropped if that turn is canceled. This prevents the whiteboard from being updated by stale AI reasoning after the learner has already changed direction.

### 2.3 Audio Normalization Boundary

Gemini Live expects specific audio formats, so the backend should be the normalization boundary between LiveKit transport and model I/O.

```
[LiveKit audio track]
        |
        v
[Backend audio adapter]
 - decode incoming transport format
 - normalize to model input format
 - chunk into session-friendly frames
        |
        v
[Gemini Live input stream]

[Gemini Live output audio]
        |
        v
[Backend output adapter]
 - buffer / packetize
 - publish to LiveKit AI track
        |
        v
[Browser playback]
```

**Why keep this in the backend**

- it isolates model-specific audio requirements from the browser
- it makes model changes easier later
- it provides a clean place for transcription, logging, and future audio effects

### 2.4 LangGraph’s Place in the Live Loop

LangGraph should not sit in front of every audio frame. It should sit beside the live session and operate on meaningful turn-level events.

```
[Realtime session events]
        |
        +--> audio chunks -> Gemini Live directly
        |
        +--> turn_complete / transcript / board snapshot
                  |
                  v
          [LangGraph orchestration]
                  |
                  +--> retrieve context
                  +--> call tools
                  +--> read/write memory
                  +--> update tutor policy state
                  |
                  v
          [Inject enriched context into subsequent live turns]
```

**This separation matters because**

- audio transport needs millisecond-level responsiveness
- retrieval and tool use are slower and should not block the live media loop
- LangGraph is best used for decisioning, enrichment, and state transitions rather than raw media transport

### 2.5 Implementation-Ready Backend Breakdown

A clean backend split for this architecture is:

```
[FastAPI API Layer]
    |
    +--> session/token endpoints
    +--> tutor configuration endpoints
    +--> source / memory management endpoints
    |
    v
[Realtime Agent Runtime]
    |
    +--> LiveKit room participant
    +--> Gemini Live session manager
    +--> board event accumulator
    +--> turn/interruption coordinator
    +--> response publisher
    |
    v
[LangGraph Intelligence Layer]
    |
    +--> Socratic policy graph
    +--> RAG router
    +--> tool router
    +--> memory manager
```

This keeps transport responsibilities, API responsibilities, and intelligence responsibilities separate enough to evolve without turning the backend into one monolith.

### 3. Socratic Tutor Architecture

The tutoring engine is not only a model call. It is a behavioral layer that controls how Tablo teaches.

```
[Learner question + board context]
               |
               v
[Tutor policy]
 - detect current understanding
 - choose response depth
 - decide whether to hint, ask, explain, or correct
 - avoid giving final answer too early
               |
               v
[Structured tutoring response]
 - guiding question
 - hint
 - short explanation
 - correction
 - next board action
```

**Responsibilities**

- apply the Socratic method consistently
- adapt to what is already on the board
- produce responses that are pedagogically useful, not just factually correct
- return outputs that can be rendered as text, voice, or board guidance

### 4. LangGraph Orchestration Architecture

LangGraph should sit behind the tutor API as the decision engine that routes each turn.

```
[Prompt + transcript + board state]
                |
                v
[LangGraph Tutor Orchestrator]
                |
                +--> [Direct tutoring path]
                +--> [RAG path]
                +--> [Tool path]
                +--> [Memory read/write path]
                |
                v
[Context assembler]
                |
                v
[Final response composer]
```

**Responsibilities**

- decide which capability is needed on each turn
- keep system behavior modular and inspectable
- support future branching, retries, and human review loops
- unify direct model reasoning with retrieval, memory, and tools

## 🧠 Multimodal RAG Architecture

Tablo needs a retrieval system that is built for learning materials, not just plain text snippets. That means supporting paragraphs, diagrams, tables, formulas, and document structure.

### Phase 1: Offline Ingestion Pipeline

```
[Source PDF / textbook / notes]
              |
              v
[OCR / parsing layer]
              |
              +--> extract text blocks
              +--> extract figures / tables / formulas
              +--> preserve page and section metadata
              |
              v
[Chunking + enrichment]
 - parent chunks
 - child chunks
 - captions / summaries for visual assets
 - subject / topic / grade metadata
              |
              v
[Indexes]
 - vector store
 - keyword/BM25 index
 - object storage for heavy assets
 - source metadata store
```

### Phase 2: Realtime Retrieval Pipeline

```
[Learner question + board state + session context]
                    |
                    v
[Query understanding]
 - rewrite the query
 - infer topic and intent
 - summarize relevant board region
                    |
                    v
[Hybrid retrieval]
 - semantic search
 - keyword search
 - metadata filtering
                    |
                    v
[Reranker]
                    |
                    v
[Grounding bundle]
 - answer chunk
 - surrounding context
 - figure/table references
 - citations
```

**Why this matters**

- students ask messy, incomplete, multimodal questions
- educational content often depends on nearby diagrams or formulas
- the tutor should be able to say not just the answer, but where the answer comes from

## 🛠️ MCP and Tool-Use Architecture

Tablo should not rely on free-form generation when a deterministic tool is safer or clearer.

```
[User turn]
    |
    v
[Tool plausibility check]
    |
    +--> no  ---> [Direct tutor response]
    |
    +--> yes ---> [LangGraph tool router]
                     |
                     +--> [Math solver]
                     +--> [Scientific calculator]
                     +--> [Symbolic reasoning]
                     +--> [Reference lookup]
                     +--> [Future simulation/diagram tools]
                     |
                     v
                [Structured tool result]
                     |
                     v
                [Tutor explanation layer]
```

**Design goals**

- structured tool outputs first, natural-language explanation second
- safe execution and explicit error handling
- cacheable results for repeated educational queries
- outputs that can become board annotations or worked steps

## 🧠 Session and Persistent Memory Architecture

Memory should exist at two levels: what matters right now in the live lesson, and what should persist about the learner across sessions.

### Session Memory

```
[Live turn]
    |
    +--> [Recent turns buffer]
    +--> [Board summary]
    +--> [Current topic / subproblem]
    +--> [Detected misconceptions]
    |
    v
[Next-turn context package]
```

**Session memory should track**

- active problem
- recent hints already given
- learner’s current line of reasoning
- important entities, formulas, and visual landmarks on the board

### Persistent Memory

```
[Long-term learner memory]
            |
            +--> [Profile store]
            |      - grade level
            |      - preferences
            |      - course context
            |
            +--> [Progress memory]
            |      - mastered topics
            |      - recurring struggles
            |      - prior lessons
            |
            +--> [Semantic memory index]
                   - embedded memory notes
                   - searchable learning history
```

**Persistent memory should support**

- personalization across sessions
- recall of prior struggles and strengths
- continuity between lessons
- explicit learner- or teacher-controlled memory updates

## 🌐 Full System Architecture (Integrated)

The cleanest overall architecture for Tablo is a dual-path system:

- a **hot path** for live conversation and whiteboard responsiveness
- a **warm path** for retrieval, memory, and tool enrichment

```
+--------------------------+           +--------------------------+           +---------------------------------+           +-----------------------+
|        User Client       |           |      LiveKit Server      |           |         Backend Service         |           |   External Services   |
| (Next.js, tldraw, React) |           |   (WebRTC SFU + Rooms)   |           |   (FastAPI + LangGraph Agent)   |           |   Models / DB / APIs  |
+--------------------------+           +--------------------------+           +---------------------------------+           +-----------------------+
             |                                   |                                          |                                      |
             | 1. User audio / board events ---->|                                          |                                      |
             |                                   | 2. Forward realtime streams ------------->|                                      |
             |                                   |                                          |                                      |
             |                                   |                                          |   HOT PATH                           |
             |                                   |                                          |   - normalize media                  |
             |                                   |                                          |   - assemble board context           |
             |                                   |                                          |   - stream to Gemini Live API ------>| 
             |                                   |                                          |<-------------------------------------|
             |                                   |                                          |   - receive audio / text / events    |
             |<----------------------------------| 3. Publish AI media/data back -----------|                                      |
             |                                   |                                          |                                      |
             |                                   |                                          |   WARM PATH                          |
             |                                   |                                          |   - LangGraph orchestration          |
             |                                   |                                          |   - RAG retrieval ------------------>| 
             |                                   |                                          |   - Tool execution ----------------->| 
             |                                   |                                          |   - Memory hydration / updates ---->| 
             |                                   |                                          |<-------------------------------------|
             |                                   |                                          |   - inject enriched context          |
             |                                   |                                          |     into subsequent live turns       |
```

### How the Two Paths Work Together

**Hot path**

- keeps the live interaction responsive
- handles realtime media and fast conversational turns
- supports interruption and immediate feedback
- handles track subscription, playback control, and immediate session signaling

**Warm path**

- fetches retrieval context
- calls tools
- updates and hydrates memory
- improves later turns without stalling the whole conversation loop
- feeds enriched instructions, tool results, and memory summaries back into the live tutor state

This gives Tablo the feel of a fast live tutor while still allowing deep reasoning and grounding behind the scenes.

## 🔮 Gemini Live Model Strategy

Tablo should be designed against the **Gemini Live API pattern**, not against one brittle model name.

Current official Gemini Live documentation emphasizes low-latency two-way voice and video interaction, including interruption support, with current Live variants such as the `gemini-live-2.5-flash` family. That means the Tablo architecture should:

- keep the model interface abstracted behind the backend
- treat the Live model as a swappable runtime dependency
- preserve the same orchestration pattern even when model versions change

That is the right way to keep the architecture future-ready while staying technically correct.

## 🏗️ 30-Day Build Log

This should read as an execution plan for the architecture above, not just as a loose milestone list.

### Week 1: Realtime Foundation and Whiteboard Core

**Goal:** establish the basic live learning surface.

- build the Next.js workspace shell
- integrate `tldraw`
- create the first FastAPI health and session-bootstrap endpoints
- define the shared session bootstrap schema between frontend and backend
- establish board-state capture and workspace/session readiness
- prepare the project structure for LiveKit and multimodal events

**End of week result:** a learner can open a full-screen board workspace, verify backend session readiness, and stand on the correct shell for the upcoming live voice loop.

**Day 1 UX note:** the first slice should validate the board shell and realtime session boundary, not introduce temporary product flows that do not belong in the final experience.

### Day 2: LiveKit + Gemini Live Voice Loop ✅ Shipped

**Goal:** replace flaky browser speech APIs with a real voice transport and AI voice backend.

What shipped:

- **`backend/agent.py`** — `livekit-agents` v1.5.x worker registered as `tablo-assistant`. Connects to the dispatched room, instantiates `google.beta.realtime.RealtimeModel` with `model="gemini-2.5-flash-native-audio-preview-12-2025"` (use the dated preview, not `latest`), starts an `AgentSession`, and greets the learner via `await session.generate_reply()`.
- **`backend/main.py`** — `/livekit/token` issues a signed participant JWT and dispatches `tablo-assistant` to the room via `livekit_api.agent_dispatch.create_dispatch`.
- **Frontend** — `LiveKitRoom` connects using the backend-issued token. `RoomAudioRenderer` plays AI voice audio. `VoiceAssistantControlBar` appears when connected. Mic uses `echoCancellation`, `noiseSuppression`, `autoGainControl`.
- **Key env vars:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GOOGLE_API_KEY`. `GEMINI_API_KEY` is aliased automatically in `agent.py`.

### Board Vision — Triggered Snapshots ✅ Shipped

The continuous video track has been replaced with `BoardSnapshotPublisher` — eliminating the 2-minute session limit while preserving full visual awareness.

- Frontend sends PNG snapshots (40% scale, 30KB cap, unreliable channel) via `board.snapshot` data topic on three triggers: user starts speaking, board changes while AI is silent (1.5s debounce), board changes while AI is speaking (immediate).
- Agent stores the latest snapshot as `_latest_board_snapshot`.
- `get_board_image` tool — agent calls this explicitly to see the board. Uses a separate `gemini-2.5-flash` call (with `flash-lite` fallback) to describe the PNG and returns a text description. Does NOT inject into Live session context (that caused 1008 disconnects).
- Sessions now run indefinitely. `video_input=False` on `RoomOptions`.

### Skills System ✅ Shipped

Agent behavior is defined in modular markdown files in `backend/skills/`, not hardcoded in `agent.py`:

- `core_teaching.md` — Socratic method, **MANDATORY TOOL CALL SEQUENCE** (numbered steps, NEVER skip), board-first rules
- `drawing_commands.md` — full execute_command reference with SVG rules (under 400 chars, no complex paths)
- `document_grounding.md` — when/how to use RAG and diagrams
- `learner_adaptation.md` — how to read and update the learner profile
- `backend/skills_loader.py` assembles the dynamic system prompt = skills + learner profile at session start
- Edit a skill file and restart the worker — no code changes needed

### Learner Memory ✅ Shipped

- Per-learner JSON profiles in `backend/data/learner_profiles/`
- `update_learner_profile` tool — agent writes observations mid-session (learning styles, struggle areas, mastered topics, hints that worked)
- Profile loaded at session start, injected into system prompt
- Persists across sessions
- API: `GET/PATCH/DELETE /learner/{id}/profile`

### LiveKit Self-Hosted Support ✅ Shipped

- `docker compose --profile livekit up -d` starts an open-source LiveKit server
- `livekit.yaml.example` template provided
- Switch between Cloud and self-hosted via `LIVEKIT_URL` env var only — zero code changes

### AI Drawing Capabilities ✅ Shipped

A full AI drawing system has been built on top of the `board.command` data topic. The agent exposes a single `execute_command` function tool and a `calculate` tool. The frontend validates, parses, and applies commands directly to `tldraw`.

**Complete command set:**

| Category | Commands |
| --- | --- |
| Text | `create_text`, `create_multiline_text`, `create_text_near_selection`, `create_formula`, `create_text_on_target` |
| Geometry | `create_geo`, `create_arrow`, `create_arrow_between_targets`, `create_freehand`, `create_freehand_stroke` |
| SVG | `create_svg` — agent writes raw SVG; frontend embeds it as a custom tldraw shape |
| Math graphs | `create_graph` — agent provides expressions; frontend evaluates with `mathjs` and renders an accurate canvas plot |
| Parametric graphs | `create_parametric_graph` — agent provides `exprX`/`exprY` as functions of `t` |
| Regular polygons | `create_polygon` — mathematically precise n-gons and stars by circumradius |
| Board state | `get_board_state`, `get_shape_info`, `match_shapes` |
| Shape mutation | `update_shape`, `delete_shape`, `undo` |
| Cleanup | `clear_board`, `clear_shapes`, `clear_region` |
| Positioning | `get_position_info`, `calculate_position`, `get_distance`, `suggest_placement`, `place_with_collision_check` |
| Labels | `create_side_label` (normal / inverted / side-inverted placement relative to a shape edge) |
| Alignment | `snap_to_grid`, `snap_bounds_to_grid`, `align_shapes` |

The frontend also includes a command validation layer that rejects malformed commands with typed error codes before execution, and logs all commands with success/failure status.

### RAG with Source Transparency and Diagram-Aware Ingestion ✅ Shipped

A full hybrid RAG pipeline is implemented in `backend/rag/`:

- **Vector store:** Qdrant (self-hosted Docker or Qdrant Cloud). `tablo_shared` collection for single-user/open-source mode. Per-user collections (`tablo_{user_id}`) when auth is added. Payload indexes on `doc_id`, `page_number`, `chunk_index` for fast filtering.
- **Hybrid retrieval:** vector search (Qdrant + `gemini-embedding-2`, 3072-dim multimodal embeddings) + knowledge graph traversal, fused with Reciprocal Rank Fusion. Threshold 0.1.
- **Async ingestion:** `POST /documents/upload` returns immediately with `status: "processing"`. All ingestion (parse → chunk → embed → store) runs in background. Concurrent embeddings with semaphore(5).
- **Diagram extraction:** PDF pages rendered to PNG via PyMuPDF, sent to Gemini 2.5 Flash vision to extract diagram descriptions and store page images as base64. Diagram images also embedded directly via `gemini-embedding-2` multimodal for visual retrieval.
- **On-demand diagram drawing:** `draw_diagram(page_number)` tool fetches the stored page image and generates accurate tldraw commands from the actual visual.
- **Context compression:** `search_documents` result compressed to ≤500 chars via `gemini-2.5-flash` (fallback: `gemini-2.5-flash-lite`) before returning to Gemini Live, preventing 1008/1011 WebSocket disconnects.
- **Source transparency:** retrieved sources published to frontend via `tutor.sources` LiveKit data topic; `SourcePanel` component shows document name, page, section, and relevance.
- **RAG injection:** context flows through the `search_documents` tool only. The warm-path orchestrator also injects context via `update_instructions` as a safety net — even if the model skips the tool call, the student gets RAG-grounded responses.
- **Tool call reliability:** 100% measured across 10 subject-matter questions with the numbered-steps system prompt.

### Multi-Format Document Viewer Panel ✅ Shipped

A document viewer panel alongside the whiteboard, supporting 17 file formats with AI-triggered source navigation.

- `backend/rag/parsers.py` — per-format text extraction for docx, pptx, rtf, images (Gemini vision), xlsx/xls, csv/tsv, html, doc/hwp.
- File serving: `GET /documents/{doc_id}/file` (raw bytes) and `GET /documents/{doc_id}/text` (extracted text as JSON).
- `tutor.sources` payload includes `navigate_to` field for AI-triggered page navigation.
- `learner.context` LiveKit data topic for learner-to-agent context sharing.
- `react-pdf` renders actual PDF pages with prev/next navigation and text layer highlighting.
- AI auto-opens panel, jumps to correct page, highlights referenced excerpt.
- Select text in viewer → "Ask AI about this" floating tooltip → sends via `learner.context` → agent prepends to next `search_documents` query.

### Automated Test Suite ✅ Shipped

A comprehensive automated test suite in `backend/tests/` covering all major system components.

```bash
cd backend && python tests/run_all.py --no-drawing   # fast, ~35s, no Gemini API needed
cd backend && python tests/run_all.py                # full suite including drawing
python tests/test_calculate.py                       # safe math eval (no external deps)
python tests/test_compression.py                     # RAG compression (no external deps)
```

| Suite | Tests | Score | Notes |
|-------|-------|-------|-------|
| Skills | 6/6 | 100% | No external deps |
| Formats | 6/6 | 100% | No external deps |
| Calculate | 10/10 | 100% | No external deps — safe eval, edge cases, injection rejection |
| Compression | 5/5 | 100% | No external deps — max_chars, truncation, diagram hints |
| RAG | 6/6 | 100% | Requires Qdrant + Gemini |
| Drawing | 19/20 | 95% | 20 diagrams across 5 domains |
| Agent — tool call rate | 9-10/10 | 90-100% | search_documents called on subject questions |
| Agent — board image | 1/1 | 100% | |
| Agent — Socratic quality | 1/1 | 80% | Questions every turn, no full answers given immediately |

### Safe Math Evaluator ✅ Shipped

`backend/math_eval.py` — replaces unsafe `eval()` in the `calculate` tool with `asteval`.

- `evaluate_expression(expr)` — sandboxed evaluator, only math functions exposed
- `MathEvaluationError` — raised on invalid/unsafe input
- 200-character hard cap to prevent DoS
- Rejects `__import__`, `exec`, `eval`, and all non-math operations
- Supports: arithmetic, trig, sqrt, log, factorial, pi, e, `^` as exponent

### Secrets & Config ✅ Shipped

`backend/config.py` — `get_env(name)` reads secrets in priority order:

1. `{NAME}_FILE` — Docker secrets / Kubernetes secrets file path
2. Environment variable
3. HashiCorp Vault (if `VAULT_ADDR` + `VAULT_TOKEN` set, uses `hvac`)

All `os.getenv()` calls for secrets replaced with `get_env()` throughout the codebase. `secrets/` directory contains a README explaining the expected files — actual secret files are gitignored.

### Observability & Metrics ✅ Shipped

`backend/observability.py` — Prometheus metrics, OpenTelemetry tracing, agent health server.

**Prometheus metrics:**
- `tablo_http_requests_total` / `tablo_http_request_latency_seconds` — API layer
- `tablo_agent_tool_calls_total` / `tablo_agent_tool_errors_total` / `tablo_agent_tool_latency_seconds` — per tool
- `tablo_rag_retrieval_latency_seconds` / `tablo_rag_retrieval_errors_total` — RAG pipeline
- `tablo_rag_compression_latency_seconds` / `tablo_rag_compression_truncations_total` — context compression
- `tablo_agent_up` — agent health gauge

**Endpoints:**
- `GET /metrics` on FastAPI — Prometheus scrape endpoint
- Agent worker exposes `/health` + `/metrics` on port 9091 (configurable via `AGENT_METRICS_PORT`)

**Tracing:** OpenTelemetry spans on every tool call. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to export to Jaeger/Tempo/etc.

**Observability stack** (`observability/`): Prometheus config, Grafana dashboards, Loki log aggregation, Promtail, alerting rules.

### CI/CD ✅ Shipped

`.github/workflows/ci.yml` — runs `python tests/run_all.py --no-drawing` on every push and pull request.

### Qdrant Backup Scripts ✅ Shipped

`backend/scripts/`:
- `qdrant_snapshot.py` — create a Qdrant collection snapshot
- `qdrant_restore.py` — restore from snapshot
- `qdrant_migrate.py` — migrate data between collections

### Week 2: Socratic Interaction and Live Tutor Layer ✅ Shipped

**Goal:** make the product behave like a tutor, not just an interface.

- implement Socratic response policies
- add LangGraph routing for direct tutor responses
- structure outputs into hints, questions, next steps, and board-aware guidance
- start the live transport layer for future voice streaming
- define interruption behavior and event contracts

**End of week result:** Tablo can guide the learner in a board-aware, pedagogically coherent way.

### Week 3: Retrieval, Tools, and Grounding ✅ Shipped

**Goal:** make the tutor trustworthy and context-rich.

- add ingestion for lesson materials
- implement hybrid retrieval
- connect retrieval outputs into the orchestration graph
- add one or more deterministic tools for math/science help
- start citation-aware grounded responses

**End of week result:** Tablo can answer with source-backed context and tool-assisted reasoning.

### Week 4: Memory, Voice Completion, and Demo Readiness ✅ Shipped

**Goal:** bring continuity and polish to the full experience.

- add session memory and context summarization
- define persistent learner memory structure
- connect the live voice loop more tightly to the tutoring system
- refine tutor UI states, loading, errors, and interaction feedback
- prepare a stable MVP demo that shows the whole architecture direction

**End of week result:** Tablo demonstrates the full product story: live whiteboard, Socratic tutoring, grounding, tools, and memory-aware continuity.

## ✅ Summary

Tablo’s architecture should be described in two ways at the same time:

- **per feature:** canvas workspace, voice transport, Socratic tutoring, orchestration, RAG, tools, session memory, and persistent memory
- **as one whole system:** a realtime multimodal whiteboard tutor where the frontend, LiveKit transport, FastAPI backend, LangGraph orchestrator, Gemini Live model, retrieval stack, tool layer, and memory systems all work together

That is the version of the README that best matches the product ambition.

---
*Built with ❤️ for a smarter, more inclusive future.*
