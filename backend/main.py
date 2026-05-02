import os
import shutil
import time
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    HTTPException,
    UploadFile,
    Depends,
    Query,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from rag.ingestion import IngestionPipeline
from rag.knowledge_graph import KnowledgeGraph
from learner_memory import load_profile, save_profile, apply_update
from config import get_env
from observability import init_tracing, record_http_metrics
from mcp_tools import mcp_list_tools_response, mcp_call_tool_response
from auth import (
    verify_admin_password,
    create_session_token,
    get_current_user,
    is_auth_enabled,
    LOCAL_ADMIN_USER_ID,
)
from sessions import (
    create_session,
    get_session,
    list_sessions,
    delete_session,
    set_active_doc,
    add_doc_to_session,
)

load_dotenv()

_UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "data", "uploads")
os.makedirs(_UPLOADS_DIR, exist_ok=True)

# Shared RAG instances (initialised once at startup)
# user_id=None → uses tablo_shared collection (single-user / open-source mode)
_kg = KnowledgeGraph()
_kg.load()
_ingestion = IngestionPipeline(knowledge_graph=_kg, user_id=None)

# Per-user ingestion pipeline cache — keyed by user_id
# In OSS mode this always has one entry: "local_admin"
_ingestion_cache: dict[str, IngestionPipeline] = {}
_ingestion_cache[LOCAL_ADMIN_USER_ID] = _ingestion  # reuse the shared instance

# In-memory ingestion status cache — keyed by doc_id
# Tracks background ingestion progress so the frontend can poll
_ingestion_status: dict[str, dict] = {}


def _get_ingestion(user_id: str) -> IngestionPipeline:
    """Get or create a per-user IngestionPipeline."""
    if user_id not in _ingestion_cache:
        kg = KnowledgeGraph()
        kg.load()
        _ingestion_cache[user_id] = IngestionPipeline(
            knowledge_graph=kg, user_id=user_id
        )
    return _ingestion_cache[user_id]


app = FastAPI(
    title="Tablo API",
    description="Day 1 session bootstrap backend for the Tablo workspace.",
    version="0.1.0",
)

init_tracing("tablo-api")
FastAPIInstrumentor.instrument_app(app)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _metrics_middleware(request, call_next):
    start = time.monotonic()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        route = request.scope.get("route")
        path = route.path if route else request.url.path
        duration = time.monotonic() - start
        record_http_metrics(request.method, path, status_code, duration)


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
    status = {"status": "ok"}
    if os.getenv("HEALTH_CHECK_QDRANT", "false").lower() == "true":
        try:
            _ingestion._client.get_collections()
            status["qdrant"] = "ok"
        except Exception as e:
            status["qdrant"] = f"error: {e}"
    return status


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    password: str


class LoginResponse(BaseModel):
    token: str
    user_id: str
    auth_enabled: bool


@app.get("/auth/status")
def auth_status() -> dict:
    """Check if authentication is enabled on this instance."""
    return {"auth_enabled": is_auth_enabled()}


@app.post("/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest) -> LoginResponse:
    """Authenticate with the admin password and receive a session token.

    The token is valid for 30 days. Include it in subsequent requests as:
      Authorization: Bearer <token>
    """
    if not verify_admin_password(payload.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password.",
        )
    token = create_session_token()
    return LoginResponse(
        token=token,
        user_id=LOCAL_ADMIN_USER_ID,
        auth_enabled=is_auth_enabled(),
    )


@app.get("/metrics")
def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


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
    livekit_url = get_env("LIVEKIT_URL")
    api_key = get_env("LIVEKIT_API_KEY")
    api_secret = get_env("LIVEKIT_API_SECRET")

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
    livekit_url = get_env("LIVEKIT_URL")
    api_key = get_env("LIVEKIT_API_KEY")
    api_secret = get_env("LIVEKIT_API_SECRET")

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
                dispatches = await livekit_api.agent_dispatch.list_dispatch(
                    room=room_name
                )
                already_dispatched = any(
                    d.agent_name == "tablo-assistant" for d in dispatches.items
                )
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
    session_id: str | None = Query(default=None, description="Optional session ID to add doc to"),
    user_id: str = Depends(get_current_user),
) -> IngestionResponse:
    """Upload a document and trigger the ingestion pipeline.

    Returns immediately with status='processing'. Ingestion (parse → chunk → embed)
    runs in the background so the student can start talking right away.
    The document becomes searchable once ingestion completes (~5-30s depending on size).
    
    Optionally specify session_id to auto-add document to that session.
    """
    filename = file.filename or "document"
    ext = os.path.splitext(filename)[1].lower().lstrip(".")

    # Get or create per-user ingestion pipeline
    ingestion = _get_ingestion(user_id)

    if ext not in ingestion._SUPPORTED_FORMATS:
        supported = ", ".join(sorted(ingestion._SUPPORTED_FORMATS))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{ext}'. Supported: {supported}",
        )

    # Save upload to disk immediately
    doc_id = uuid4().hex
    save_path = os.path.join(_UPLOADS_DIR, f"{doc_id}_{filename}")
    try:
        with open(save_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to save upload: {e}"
        ) from e

    # Run full ingestion in background — student doesn't wait
    async def _ingest_and_extract():
        try:
            result = await ingestion.ingest_document_fast(
                file_path=save_path, doc_name=filename
            )
            if result.status == "complete" and ext in ingestion._DIAGRAM_FORMATS:
                await ingestion.extract_and_attach_diagrams(
                    file_path=save_path, doc_id=result.doc_id
                )
            # Associate with session if provided
            if session_id and result.status == "complete":
                add_doc_to_session(session_id, result.doc_id)
            # Update ingestion status cache
            _ingestion_status[doc_id] = {
                "doc_id": doc_id,
                "status": result.status,
                "chunk_count": result.chunk_count,
                "concept_count": result.concept_count,
                "diagram_count": result.diagram_count,
                "error_message": result.error_message,
            }
        except Exception as e:
            import logging as _logging

            _logging.getLogger("tablo.upload").error(
                "Background ingestion failed for %s: %s", filename, e
            )
            _ingestion_status[doc_id] = {
                "doc_id": doc_id,
                "status": "failed",
                "chunk_count": 0,
                "concept_count": 0,
                "diagram_count": 0,
                "error_message": str(e),
            }

    background_tasks.add_task(_ingest_and_extract)

    # Mark as processing immediately
    _ingestion_status[doc_id] = {
        "doc_id": doc_id,
        "status": "processing",
        "chunk_count": 0,
        "concept_count": 0,
        "diagram_count": 0,
        "error_message": None,
    }

    return IngestionResponse(
        doc_id=doc_id,
        name=filename,
        chunk_count=0,
        concept_count=0,
        diagram_count=0,
        status="processing",
        error_message=None,
    )


@app.get("/documents/{doc_id}/status")
def get_ingestion_status(doc_id: str, user_id: str = Depends(get_current_user)) -> dict:
    """Poll ingestion status for a document.

    Returns: { doc_id, status: "processing"|"complete"|"failed",
               chunk_count, concept_count, diagram_count, error_message }
    """
    if doc_id in _ingestion_status:
        return _ingestion_status[doc_id]
    # Not in cache — check if it exists in Qdrant (already completed before restart)
    ingestion = _get_ingestion(user_id)
    from rag.vector_store import get_points_by_doc_id

    points = get_points_by_doc_id(ingestion._client, ingestion._collection, doc_id)
    if points:
        return {
            "doc_id": doc_id,
            "status": "complete",
            "chunk_count": len(points),
            "concept_count": 0,
            "diagram_count": 0,
            "error_message": None,
        }
    raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")


@app.get("/documents", response_model=list[DocumentMetadataResponse])
def list_documents(
    user_id: str = Depends(get_current_user),
) -> list[DocumentMetadataResponse]:
    """List all ingested documents for the current user."""
    ingestion = _get_ingestion(user_id)
    docs = ingestion.list_documents()
    return [
        DocumentMetadataResponse(
            doc_id=d["doc_id"],
            name=d["name"],
            chunk_count=d["chunk_count"],
        )
        for d in docs
    ]


@app.delete("/documents/{doc_id}")
def delete_document(
    doc_id: str, user_id: str = Depends(get_current_user)
) -> dict[str, str]:
    """Delete an ingested document and remove its chunks and concepts."""
    ingestion = _get_ingestion(user_id)
    removed = ingestion.delete_document(doc_id)
    if removed == 0:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")
    _ingestion_status.pop(doc_id, None)
    return {"status": "deleted", "doc_id": doc_id, "chunks_removed": str(removed)}


@app.post("/documents/{doc_id}/extract-diagrams")
async def extract_diagrams(
    doc_id: str,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user),
) -> dict[str, str]:
    """Trigger diagram extraction for an already-ingested document."""
    from rag.vector_store import get_points_by_doc_id

    ingestion = _get_ingestion(user_id)
    points = get_points_by_doc_id(ingestion._client, ingestion._collection, doc_id)
    if not points:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")

    doc_name = points[0]["payload"].get("doc_name", "")
    upload_files = os.listdir(_UPLOADS_DIR)
    matching = [f for f in upload_files if doc_name in f]
    if not matching:
        raise HTTPException(
            status_code=404, detail=f"Upload file for '{doc_name}' not found on disk"
        )

    file_path = os.path.join(_UPLOADS_DIR, matching[0])
    background_tasks.add_task(
        ingestion.extract_and_attach_diagrams, file_path=file_path, doc_id=doc_id
    )
    return {"status": "extraction_started", "doc_id": doc_id, "file": matching[0]}


# ---------------------------------------------------------------------------
# Session management endpoints
# ---------------------------------------------------------------------------


class SessionCreateRequest(BaseModel):
    name: str | None = None


class SessionResponse(BaseModel):
    id: str
    name: str
    learner_id: str
    doc_ids: list
    active_doc_id: str | None
    created_at: str
    last_accessed: str


class SetActiveDocRequest(BaseModel):
    doc_id: str | None = None


@app.get("/sessions", response_model=list[SessionResponse])
def get_sessions(user_id: str = Depends(get_current_user)) -> list[SessionResponse]:
    """List all sessions for the current user."""
    sessions = list_sessions(user_id)
    return [SessionResponse(**s) for s in sessions]


@app.post("/sessions", response_model=SessionResponse)
def create_new_session(
    payload: SessionCreateRequest,
    user_id: str = Depends(get_current_user),
) -> SessionResponse:
    """Create a new session."""
    session = create_session(user_id, payload.name)
    return SessionResponse(**session)


@app.get("/sessions/{session_id}", response_model=SessionResponse)
def get_session_details(
    session_id: str,
    user_id: str = Depends(get_current_user),
) -> SessionResponse:
    """Get a specific session."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    # Security: ensure session belongs to user
    if session.get("learner_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return SessionResponse(**session)


@app.delete("/sessions/{session_id}")
def delete_session_endpoint(
    session_id: str,
    user_id: str = Depends(get_current_user),
) -> dict[str, str]:
    """Delete a session."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    if session.get("learner_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    deleted = delete_session(session_id, user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    return {"status": "deleted", "session_id": session_id}


@app.patch("/sessions/{session_id}/active-doc", response_model=SessionResponse)
def set_session_active_doc(
    session_id: str,
    payload: SetActiveDocRequest,
    user_id: str = Depends(get_current_user),
) -> SessionResponse:
    """Set the active document for a session."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    if session.get("learner_id") != user_id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    updated = set_active_doc(session_id, payload.doc_id)
    return SessionResponse(**updated)


# Content-Type mapping for file serving
_MIME_TYPES = {
    "pdf": "application/pdf",
    "txt": "text/plain",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "rtf": "application/rtf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "webp": "image/webp",
    "heif": "image/heif",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "html": "text/html",
    "hwp": "application/x-hwp",
}


def _find_upload_file(
    doc_id: str, user_id: str = LOCAL_ADMIN_USER_ID
) -> tuple[str, str]:
    """Find the uploaded file path for a doc_id. Returns (file_path, doc_name)."""
    from rag.vector_store import get_points_by_doc_id

    ingestion = _get_ingestion(user_id)
    points = get_points_by_doc_id(ingestion._client, ingestion._collection, doc_id)
    if not points:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")

    doc_name = points[0]["payload"].get("doc_name", "")
    upload_files = os.listdir(_UPLOADS_DIR)
    matching = [f for f in upload_files if doc_name in f]
    if not matching:
        raise HTTPException(
            status_code=404, detail=f"Upload file for '{doc_name}' not found on disk"
        )

    file_path = os.path.join(_UPLOADS_DIR, matching[0])
    real_path = os.path.realpath(file_path)
    real_uploads = os.path.realpath(_UPLOADS_DIR)
    if not real_path.startswith(real_uploads):
        raise HTTPException(status_code=403, detail="Access denied")

    return file_path, doc_name


@app.get("/documents/{doc_id}/file")
def get_document_file(doc_id: str, user_id: str = Depends(get_current_user)):
    """Serve the original uploaded file for client-side rendering."""
    file_path, doc_name = _find_upload_file(doc_id, user_id)
    ext = os.path.splitext(doc_name)[1].lower().lstrip(".")
    media_type = _MIME_TYPES.get(ext, "application/octet-stream")
    return FileResponse(file_path, media_type=media_type, filename=doc_name)


@app.get("/documents/{doc_id}/text")
def get_document_text(doc_id: str, user_id: str = Depends(get_current_user)) -> dict:
    """Return extracted plain text for formats that need server-side text extraction."""
    from rag.vector_store import get_points_by_doc_id

    ingestion = _get_ingestion(user_id)
    points = get_points_by_doc_id(ingestion._client, ingestion._collection, doc_id)
    if not points:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")

    # Sort by chunk_index and join
    payloads = [pt["payload"] for pt in points]
    payloads.sort(key=lambda p: p.get("chunk_index", 0))
    full_text = "\n\n".join(p.get("text", "") for p in payloads)
    doc_name = payloads[0].get("doc_name", "") if payloads else ""
    ext = os.path.splitext(doc_name)[1].lower().lstrip(".")

    return {"doc_id": doc_id, "doc_name": doc_name, "format": ext, "text": full_text}


# ---------------------------------------------------------------------------
# Learner profile endpoints
# ---------------------------------------------------------------------------


class LearnerProfileResponse(BaseModel):
    learner_id: str
    learning_styles: dict
    struggle_areas: list
    mastered: list
    hints_that_worked: dict
    preferred_pace: str
    last_session_summary: str
    session_history: list
    created_at: str
    updated_at: str


@app.get("/learner/{learner_id}/profile", response_model=LearnerProfileResponse)
def get_learner_profile(learner_id: str) -> LearnerProfileResponse:
    """Get the persistent learner profile for a given learner ID."""
    profile = load_profile(learner_id)
    return LearnerProfileResponse(
        learner_id=profile.get("learner_id", learner_id),
        learning_styles=profile.get("learning_styles", {}),
        struggle_areas=profile.get("struggle_areas", []),
        mastered=profile.get("mastered", []),
        hints_that_worked=profile.get("hints_that_worked", {}),
        preferred_pace=profile.get("preferred_pace", "normal"),
        last_session_summary=profile.get("last_session_summary", ""),
        session_history=profile.get("session_history", []),
        created_at=profile.get("created_at", ""),
        updated_at=profile.get("updated_at", ""),
    )


@app.patch("/learner/{learner_id}/profile")
def patch_learner_profile(learner_id: str, update: dict) -> dict:
    """Manually update a learner profile (for testing or admin use)."""
    profile = load_profile(learner_id)
    profile = apply_update(profile, update)
    save_profile(profile)
    return {"status": "updated", "learner_id": learner_id}


@app.delete("/learner/{learner_id}/profile")
def reset_learner_profile(learner_id: str) -> dict:
    """Reset a learner profile to defaults."""
    from learner_memory import _profile_path

    path = _profile_path(learner_id)
    if os.path.exists(path):
        os.remove(path)
    return {"status": "reset", "learner_id": learner_id}


# ---------------------------------------------------------------------------
# MCP Tool Layer endpoints
# Exposes the agent's tools in MCP wire format so external clients
# (Claude Desktop, Cursor, etc.) can discover and call them.
# ---------------------------------------------------------------------------


class MCPCallRequest(BaseModel):
    name: str
    arguments: dict = {}


@app.get("/mcp/tools")
def mcp_list_tools() -> dict:
    """List all available MCP tools with their schemas."""
    return mcp_list_tools_response()


@app.post("/mcp/tools/call")
async def mcp_call_tool(request: MCPCallRequest) -> dict:
    """Call an MCP tool by name with the given arguments.

    Returns the MCP call_tool response payload:
    { content: [{type: "text", text: "..."}], isError: bool }
    """
    return await mcp_call_tool_response(request.name, request.arguments)
