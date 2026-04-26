import os
import shutil
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from dotenv import load_dotenv
load_dotenv()

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from rag.ingestion import IngestionPipeline
from rag.knowledge_graph import KnowledgeGraph

_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "data", "uploads")
os.makedirs(_UPLOADS_DIR, exist_ok=True)

# Shared RAG instances (initialised once at startup)
_kg = KnowledgeGraph()
_kg.load()
_ingestion = IngestionPipeline(knowledge_graph=_kg)


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
        backend_conversion_boundary="Convert audio/video transport between LiveKit and Gemini in the backend agent runtime, while board mutations are sent as data commands.",
        livekit_audio_hz=48000,
        gemini_input_hz=16000,
        gemini_output_hz=24000,
        notes=[
            "LiveKit room connection needs a server URL plus a signed participant token.",
            "Gemini Live expects 16-bit PCM mono at 16 kHz in and returns 24 kHz audio out.",
            "Publish browser microphone and a board video track through LiveKit; the agent uses live video_input for vision.",
            "The agent can issue board drawing commands over a dedicated LiveKit data topic for deterministic rendering.",
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

    room_name = payload.room_name or f"tablo-{payload.session_id}-{uuid4().hex[:6]}"
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

    try:
        from livekit import api
        async with api.LiveKitAPI(livekit_url, api_key, api_secret) as livekit_api:
            # Check if an agent is already dispatched to this room
            try:
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
                    print(f"Dispatched tablo-assistant to room: {room_name}")
                except Exception as e:
                    print(f"Warning: Failed to dispatch tablo-assistant: {e}")
    except Exception as e:
        print(f"Warning: Failed to initialize LiveKit API for dispatch: {e}")

    return LiveKitTokenResponse(
        server_url=livekit_url,
        room_name=room_name,
        participant_identity=participant_identity,
        token=token,
    )


# ---------------------------------------------------------------------------
# Document management endpoints (RAG source material)
# ---------------------------------------------------------------------------

class DocumentMetadataResponse(BaseModel):
    doc_id: str
    name: str
    chunk_count: int


class IngestionResponse(BaseModel):
    doc_id: str
    name: str
    chunk_count: int
    concept_count: int
    diagram_count: int = 0
    status: str
    error_message: str | None = None


@app.post("/documents/upload", response_model=IngestionResponse)
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> IngestionResponse:
    """Upload a PDF or TXT document and trigger the ingestion pipeline.

    Text chunking and embedding complete synchronously.
    Diagram extraction runs as a background task so the response is fast.
    """
    filename = file.filename or "document"
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if ext not in ("pdf", "txt"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{ext}'. Supported: pdf, txt",
        )

    # Save upload to disk
    save_path = os.path.join(_UPLOADS_DIR, f"{uuid4().hex}_{filename}")
    try:
        with open(save_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save upload: {e}") from e

    # Phase 1: parse → chunk → embed → store (fast, synchronous)
    try:
        result = await _ingestion.ingest_document_fast(file_path=save_path, doc_name=filename)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    if result.status == "failed":
        raise HTTPException(status_code=500, detail=result.error_message or "Ingestion failed")

    # Phase 2: diagram extraction runs in background (slow, non-blocking)
    if ext == "pdf":
        background_tasks.add_task(
            _ingestion.extract_and_attach_diagrams,
            file_path=save_path,
            doc_id=result.doc_id,
        )

    return IngestionResponse(
        doc_id=result.doc_id,
        name=filename,
        chunk_count=result.chunk_count,
        concept_count=result.concept_count,
        diagram_count=0,  # diagrams processing in background
        status=result.status,
        error_message=result.error_message,
    )


@app.get("/documents", response_model=list[DocumentMetadataResponse])
def list_documents() -> list[DocumentMetadataResponse]:
    """List all ingested documents."""
    docs = _ingestion.list_documents()
    return [
        DocumentMetadataResponse(
            doc_id=d["doc_id"],
            name=d["name"],
            chunk_count=d["chunk_count"],
        )
        for d in docs
    ]


@app.delete("/documents/{doc_id}")
def delete_document(doc_id: str) -> dict[str, str]:
    """Delete an ingested document and remove its chunks and concepts."""
    removed = _ingestion.delete_document(doc_id)
    if removed == 0:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")
    return {"status": "deleted", "doc_id": doc_id, "chunks_removed": str(removed)}


@app.post("/documents/{doc_id}/extract-diagrams")
async def extract_diagrams(doc_id: str, background_tasks: BackgroundTasks) -> dict[str, str]:
    """Trigger diagram extraction for an already-ingested document.

    Useful when a document was uploaded before diagram extraction was available.
    Runs in the background — returns immediately.
    """
    # Find the uploaded file for this doc_id
    results = _ingestion._collection.get(where={"doc_id": doc_id}, include=["metadatas"], limit=1)
    if not results.get("ids"):
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")

    doc_name = results["metadatas"][0].get("doc_name", "")
    # Find the file on disk
    upload_files = os.listdir(_UPLOADS_DIR)
    matching = [f for f in upload_files if doc_name in f]
    if not matching:
        raise HTTPException(status_code=404, detail=f"Upload file for '{doc_name}' not found on disk")

    file_path = os.path.join(_UPLOADS_DIR, matching[0])
    background_tasks.add_task(
        _ingestion.extract_and_attach_diagrams,
        file_path=file_path,
        doc_id=doc_id,
    )
    return {"status": "extraction_started", "doc_id": doc_id, "file": matching[0]}
