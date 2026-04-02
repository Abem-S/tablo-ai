from datetime import UTC, datetime

from fastapi import FastAPI
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
            "voice-shell-next",
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
