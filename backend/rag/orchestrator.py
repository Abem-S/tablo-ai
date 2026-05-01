"""RAG orchestrator — delegates to the LangGraph multi-agent pipeline.

The public interface (RAGOrchestrator) is unchanged so agent.py needs no edits.
Internally, on_user_turn now drives the LangGraph graph defined in
rag/langgraph_orchestrator.py, which runs query rewriting, vector search,
graph search, RRF merging, context compression, and diagram hint collection
all in parallel sub-agents to minimise latency.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from .models import RetrievalContext, SourceAttribution
from .retrieval import RetrievalPipeline
from .langgraph_orchestrator import run_rag_graph
from config import get_env

logger = logging.getLogger("tablo-rag.orchestrator")

_RETRIEVAL_TIMEOUT_S = float(os.getenv("RAG_TOTAL_TIMEOUT_S", "8"))
_REWRITE_TIMEOUT_S = float(os.getenv("RAG_REWRITE_TIMEOUT_S", "4"))


class RAGOrchestrator:
    """Warm-path orchestrator: triggered on user_speech_committed, runs retrieval async.

    Never blocks the hot path. All exceptions are caught internally.
    """

    def __init__(
        self, retrieval_pipeline: RetrievalPipeline, tablo_agent, room
    ) -> None:
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

    async def on_user_turn(
        self, transcript: str, board_summary: str, turn_id: str
    ) -> None:
        """Called on user_speech_committed. Drives the LangGraph RAG pipeline.

        Delegates to run_rag_graph() which runs query rewriting, vector search,
        graph search, RRF merging, compression, and diagram hints all in parallel
        sub-agents. All exceptions are caught — the hot path must never be blocked.
        """
        self._current_turn_id = turn_id
        self._recent_transcripts.append(transcript)
        if len(self._recent_transcripts) > 5:
            self._recent_transcripts.pop(0)

        try:
            result = await run_rag_graph(
                transcript=transcript,
                board_summary=board_summary,
                turn_id=turn_id,
                collection=self._retrieval._collection,
                user_id=self._retrieval._user_id,
                session_topic=self._session_topic,
                recent_transcripts=list(self._recent_transcripts),
            )

            # Always publish sources to frontend for viewer navigation
            await self.publish_sources(
                result.sources,
                turn_id,
                result.is_general_knowledge,
                navigate_to=result.navigate_to,
            )

            # Inject context into agent instructions if relevant content found
            if (
                not result.is_general_knowledge
                and result.context
                and result.context.context_text
            ):
                await self.inject_context(result.context, turn_id)

            if result.errors:
                logger.debug(
                    "RAG graph completed with non-fatal errors: %s", result.errors
                )

        except Exception as e:
            logger.error("RAG orchestrator error for turn %s: %s", turn_id, e)

    # ------------------------------------------------------------------
    # Query rewriting
    # ------------------------------------------------------------------

    async def rewrite_query(
        self, transcript: str, board_summary: str, topic: str
    ) -> str:
        """Rewrite messy speech transcript into a retrieval-optimized query."""
        try:
            from google import genai

            api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
            if not api_key:
                raise RuntimeError("Gemini API key not configured")
            client = genai.Client(api_key=api_key)

            context_parts = []
            if topic:
                context_parts.append(f"Current topic: {topic}")
            if board_summary:
                context_parts.append(f"Board: {board_summary}")
            if self._recent_transcripts[:-1]:
                context_parts.append(
                    "Recent: " + " | ".join(self._recent_transcripts[-3:-1])
                )

            context_str = "\n".join(context_parts)
            prompt = (
                "Rewrite the following spoken question into a concise, keyword-rich search query "
                "for retrieving relevant educational text passages. "
                "Return ONLY the rewritten query, no explanation.\n\n"
                f"Context:\n{context_str}\n\n"
                f"Spoken question: {transcript}"
            )

            response = await asyncio.wait_for(
                asyncio.to_thread(
                    client.models.generate_content,
                    model="gemini-2.5-flash",
                    contents=prompt,
                ),
                timeout=_REWRITE_TIMEOUT_S,
            )
            rewritten = (response.text or "").strip()
            logger.debug(
                "Query rewritten: '%s' → '%s'", transcript[:60], rewritten[:60]
            )
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
            logger.debug(
                "Discarding stale context for turn %s (current: %s)",
                turn_id,
                self._current_turn_id,
            )
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
            logger.info(
                "Injected RAG context for turn %s (%d sources)",
                turn_id,
                len(context.sources),
            )
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
        navigate_to: dict | None = None,
    ) -> None:
        """Publish source attribution to frontend via tutor.sources LiveKit data topic."""
        try:
            # Use provided navigate_to or build from top source
            if navigate_to is None and sources and not is_general_knowledge:
                top = sources[0]
                navigate_to = {
                    "doc_name": top.document_name,
                    "page_number": top.page_number,
                    "text_excerpt": top.text_excerpt[:200]
                    if top.text_excerpt
                    else None,
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
            logger.info(
                "Published %d sources, navigate_to=%s",
                len(sources),
                f"p.{navigate_to['page_number']}" if navigate_to else "none",
            )
        except Exception as e:
            logger.warning(
                "Failed to publish sources for turn %s: %s", turn_id, e, exc_info=True
            )

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def set_base_instructions(self, instructions: str) -> None:
        """Store the agent's base instructions so RAG context can be appended."""
        self._base_instructions = instructions

    def set_session_topic(self, topic: str) -> None:
        self._session_topic = topic
