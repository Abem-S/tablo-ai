"""Persistent learner memory — stores and retrieves per-learner profiles.

Profiles are stored as JSON files in backend/data/learner_profiles/.
Each profile captures learning style observations, struggle areas, mastered
topics, and session history so the agent can adapt across sessions.

In production this should be backed by a real database, but JSON files
work fine for early launch and are trivially replaceable.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger("tablo.learner_memory")

_PROFILES_DIR = os.path.join(os.path.dirname(__file__), "data", "learner_profiles")
os.makedirs(_PROFILES_DIR, exist_ok=True)


def _profile_path(learner_id: str) -> str:
    # Sanitise learner_id to prevent path traversal
    safe_id = "".join(c for c in learner_id if c.isalnum() or c in "-_")
    if not safe_id:
        safe_id = "anonymous"
    return os.path.join(_PROFILES_DIR, f"{safe_id}.json")


def _default_profile(learner_id: str) -> dict:
    return {
        "learner_id": learner_id,
        "created_at": datetime.now(UTC).isoformat(),
        "updated_at": datetime.now(UTC).isoformat(),
        # Per-subject learning style observations
        # e.g. {"math": "needs visual diagram before formula", "networking": "responds to analogies"}
        "learning_styles": {},
        # Topics the learner has struggled with
        # e.g. ["TCP handshake", "OSI layer 3"]
        "struggle_areas": [],
        # Topics the learner has demonstrated mastery of
        # e.g. ["binary arithmetic", "basic subnetting"]
        "mastered": [],
        # Analogies or explanations that worked
        # e.g. {"subnetting": "pizza slice analogy"}
        "hints_that_worked": {},
        # Preferred teaching pace: "slow", "normal", "fast"
        "preferred_pace": "normal",
        # Summary of the last session for continuity
        "last_session_summary": "",
        # Lightweight session history (last 10 sessions)
        "session_history": [],
    }


def load_profile(learner_id: str) -> dict:
    """Load a learner profile from disk. Returns a default profile if not found."""
    path = _profile_path(learner_id)
    if not os.path.exists(path):
        logger.info("No profile found for %s — using default", learner_id)
        return _default_profile(learner_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            profile = json.load(f)
        logger.info("Loaded profile for %s (%d mastered, %d struggles)",
                    learner_id, len(profile.get("mastered", [])), len(profile.get("struggle_areas", [])))
        return profile
    except Exception as e:
        logger.warning("Failed to load profile for %s: %s — using default", learner_id, e)
        return _default_profile(learner_id)


def save_profile(profile: dict) -> None:
    """Persist a learner profile to disk."""
    learner_id = profile.get("learner_id", "anonymous")
    path = _profile_path(learner_id)
    profile["updated_at"] = datetime.now(UTC).isoformat()
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(profile, f, indent=2, ensure_ascii=False)
        logger.info("Saved profile for %s", learner_id)
    except Exception as e:
        logger.error("Failed to save profile for %s: %s", learner_id, e)


def apply_update(profile: dict, update: dict) -> dict:
    """Merge an agent-provided update dict into the profile.

    The agent calls update_learner_profile with a partial dict.
    This function merges it safely without overwriting unrelated fields.

    Supported update keys:
      learning_styles: dict  — merged (not replaced)
      struggle_areas: list   — items appended (deduped)
      mastered: list         — items appended (deduped), removed from struggle_areas
      hints_that_worked: dict — merged
      preferred_pace: str
      last_session_summary: str
      session_history_entry: dict  — appended to session_history (max 10 kept)
      remove_struggle: list  — items removed from struggle_areas
    """
    if "learning_styles" in update:
        profile.setdefault("learning_styles", {}).update(update["learning_styles"])

    if "struggle_areas" in update:
        existing = set(profile.get("struggle_areas", []))
        for item in update["struggle_areas"]:
            existing.add(item)
        profile["struggle_areas"] = list(existing)

    if "remove_struggle" in update:
        to_remove = set(update["remove_struggle"])
        profile["struggle_areas"] = [s for s in profile.get("struggle_areas", []) if s not in to_remove]

    if "mastered" in update:
        existing = set(profile.get("mastered", []))
        new_mastered = set(update["mastered"])
        existing.update(new_mastered)
        profile["mastered"] = list(existing)
        # Remove from struggle_areas if now mastered
        profile["struggle_areas"] = [s for s in profile.get("struggle_areas", []) if s not in new_mastered]

    if "hints_that_worked" in update:
        profile.setdefault("hints_that_worked", {}).update(update["hints_that_worked"])

    if "preferred_pace" in update:
        profile["preferred_pace"] = update["preferred_pace"]

    if "last_session_summary" in update:
        profile["last_session_summary"] = update["last_session_summary"]

    if "session_history_entry" in update:
        history = profile.setdefault("session_history", [])
        entry = update["session_history_entry"]
        entry.setdefault("timestamp", datetime.now(UTC).isoformat())
        history.append(entry)
        # Keep last 10 sessions
        profile["session_history"] = history[-10:]

    return profile


def format_profile_for_prompt(profile: dict) -> str:
    """Format a learner profile as a concise prompt section for the agent."""
    lines = ["## Learner Profile\n"]

    if profile.get("last_session_summary"):
        lines.append(f"**Last session:** {profile['last_session_summary']}\n")

    if profile.get("preferred_pace") and profile["preferred_pace"] != "normal":
        lines.append(f"**Preferred pace:** {profile['preferred_pace']}\n")

    if profile.get("learning_styles"):
        lines.append("**Learning styles by subject:**")
        for subject, style in profile["learning_styles"].items():
            lines.append(f"  - {subject}: {style}")
        lines.append("")

    if profile.get("mastered"):
        lines.append(f"**Already mastered:** {', '.join(profile['mastered'][:10])}\n")

    if profile.get("struggle_areas"):
        lines.append(f"**Known struggle areas (be patient, use more visuals):** {', '.join(profile['struggle_areas'][:10])}\n")

    if profile.get("hints_that_worked"):
        lines.append("**Explanations that worked before:**")
        for topic, hint in list(profile["hints_that_worked"].items())[:5]:
            lines.append(f"  - {topic}: {hint}")
        lines.append("")

    if len(lines) == 1:
        lines.append("No history yet — this is a new learner. Observe and adapt.\n")

    return "\n".join(lines)
