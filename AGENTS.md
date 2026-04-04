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

- **`backend/agent.py`** — a `livekit-agents` v1.5.x worker registered as `tablo-assistant`. On job dispatch it connects to the room with `AutoSubscribe.AUDIO_ONLY`, instantiates `google.realtime.RealtimeModel` with `model="gemini-2.5-flash-native-audio-preview-12-2025"`, starts an `AgentSession` with an `Agent` instance, and calls `await session.generate_reply()` to greet the learner.
- **`backend/main.py`** — `/livekit/token` issues a signed participant JWT and dispatches `tablo-assistant` to the room via `livekit_api.agent_dispatch.create_dispatch`.
- **Frontend** — `LiveKitRoom` from `@livekit/components-react` connects with the token from the backend. `RoomAudioRenderer` plays AI audio. `VoiceAssistantControlBar` appears when connected.
- **Key env vars required:** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GOOGLE_API_KEY` (the plugin reads `GOOGLE_API_KEY`, not `GEMINI_API_KEY`).
- **Model note:** `gemini-live-2.5-flash-native-audio` is Vertex AI only. The standard Gemini API key model name is `gemini-2.5-flash-native-audio-preview-12-2025`.

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
- `livekit-agents` worker must be run separately from FastAPI: `python agent.py dev`.
- `AgentSession.start()` in v1.5+ requires `agent=Agent(...)` as the first positional arg and `room=ctx.room` as a keyword — not `session.start(ctx.room)`.
- The plugin env var is `GOOGLE_API_KEY`. `GEMINI_API_KEY` alone is not read by the plugin.

## Agent Behavior for This Repo

When making changes:

1. Read the local Next.js docs before changing App Router behavior.
2. Check the README architecture before making product-shaping decisions.
3. Keep temporary development scaffolding explicitly temporary.
4. If unsure whether a UI element is meant to be final product UX, assume it is **not** unless it fits the voice-first, board-first direction.
5. Prefer honest progress over flashy but misleading demos.
