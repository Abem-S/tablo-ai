import os
from datetime import UTC, datetime, timedelta

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


app = FastAPI(
    title="Tablo API",
    description="Day 1 session bootstrap backend for the Tablo workspace.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SessionBootstrapResponse(BaseModel):
    session_id: str
    transport_status: str
    board_status: str
    backend_status: str
    capabilities: list[str]
    checked_at: str


class BoardSnapshotRequest(BaseModel):
    session_id: str
    summary: str
    shape_count: int
    selected_count: int


class BoardSnapshotResponse(BaseModel):
    session_id: str
    board_status: str
    backend_status: str
    summary: str
    shape_count: int
    selected_count: int
    synced_at: str


class RealtimeConfigResponse(BaseModel):
    configured: bool
    livekit_url: str | None
    backend_conversion_boundary: str
    livekit_audio_hz: int
    gemini_input_hz: int
    gemini_output_hz: int
    notes: list[str]


class LiveKitTokenRequest(BaseModel):
    session_id: str
    room_name: str | None = None


class LiveKitTokenResponse(BaseModel):
    server_url: str
    room_name: str
    participant_identity: str
    token: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/session/bootstrap", response_model=SessionBootstrapResponse)
def session_bootstrap() -> SessionBootstrapResponse:
    return SessionBootstrapResponse(
        session_id="day1-local-session",
        transport_status="backend-ready",
        board_status="canvas-ready",
        backend_status="connected",
        capabilities=[
            "whiteboard",
            "session-bootstrap",
            "backend-health",
            "livekit-shell",
            "board-sync",
        ],
        checked_at=datetime.now(UTC).isoformat(),
    )


@app.post("/board/snapshot", response_model=BoardSnapshotResponse)
def board_snapshot(payload: BoardSnapshotRequest) -> BoardSnapshotResponse:
    return BoardSnapshotResponse(
        session_id=payload.session_id,
        board_status="synced",
        backend_status="connected",
        summary=payload.summary,
        shape_count=payload.shape_count,
        selected_count=payload.selected_count,
        synced_at=datetime.now(UTC).isoformat(),
    )


@app.get("/realtime/config", response_model=RealtimeConfigResponse)
def realtime_config() -> RealtimeConfigResponse:
    livekit_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    configured = bool(livekit_url and api_key and api_secret)

    return RealtimeConfigResponse(
        configured=configured,
        livekit_url=livekit_url,
        backend_conversion_boundary="Convert audio between LiveKit and Gemini in the backend agent runtime.",
        livekit_audio_hz=48000,
        gemini_input_hz=16000,
        gemini_output_hz=24000,
        notes=[
            "LiveKit room connection needs a server URL plus a signed participant token.",
            "Gemini Live expects 16-bit PCM mono at 16 kHz in and returns 24 kHz audio out.",
            "Publish browser microphone through LiveKit first; do model-specific resampling on the backend.",
        ],
    )


@app.post("/livekit/token", response_model=LiveKitTokenResponse)
async def livekit_token(payload: LiveKitTokenRequest) -> LiveKitTokenResponse:
    livekit_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    if not livekit_url or not api_key or not api_secret:
        raise HTTPException(
            status_code=503,
            detail=(
                "LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, "
                "and LIVEKIT_API_SECRET in the backend environment."
            ),
        )

    try:
        from livekit import api
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="livekit-api is not installed in the backend environment.",
        ) from exc

    room_name = payload.room_name or "tablo-day2-room"
    participant_identity = f"{payload.session_id}-learner"

    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(participant_identity)
        .with_name("Tablo Learner")
        .with_ttl(timedelta(hours=1))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .to_jwt()
    )

    async with api.LiveKitAPI(livekit_url, api_key, api_secret) as livekit_api:
        try:
            # We must be careful if the room doesn't exist yet it might error or return empty list
            dispatches = await livekit_api.agent_dispatch.list_dispatch(room=room_name)
            already_dispatched = any(d.agent_name == "tablo-assistant" for d in dispatches.items)
        except Exception:
            already_dispatched = False

        if not already_dispatched:
            try:
                await livekit_api.agent_dispatch.create_dispatch(
                    api.CreateAgentDispatchRequest(
                        agent_name="tablo-assistant",
                        room=room_name,
                    )
                )
            except Exception as e:
                print(f"Warning: Failed to dispatch tablo-assistant: {e}")

    return LiveKitTokenResponse(
        server_url=livekit_url,
        room_name=room_name,
        participant_identity=participant_identity,
        token=token,
    )
