"""LangGraph multi-agent orchestrator for Tablo RAG pipeline.

Replaces the plain RAGOrchestrator with a proper LangGraph graph where
specialised sub-agents run in parallel to minimise latency:

  ┌─────────────────────────────────────────────────────────────────┐
  │                     RAG Orchestration Graph                     │
  │                                                                 │
  │  user_turn ──► query_rewriter ──► [parallel fan-out]           │
  │                                    ├── vector_retriever         │
  │                                    └── graph_retriever          │
  │                                         │                       │
  │                                    rrf_merger                   │
  │                                         │                       │
  │                              [parallel fan-out]                 │
  │                               ├── context_compressor            │
  │                               └── diagram_collector             │
  │                                         │                       │
  │                                    result_publisher             │
  └─────────────────────────────────────────────────────────────────┘

Each node is an async function. Fan-out is achieved with asyncio.gather
inside the merger nodes so the graph stays linear (LangGraph StateGraph)
while the heavy I/O work runs concurrently.

Backward-compatible: RAGOrchestrator in orchestrator.py delegates here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, TypedDict

from langgraph.graph import StateGraph, END

from .models import RetrievalContext, SourceAttribution, ScoredChunk
from .retrieval import compress_context
from config import get_env

logger = logging.getLogger("tablo-rag.lg_orchestrator")

_REWRITE_TIMEOUT_S = float(os.getenv("RAG_REWRITE_TIMEOUT_S", "4"))
_VECTOR_TIMEOUT_S = float(os.getenv("RAG_VECTOR_TIMEOUT_S", "5"))
_GRAPH_TIMEOUT_S = float(os.getenv("RAG_GRAPH_TIMEOUT_S", "3"))
_COMPRESS_TIMEOUT_S = float(os.getenv("RAG_COMPRESS_TIMEOUT_S", "6"))
_TOTAL_TIMEOUT_S = float(os.getenv("RAG_TOTAL_TIMEOUT_S", "8"))


# ─── Graph State ──────────────────────────────────────────────────────────────


class OrchestratorState(TypedDict):
    """Shared state flowing through the LangGraph nodes."""

    # Inputs
    transcript: str
    board_summary: str
    session_topic: str
    recent_transcripts: list[str]
    turn_id: str
    collection: str
    user_id: str | None

    # Intermediate
    rewritten_query: str
    vector_results: list[ScoredChunk]
    graph_results: list[ScoredChunk]
    fused_chunks: list[ScoredChunk]

    # Outputs
    context: RetrievalContext | None
    compressed_text: str
    sources: list[SourceAttribution]
    is_general_knowledge: bool
    navigate_to: dict | None
    elapsed_ms: float

    # Error tracking
    errors: list[str]


def _empty_state(
    transcript: str,
    board_summary: str,
    turn_id: str,
    collection: str,
    user_id: str | None,
    session_topic: str = "",
    recent_transcripts: list[str] | None = None,
) -> OrchestratorState:
    return OrchestratorState(
        transcript=transcript,
        board_summary=board_summary,
        session_topic=session_topic,
        recent_transcripts=recent_transcripts or [],
        turn_id=turn_id,
        collection=collection,
        user_id=user_id,
        rewritten_query=transcript,
        vector_results=[],
        graph_results=[],
        fused_chunks=[],
        context=None,
        compressed_text="",
        sources=[],
        is_general_knowledge=True,
        navigate_to=None,
        elapsed_ms=0.0,
        errors=[],
    )


# ─── Node: Query Rewriter ─────────────────────────────────────────────────────


async def query_rewriter_node(state: OrchestratorState) -> dict:
    """Rewrite the raw speech transcript into a retrieval-optimised query."""
    transcript = state["transcript"]
    board_summary = state["board_summary"]
    session_topic = state["session_topic"]
    recent = state["recent_transcripts"]

    try:
        from google import genai

        api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
        if not api_key:
            return {"rewritten_query": transcript}

        client = genai.Client(api_key=api_key)
        context_parts = []
        if session_topic:
            context_parts.append(f"Current topic: {session_topic}")
        if board_summary:
            context_parts.append(f"Board: {board_summary}")
        if recent[:-1]:
            context_parts.append("Recent: " + " | ".join(recent[-3:-1]))

        prompt = (
            "Rewrite the following spoken question into a concise, keyword-rich search query "
            "for retrieving relevant educational text passages. "
            "Return ONLY the rewritten query, no explanation.\n\n"
            f"Context:\n{chr(10).join(context_parts)}\n\n"
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
        rewritten = (response.text or "").strip() or transcript
        logger.debug("Query rewritten: '%s' → '%s'", transcript[:60], rewritten[:60])
        return {"rewritten_query": rewritten}
    except Exception as e:
        logger.warning("Query rewrite failed: %s — using raw transcript", e)
        return {
            "rewritten_query": transcript,
            "errors": state["errors"] + [f"rewrite: {e}"],
        }


# ─── Node: Parallel Retriever (vector + graph concurrently) ──────────────────


async def parallel_retriever_node(state: OrchestratorState) -> dict:
    """Run vector search and graph search concurrently, then RRF-merge."""
    from .knowledge_graph import KnowledgeGraph
    from .retrieval import RetrievalPipeline

    query = state["rewritten_query"]
    collection = state["collection"]
    threshold = 0.1  # Qdrant cosine scores differ from ChromaDB

    try:
        kg = KnowledgeGraph()
        # Load KG lazily — it's already loaded in the main process but we need
        # a reference here. In practice the agent passes the shared instance via
        # the retrieval pipeline; we reconstruct it here for the graph node.
        try:
            kg.load()
        except Exception:
            pass

        pipeline = RetrievalPipeline(
            knowledge_graph=kg,
            collection=collection,
            user_id=state["user_id"],
        )

        # Run both searches concurrently
        vector_task = asyncio.create_task(
            asyncio.wait_for(
                pipeline.vector_search(query, top_k=10), timeout=_VECTOR_TIMEOUT_S
            )
        )
        graph_task = asyncio.create_task(
            asyncio.wait_for(
                asyncio.to_thread(pipeline.graph_search, query, 5),
                timeout=_GRAPH_TIMEOUT_S,
            )
        )

        vector_results, graph_results = await asyncio.gather(
            vector_task, graph_task, return_exceptions=True
        )

        if isinstance(vector_results, Exception):
            logger.warning("Vector search failed: %s", vector_results)
            vector_results = []
        if isinstance(graph_results, Exception):
            logger.warning("Graph search failed: %s", graph_results)
            graph_results = []

        # Filter by threshold
        vector_filtered = [sc for sc in vector_results if sc.score >= threshold]
        graph_filtered = [sc for sc in graph_results if sc.score >= threshold]

        # RRF merge
        fused = pipeline.rerank_rrf(vector_filtered, graph_filtered)
        top = fused[:5]

        # Assemble context
        context = pipeline.assemble_context(top, state["turn_id"])

        return {
            "vector_results": vector_results,
            "graph_results": graph_results,
            "fused_chunks": top,
            "context": context,
            "is_general_knowledge": context.is_general_knowledge,
            "sources": context.sources,
        }
    except Exception as e:
        logger.error("Parallel retriever failed: %s", e)
        empty_ctx = RetrievalContext(
            turn_id=state["turn_id"],
            context_text="",
            sources=[],
            is_general_knowledge=True,
        )
        return {
            "vector_results": [],
            "graph_results": [],
            "fused_chunks": [],
            "context": empty_ctx,
            "is_general_knowledge": True,
            "sources": [],
            "errors": state["errors"] + [f"retriever: {e}"],
        }


# ─── Node: Parallel Post-Processing (compress + diagram hints concurrently) ──


async def parallel_postprocess_node(state: OrchestratorState) -> dict:
    """Run context compression and diagram hint collection concurrently."""
    context = state["context"]
    query = state["rewritten_query"]

    if not context or context.is_general_knowledge or not context.context_text:
        return {
            "compressed_text": "",
            "navigate_to": None,
        }

    # Run compression and navigate_to extraction concurrently
    async def _compress():
        try:
            return await asyncio.wait_for(
                compress_context(query, context),
                timeout=_COMPRESS_TIMEOUT_S,
            )
        except Exception as e:
            logger.warning("Compression failed: %s", e)
            return context.context_text[:500]

    async def _build_navigate_to():
        sources = context.sources
        if not sources:
            return None
        top = sources[0]
        return {
            "doc_name": top.document_name,
            "page_number": top.page_number,
            "text_excerpt": top.text_excerpt[:200] if top.text_excerpt else None,
        }

    compressed, navigate_to = await asyncio.gather(_compress(), _build_navigate_to())

    return {
        "compressed_text": compressed,
        "navigate_to": navigate_to,
    }


# ─── Node: Result Publisher ───────────────────────────────────────────────────


async def result_publisher_node(state: OrchestratorState) -> dict:
    """Publish sources to frontend via tutor.sources LiveKit topic.

    This node is a no-op in the graph itself — the actual publish is done
    by the caller (RAGOrchestrator) after the graph completes, because the
    room reference lives outside the graph.
    """
    # Just mark elapsed time
    return {"elapsed_ms": 0.0}


# ─── Graph Builder ────────────────────────────────────────────────────────────


def build_rag_graph() -> Any:
    """Build and compile the LangGraph RAG orchestration graph."""
    graph = StateGraph(OrchestratorState)

    graph.add_node("query_rewriter", query_rewriter_node)
    graph.add_node("parallel_retriever", parallel_retriever_node)
    graph.add_node("parallel_postprocess", parallel_postprocess_node)
    graph.add_node("result_publisher", result_publisher_node)

    graph.set_entry_point("query_rewriter")
    graph.add_edge("query_rewriter", "parallel_retriever")
    graph.add_edge("parallel_retriever", "parallel_postprocess")
    graph.add_edge("parallel_postprocess", "result_publisher")
    graph.add_edge("result_publisher", END)

    return graph.compile()


# Singleton compiled graph — built once at import time
_RAG_GRAPH = None


def get_rag_graph():
    global _RAG_GRAPH
    if _RAG_GRAPH is None:
        _RAG_GRAPH = build_rag_graph()
    return _RAG_GRAPH


# ─── High-Level Runner ────────────────────────────────────────────────────────


@dataclass
class RAGGraphResult:
    """Result returned by run_rag_graph."""

    compressed_text: str
    sources: list[SourceAttribution]
    is_general_knowledge: bool
    navigate_to: dict | None
    context: RetrievalContext | None
    elapsed_ms: float
    errors: list[str] = field(default_factory=list)


async def run_rag_graph(
    transcript: str,
    board_summary: str,
    turn_id: str,
    collection: str,
    user_id: str | None = None,
    session_topic: str = "",
    recent_transcripts: list[str] | None = None,
) -> RAGGraphResult:
    """Run the full LangGraph RAG pipeline and return a structured result.

    This is the single entry point used by RAGOrchestrator.
    All exceptions are caught — the hot path must never be blocked.
    """
    start = time.monotonic()
    try:
        graph = get_rag_graph()
        initial_state = _empty_state(
            transcript=transcript,
            board_summary=board_summary,
            turn_id=turn_id,
            collection=collection,
            user_id=user_id,
            session_topic=session_topic,
            recent_transcripts=recent_transcripts or [],
        )

        final_state: OrchestratorState = await asyncio.wait_for(
            graph.ainvoke(initial_state),
            timeout=_TOTAL_TIMEOUT_S,
        )

        elapsed_ms = (time.monotonic() - start) * 1000
        logger.info(
            "RAG graph completed in %.0fms — %d sources, general_knowledge=%s, errors=%s",
            elapsed_ms,
            len(final_state.get("sources", [])),
            final_state.get("is_general_knowledge", True),
            final_state.get("errors", []),
        )

        return RAGGraphResult(
            compressed_text=final_state.get("compressed_text", ""),
            sources=final_state.get("sources", []),
            is_general_knowledge=final_state.get("is_general_knowledge", True),
            navigate_to=final_state.get("navigate_to"),
            context=final_state.get("context"),
            elapsed_ms=elapsed_ms,
            errors=final_state.get("errors", []),
        )

    except asyncio.TimeoutError:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.warning("RAG graph timed out after %.0fms", elapsed_ms)
        return RAGGraphResult(
            compressed_text="",
            sources=[],
            is_general_knowledge=True,
            navigate_to=None,
            context=None,
            elapsed_ms=elapsed_ms,
            errors=["timeout"],
        )
    except Exception as e:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.error("RAG graph failed: %s", e, exc_info=True)
        return RAGGraphResult(
            compressed_text="",
            sources=[],
            is_general_knowledge=True,
            navigate_to=None,
            context=None,
            elapsed_ms=elapsed_ms,
            errors=[str(e)],
        )
