"""Load skill markdown files and assemble the agent's dynamic system prompt.

Skills are plain markdown files in backend/skills/.
They are loaded once at startup and cached.
The assembled prompt = skill sections + learner profile section.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("tablo.skills_loader")

_SKILLS_DIR = os.path.join(os.path.dirname(__file__), "skills")

# Ordered list of skill files to load — order matters for prompt assembly
_SKILL_FILES = [
    "core_teaching.md",
    "learner_adaptation.md",
    "document_grounding.md",
    "drawing_commands.md",
]

_cache: dict[str, str] = {}


def load_skill(filename: str) -> str:
    """Load a single skill file. Returns empty string if not found."""
    if filename in _cache:
        return _cache[filename]
    path = os.path.join(_SKILLS_DIR, filename)
    if not os.path.exists(path):
        logger.warning("Skill file not found: %s", path)
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
        _cache[filename] = content
        logger.debug("Loaded skill: %s (%d chars)", filename, len(content))
        return content
    except Exception as e:
        logger.error("Failed to load skill %s: %s", filename, e)
        return ""


def load_all_skills() -> str:
    """Load and concatenate all skill files in order."""
    sections = []
    for filename in _SKILL_FILES:
        content = load_skill(filename)
        if content:
            sections.append(content)
    combined = "\n\n---\n\n".join(sections)
    logger.info("Loaded %d skill files (%d total chars)", len(sections), len(combined))
    return combined


def build_system_prompt(learner_profile_section: str = "") -> str:
    """Assemble the full system prompt from skills + learner profile.

    Args:
        learner_profile_section: Formatted learner profile string from
                                  learner_memory.format_profile_for_prompt()

    Returns:
        Complete system prompt string ready to pass to the agent.
    """
    skills = load_all_skills()

    if learner_profile_section:
        return f"{skills}\n\n---\n\n{learner_profile_section}"
    return skills


def reload_skills() -> None:
    """Clear the cache so skills are reloaded from disk on next call.
    Useful during development without restarting the worker.
    """
    _cache.clear()
    logger.info("Skills cache cleared — will reload from disk")
