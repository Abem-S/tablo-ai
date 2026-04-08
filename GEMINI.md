# GEMINI.md - Tablo Project Context

## Project Overview
Tablo is a **voice-first, board-first** real-time Socratic AI whiteboard designed for collaborative learning. It aims to provide a shared thinking space where an AI tutor (powered by Gemini) guides learners through the Socratic method rather than just providing answers.

## Current Implemented Capabilities
- **Realtime voice loop:** learner audio and AI audio run through LiveKit rooms with a backend-issued token.
- **Live board vision:** the frontend exports the `tldraw` page as image frames, paints them into an offscreen canvas, and publishes that as a LiveKit video track.
- **Gemini visual input:** the agent session is started with `room_io.RoomOptions(video_input=True)`, so Gemini Live can use the board feed during reasoning.
- **Deterministic board drawing:** the backend agent emits `board.command` messages and the frontend applies them directly.
- **Generalized targeting for drawing:** target-aware drawing supports `selection`, `pointer`, `this`, `that`, and `shape:<id>` target refs for more reliable placement.
- **Implemented command families:**
    - Absolute: `create_text`, `create_geo`, `create_arrow`
    - Target-aware: `create_text_on_target`, `create_arrow_between_targets`

### Core Technologies
- **Frontend:** Next.js 16 (App Router), React 19, Tailwind CSS 4, `tldraw` for the whiteboard canvas.
- **Backend (API):** FastAPI for session management, token generation, and board state synchronization.
- **Backend (Agent):** `livekit-agents` with `google-genai` (Gemini 2.5 Flash Native Audio) for real-time speech-to-speech interaction.
- **Real-time Transport:** LiveKit (WebRTC) for audio and data tracks.
- **Orchestration:** LangGraph (planned for complex tutoring policies and RAG).

## Building and Running

### Backend Setup
1.  **Environment Variables:** Create a `.env` file in the `backend/` directory with:
    ```env
    LIVEKIT_URL=<your-livekit-url>
    LIVEKIT_API_KEY=<your-api-key>
    LIVEKIT_API_SECRET=<your-api-secret>
    GOOGLE_API_KEY=<your-gemini-api-key>
    ```
    *Note: `GOOGLE_API_KEY` is required by the LiveKit Google plugin. `GEMINI_API_KEY` alone is not sufficient.*

2.  **Install Dependencies:**
    ```bash
    cd backend
    python -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    ```

3.  **Run FastAPI Server:**
    ```bash
    uvicorn main:app --reload
    ```

4.  **Run LiveKit Agent:**
    ```bash
    python agent.py dev
    ```

### Frontend Setup
1.  **Install Dependencies:**
    ```bash
    cd frontend
    npm install
    ```

2.  **Run Development Server:**
    ```bash
    npm run dev
    ```

    From the workspace root, use:
    ```bash
    npm --prefix frontend run dev
    ```

## Development Conventions & Rules

### Non-Negotiable UX Rules
- **Canvas-First:** The `tldraw` whiteboard must remain the primary surface.
- **Voice-First:** Interaction should prioritize voice and board events. Avoid typical "chatbot" text interfaces.
- **Socratic Tutoring:** The AI must guide, probe, and scaffold—never give final answers too early.

### Backend Implementation Guardrails
- **Agent API:** Using `livekit-agents` v1.5+. `AgentSession.start()` requires `agent=Agent(...)` and `room=ctx.room`.
- **Model:** Use `gemini-2.5-flash-native-audio-preview-12-2025` for the standard Gemini API.
- **Normalization:** The backend acts as the audio normalization boundary between LiveKit (48kHz) and Gemini (16kHz in, 24kHz out).

### Frontend Implementation Guardrails
- **Layout:** Use full-screen or nearly full-screen board layouts. Keep overlays minimal.
- **Next.js:** This project uses Next.js 16 with potential breaking changes. Always check `node_modules/next/dist/docs/` if unsure.

### Architecture Guidelines
- **Hot Path:** Real-time conversation and whiteboard responsiveness (direct Gemini Live loop).
- **Warm Path:** Slower operations like RAG retrieval, tool execution, and memory updates via LangGraph.
- **Interruption:** The system must support interruption; stale board actions from an interrupted turn should be discarded.

## Key Files
- `backend/main.py`: FastAPI routes and session bootstrap.
- `backend/agent.py`: LiveKit agent implementation using Gemini, including board-tool publishing.
- `frontend/src/components/tablo-workspace.tsx`: Main whiteboard UI, board video publisher, board command bridge, and target-resolution logic.
- `AGENTS.md`: Detailed instructions and guardrails for AI agents working on this repo.
- `README.md`: Comprehensive vision and architectural documentation.
