"""Session management — stores session metadata locally."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _sessions_dir() -> Path:
    """Get the sessions directory path."""
    base = Path(__file__).parent / "data" / "sessions"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _session_path(session_id: str) -> Path:
    """Get the path for a session file."""
    return _sessions_dir() / f"{session_id}.json"


def _learner_sessions_dir(learner_id: str) -> Path:
    """Get directory for learner's session list."""
    base = Path(__file__).parent / "data" / "learner_sessions"
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{learner_id}.json"


def _default_session(learner_id: str, name: str = "Default Session") -> dict[str, Any]:
    """Create a default session object."""
    return {
        "id": f"session_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}",
        "name": name,
        "learner_id": learner_id,
        "doc_ids": [],
        "active_doc_id": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "last_accessed": datetime.now(timezone.utc).isoformat(),
    }


def create_session(learner_id: str, name: str | None = None) -> dict[str, Any]:
    """Create a new session for a learner."""
    session_name = (
        name or f"Session {datetime.now(timezone.utc).strftime('%m/%d %H:%M')}"
    )
    session = _default_session(learner_id, session_name)

    # Save session file
    path = _session_path(session["id"])
    with open(path, "w") as f:
        json.dump(session, f, indent=2)

    # Add to learner's session list
    _add_to_learner_sessions(learner_id, session["id"])

    return session


def get_session(session_id: str) -> dict[str, Any] | None:
    """Get a session by ID."""
    path = _session_path(session_id)
    if not path.exists():
        return None

    with open(path) as f:
        session = json.load(f)

    # Update last accessed
    session["last_accessed"] = datetime.now(timezone.utc).isoformat()
    with open(path, "w") as f:
        json.dump(session, f, indent=2)

    return session


def list_sessions(learner_id: str) -> list[dict[str, Any]]:
    """List all sessions for a learner."""
    list_path = _learner_sessions_dir(learner_id)
    if not list_path.exists():
        # Return default session if none exist
        return [create_session(learner_id, "Default Session")]

    with open(list_path) as f:
        session_ids = json.load(f)

    sessions = []
    for sid in session_ids:
        session = get_session(sid)
        if session:
            sessions.append(session)

    # Sort by last accessed, newest first
    sessions.sort(key=lambda s: s.get("last_accessed", ""), reverse=True)
    return sessions


def delete_session(session_id: str, learner_id: str) -> bool:
    """Delete a session."""
    path = _session_path(session_id)
    if not path.exists():
        return False

    path.unlink()
    _remove_from_learner_sessions(learner_id, session_id)
    return True


def set_active_doc(session_id: str, doc_id: str | None) -> dict[str, Any] | None:
    """Set the active document for a session."""
    session = get_session(session_id)
    if not session:
        return None

    session["active_doc_id"] = doc_id

    # Add doc to session's doc list if not present
    if doc_id and doc_id not in session["doc_ids"]:
        session["doc_ids"].append(doc_id)

    path = _session_path(session_id)
    with open(path, "w") as f:
        json.dump(session, f, indent=2)

    return session


def add_doc_to_session(session_id: str, doc_id: str) -> dict[str, Any] | None:
    """Add a document to a session."""
    session = get_session(session_id)
    if not session:
        return None

    if doc_id not in session["doc_ids"]:
        session["doc_ids"].append(doc_id)

    # If no active doc, set this one
    if not session.get("active_doc_id"):
        session["active_doc_id"] = doc_id

    path = _session_path(session_id)
    with open(path, "w") as f:
        json.dump(session, f, indent=2)

    return session


def _add_to_learner_sessions(learner_id: str, session_id: str) -> None:
    """Add a session to the learner's session list."""
    list_path = _learner_sessions_dir(learner_id)

    if list_path.exists():
        with open(list_path) as f:
            session_ids = json.load(f)
    else:
        session_ids = []

    if session_id not in session_ids:
        session_ids.append(session_id)

    with open(list_path, "w") as f:
        json.dump(session_ids, f)


def _remove_from_learner_sessions(learner_id: str, session_id: str) -> None:
    """Remove a session from the learner's session list."""
    list_path = _learner_sessions_dir(learner_id)
    if not list_path.exists():
        return

    with open(list_path) as f:
        session_ids = json.load(f)

    if session_id in session_ids:
        session_ids.remove(session_id)

    with open(list_path, "w") as f:
        json.dump(session_ids, f)


# ── Board state persistence ────────────────────────────────────────────────────


def save_board_state(session_id: str, snapshot: dict) -> None:
    """Persist the tldraw board snapshot JSON for a session."""
    path = _sessions_dir() / f"{session_id}_board.json"
    with open(path, "w") as f:
        json.dump(snapshot, f)


def load_board_state(session_id: str) -> dict | None:
    """Load the tldraw board snapshot for a session. Returns None if not found."""
    path = _sessions_dir() / f"{session_id}_board.json"
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


# ── Session notes ──────────────────────────────────────────────────────────────


def add_session_note(session_id: str, note: str) -> None:
    """Append an agent-written note to the session JSON (max 20 notes kept)."""
    path = _session_path(session_id)
    if not path.exists():
        return
    try:
        with open(path) as f:
            session = json.load(f)
        notes = session.get("notes", [])
        notes.append({
            "text": note,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        session["notes"] = notes[-20:]  # keep last 20
        session["last_accessed"] = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            json.dump(session, f, indent=2)
    except Exception:
        pass  # non-critical — never crash the agent over a note

