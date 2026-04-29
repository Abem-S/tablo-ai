"""LangGraph warm-path orchestrator for RAG retrieval and context injection."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from uuid import uuid4

from .models import RetrievalContext, SourceAttribution
from .retrieval import RetrievalPipeline

logger = logging.getLogger("tablo-rag.orchestrator")

_RETRIEVAL_TIMEOUT_S = 5.0


class RAGOrchestrator:
    """Warm-path orchestrator: triggered on user_speech_committed, runs retrieval async.

    Never blocks the hot path. All exceptions are caught internally.
    """

    def __init__(self, retrieval_pipeline: RetrievalPipeline, tablo_agent, room) -> None:
        self._retrieval = retrieval_pipeline
        self._agent = tablo_agent
        self._room = room
        self._current_turn_id: str = ""
        self._base_instructions: str = ""
        self._session_topic: str = ""
        self._recent_transcripts: list[str] = []

    # ------------------------------------------------------------------
    # Entry point (fire-and-forget)
    # ------------------------------------------------------------------

    async def on_user_turn(self, transcript: str, board_summary: str, turn_id: str) -> None:
        """Called on user_speech_committed. Runs retrieval on warm path.

        This method catches all exceptions — the hot path must never be blocked.
        """
        self._current_turn_id = turn_id
        self._recent_transcripts.append(transcript)
        if len(self._recent_transcripts) > 5:
            self._recent_transcripts.pop(0)

        try:
            await asyncio.wait_for(
                self._run_retrieval_cycle(transcript, board_summary, turn_id),
                timeout=_RETRIEVAL_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            logger.warning("RAG retrieval timed out for turn %s — continuing with existing context", turn_id)
        except Exception as e:
            logger.error("RAG orchestrator error for turn %s: %s", turn_id, e)

    async def _run_retrieval_cycle(self, transcript: str, board_summary: str, turn_id: str) -> None:
        # Rewrite query
        query = await self.rewrite_query(transcript, board_summary, self._session_topic)

        # Retrieve
        result = await self._retrieval.retrieve(query=query, turn_id=turn_id)

        # Always publish sources to frontend for viewer navigation
        await self.publish_sources(result.context.sources, turn_id, result.context.is_general_knowledge)

        # Safety net: if relevant content found, inject into agent instructions
        # This fires even if the model skips calling search_documents directly
        if not result.context.is_general_knowledge and result.context.context_text:
            await self.inject_context(result.context, turn_id)

    # ------------------------------------------------------------------
    # Query rewriting
    # ------------------------------------------------------------------

    async def rewrite_query(self, transcript: str, board_summary: str, topic: str) -> str:
        """Rewrite messy speech transcript into a retrieval-optimized query."""
        try:
            from google import genai
            api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
            client = genai.Client(api_key=api_key)

            context_parts = []
            if topic:
                context_parts.append(f"Current topic: {topic}")
            if board_summary:
                context_parts.append(f"Board: {board_summary}")
            if self._recent_transcripts[:-1]:
                context_parts.append("Recent: " + " | ".join(self._recent_transcripts[-3:-1]))

            context_str = "\n".join(context_parts)
            prompt = (
                "Rewrite the following spoken question into a concise, keyword-rich search query "
                "for retrieving relevant educational text passages. "
                "Return ONLY the rewritten query, no explanation.\n\n"
                f"Context:\n{context_str}\n\n"
                f"Spoken question: {transcript}"
            )

            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
            )
            rewritten = (response.text or "").strip()
            logger.debug("Query rewritten: '%s' → '%s'", transcript[:60], rewritten[:60])
            return rewritten
        except Exception as e:
            logger.warning("Query rewrite failed: %s — using raw transcript", e)
            return transcript

    # ------------------------------------------------------------------
    # Context injection
    # ------------------------------------------------------------------

    async def inject_context(self, context: RetrievalContext, turn_id: str) -> None:
        """Update agent instructions with RAG context. Discards stale turns."""
        if turn_id != self._current_turn_id:
            logger.debug("Discarding stale context for turn %s (current: %s)", turn_id, self._current_turn_id)
            return

        if context.is_general_knowledge or not context.context_text:
            return

        try:
            rag_section = (
                "\n\n---\nRELEVANT SOURCE MATERIAL (from uploaded documents):\n"
                "When drawing on the following passages, mention that you are referencing the learner's materials.\n\n"
                f"{context.context_text}\n---"
            )
            new_instructions = self._base_instructions + rag_section
            await self._agent.update_instructions(new_instructions)
            logger.info("Injected RAG context for turn %s (%d sources)", turn_id, len(context.sources))
        except Exception as e:
            logger.error("Failed to inject RAG context for turn %s: %s", turn_id, e)

    # ------------------------------------------------------------------
    # Source publishing
    # ------------------------------------------------------------------

    async def publish_sources(
        self,
        sources: list[SourceAttribution],
        turn_id: str,
        is_general_knowledge: bool,
    ) -> None:
        """Publish source attribution to frontend via tutor.sources LiveKit data topic."""
        try:
            navigate_to = None
            if sources and not is_general_knowledge:
                top = sources[0]
                navigate_to = {
                    "doc_name": top.document_name,
                    "page_number": top.page_number,
                    "text_excerpt": top.text_excerpt[:200] if top.text_excerpt else None,
                }

            payload = {
                "turn_id": turn_id,
                "is_general_knowledge": is_general_knowledge,
                "sources": [
                    {
                        "chunk_id": s.chunk_id,
                        "document_name": s.document_name,
                        "page_number": s.page_number,
                        "section_title": s.section_title,
                        "text_excerpt": s.text_excerpt,
                        "relevance": s.relevance,
                        "score": s.score,
                    }
                    for s in sources
                ],
                "navigate_to": navigate_to,
            }
            data = json.dumps(payload).encode("utf-8")
            await self._room.local_participant.publish_data(
                data,
                reliable=True,
                topic="tutor.sources",
            )
            logger.info("Published %d sources, navigate_to=%s", len(sources),
                        f"p.{navigate_to['page_number']}" if navigate_to else "none")
        except Exception as e:
            logger.warning("Failed to publish sources for turn %s: %s", turn_id, e, exc_info=True)

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def set_base_instructions(self, instructions: str) -> None:
        """Store the agent's base instructions so RAG context can be appended."""
        self._base_instructions = instructions

    def set_session_topic(self, topic: str) -> None:
        self._session_topic = topic
