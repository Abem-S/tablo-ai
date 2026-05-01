"""Hybrid retrieval pipeline: vector search (Qdrant) + knowledge graph + RRF reranking."""

from __future__ import annotations

import asyncio
import logging
import os
import time

from .knowledge_graph import KnowledgeGraph
from .models import (
    Chunk,
    DiagramRecipe,
    RetrievalContext,
    RetrievalResult,
    ScoredChunk,
    SourceAttribution,
)
from . import vector_store as vs
from config import get_env
from observability import (
    RAG_RETRIEVAL_ERRORS_TOTAL,
    RAG_RETRIEVAL_LATENCY_SECONDS,
    RAG_COMPRESSION_LATENCY_SECONDS,
    RAG_COMPRESSION_TRUNCATIONS_TOTAL,
)

logger = logging.getLogger("tablo-rag.retrieval")

_HIGH_RELEVANCE_THRESHOLD = 0.7
_DEFAULT_THRESHOLD = 0.3
_RETRIEVAL_TIMEOUT_S = 5.0
_RRF_K = 60
_EMBED_TIMEOUT_S = float(os.getenv("RAG_EMBED_TIMEOUT_S", "8"))
_EMBED_RETRIES = int(os.getenv("RAG_EMBED_RETRIES", "2"))
_COMPRESS_TIMEOUT_S = float(os.getenv("RAG_COMPRESS_TIMEOUT_S", "6"))
_COMPRESS_RETRIES = int(os.getenv("RAG_COMPRESS_RETRIES", "1"))
_COMPRESS_MAX_CHARS = int(os.getenv("RAG_COMPRESS_MAX_CHARS", "500"))


def _get_genai_client():
    from google import genai

    api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
    if not api_key:
        return None
    return genai.Client(api_key=api_key)


def _build_diagram_hints(context: RetrievalContext) -> str:
    if not context.diagram_recipes:
        return ""
    hints = [f"p.{r.page_number}: {r.description}" for r in context.diagram_recipes]
    return "\nDiagrams available (call draw_diagram): " + "; ".join(hints)


def _truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    last_period = max(truncated.rfind(". "), truncated.rfind(".\n"))
    if last_period > max_chars * 0.5:
        return truncated[: last_period + 1]
    return truncated


async def compress_context(
    query: str,
    context: RetrievalContext,
    max_chars: int = _COMPRESS_MAX_CHARS,
    allow_llm: bool = True,
) -> str:
    """Compress retrieved chunks to a bounded length for Gemini Live stability."""
    start = time.monotonic()
    diagram_hints = _build_diagram_hints(context)
    summary = ""

    if allow_llm:
        client = _get_genai_client()
        if client is not None:
            prompt = (
                f'The learner asked: "{query}"\n\n'
                f"Retrieved passages:\n{context.context_text[:2000]}\n\n"
                "Write a concise 3-4 sentence answer covering key facts. "
                "Include document name and page numbers. No bullet points. Return ONLY the answer."
            )
            delay = 1.0
            for attempt in range(_COMPRESS_RETRIES + 1):
                try:
                    response = await asyncio.wait_for(
                        asyncio.to_thread(
                            client.models.generate_content,
                            model="gemini-2.5-flash",
                            contents=prompt,
                        ),
                        timeout=_COMPRESS_TIMEOUT_S,
                    )
                    summary = (response.text or "").strip()
                    if summary:
                        break
                except Exception as e:
                    if attempt < _COMPRESS_RETRIES:
                        logger.warning(
                            "Context compression failed (attempt %d): %s",
                            attempt + 1,
                            e,
                        )
                        await asyncio.sleep(delay)
                        delay *= 2
                    else:
                        logger.warning(
                            "Context compression failed after retries: %s", e
                        )

    if not summary:
        summary = context.context_text[: max(0, max_chars - len(diagram_hints))]

    combined = summary
    if diagram_hints:
        remaining = max_chars - len(diagram_hints)
        if remaining < 50:
            diagram_hints = _truncate_text(diagram_hints, max_chars // 2)
            remaining = max_chars - len(diagram_hints)
        summary = _truncate_text(summary, max(0, remaining))
        combined = summary + diagram_hints

    if len(combined) > max_chars:
        RAG_COMPRESSION_TRUNCATIONS_TOTAL.inc()
        combined = _truncate_text(combined, max_chars)

    RAG_COMPRESSION_LATENCY_SECONDS.observe(time.monotonic() - start)
    return combined


class RetrievalPipeline:
    """Hybrid retrieval: Qdrant vector search + knowledge graph + RRF reranking."""

    def __init__(
        self,
        knowledge_graph: KnowledgeGraph,
        collection: str,
        user_id: str | None = None,
    ) -> None:
        self._kg = knowledge_graph
        self._collection = collection
        self._user_id = user_id
        self._client = vs._get_client()

    # ------------------------------------------------------------------
    # Vector search
    # ------------------------------------------------------------------

    async def vector_search(self, query: str, top_k: int = 10) -> list[ScoredChunk]:
        """Embed query and search Qdrant. Returns scored chunks."""
        try:
            embedding = await asyncio.wait_for(
                self._embed_query(query),
                timeout=_RETRIEVAL_TIMEOUT_S,
            )
            results = vs.search_vectors(
                self._client,
                self._collection,
                query_vector=embedding,
                top_k=top_k,
            )
            scored: list[ScoredChunk] = []
            for r in results:
                p = r["payload"]
                chunk = self._payload_to_chunk(p)
                scored.append(
                    ScoredChunk(chunk=chunk, score=r["score"], source="vector")
                )
            return scored
        except asyncio.TimeoutError:
            logger.warning("Vector search timed out")
            return []
        except Exception as e:
            logger.error("Vector search failed: %s", e)
            return []

    async def _embed_query(self, text: str) -> list[float]:
        from google import genai
        from google.genai import types as genai_types

        api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("Gemini API key is not configured")

        client = genai.Client(api_key=api_key)
        delay = 0.5
        last_error: Exception | None = None

        for attempt in range(_EMBED_RETRIES + 1):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        client.models.embed_content,
                        model="gemini-embedding-2",
                        contents=text,
                        config=genai_types.EmbedContentConfig(
                            task_type="RETRIEVAL_QUERY"
                        ),
                    ),
                    timeout=_EMBED_TIMEOUT_S,
                )
                return response.embeddings[0].values
            except Exception as e:
                last_error = e
                if attempt < _EMBED_RETRIES:
                    logger.warning(
                        "Query embedding failed (attempt %d): %s", attempt + 1, e
                    )
                    await asyncio.sleep(delay)
                    delay *= 2

        raise RuntimeError(f"Query embedding failed after retries: {last_error}")

    @staticmethod
    def _payload_to_chunk(p: dict) -> Chunk:
        return Chunk(
            chunk_id=p.get("chunk_id", ""),
            doc_id=p.get("doc_id", ""),
            doc_name=p.get("doc_name", ""),
            text=p.get("text", ""),
            page_number=p.get("page_number")
            if p.get("page_number", -1) != -1
            else None,
            section_title=p.get("section_title") or None,
            char_offset_start=p.get("char_offset_start", 0),
            char_offset_end=p.get("char_offset_end", 0),
            chunk_index=p.get("chunk_index", 0),
        )

    # ------------------------------------------------------------------
    # Graph search
    # ------------------------------------------------------------------

    def graph_search(self, query: str, top_k: int = 5) -> list[ScoredChunk]:
        """Traverse knowledge graph for concepts matching query keywords."""
        try:
            query_words = set(query.lower().split())
            matched: dict[str, tuple[Chunk, float]] = {}

            for concept_name, concept_id in self._kg._by_name.items():
                node = self._kg._nodes.get(concept_id)
                if not node:
                    continue
                concept_words = set(concept_name.split())
                overlap = len(query_words & concept_words) / max(len(concept_words), 1)
                if overlap < 0.3:
                    continue

                related = self._kg.get_prerequisites(node.name)
                for n in [node] + related:
                    for chunk_id in n.chunk_ids:
                        if chunk_id in matched:
                            continue
                        try:
                            points = vs.get_points_by_doc_id(
                                self._client, self._collection, n.doc_id
                            )
                            for pt in points:
                                if pt["payload"].get("chunk_id") == chunk_id:
                                    chunk = self._payload_to_chunk(pt["payload"])
                                    matched[chunk_id] = (chunk, overlap)
                                    break
                        except Exception:
                            pass

            scored = [
                ScoredChunk(chunk=chunk, score=score, source="graph")
                for chunk, score in matched.values()
            ]
            return sorted(scored, key=lambda x: x.score, reverse=True)[:top_k]
        except Exception as e:
            logger.error("Graph search failed: %s", e)
            return []

    # ------------------------------------------------------------------
    # RRF reranking
    # ------------------------------------------------------------------

    def rerank_rrf(
        self,
        vector_results: list[ScoredChunk],
        graph_results: list[ScoredChunk],
    ) -> list[ScoredChunk]:
        rrf_scores: dict[str, float] = {}
        chunk_map: dict[str, Chunk] = {}

        for rank, sc in enumerate(vector_results):
            cid = sc.chunk.chunk_id
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (_RRF_K + rank + 1)
            chunk_map[cid] = sc.chunk

        for rank, sc in enumerate(graph_results):
            cid = sc.chunk.chunk_id
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + 1.0 / (_RRF_K + rank + 1)
            chunk_map[cid] = sc.chunk

        return [
            ScoredChunk(chunk=chunk_map[cid], score=score, source="fused")
            for cid, score in sorted(
                rrf_scores.items(), key=lambda x: x[1], reverse=True
            )
        ]

    # ------------------------------------------------------------------
    # Diagram recipe collection
    # ------------------------------------------------------------------

    def _collect_diagram_recipes(
        self, chunks: list[ScoredChunk]
    ) -> list[DiagramRecipe]:
        """Extract diagram recipes from chunk payloads, deduplicated by page."""
        import json as _json

        seen_pages: set[int] = set()
        recipes: list[DiagramRecipe] = []

        # Fetch payloads for top chunks to get diagram_recipe field
        for sc in chunks:
            try:
                points = vs.get_points_by_doc_id(
                    self._client, self._collection, sc.chunk.doc_id
                )
                for pt in points:
                    p = pt["payload"]
                    if p.get("chunk_id") != sc.chunk.chunk_id:
                        continue
                    raw = p.get("diagram_recipe", "")
                    if not raw:
                        break
                    data = _json.loads(raw)
                    page = data.get("page_number")
                    if page and page not in seen_pages:
                        seen_pages.add(page)
                        recipes.append(
                            DiagramRecipe(
                                page_number=page,
                                description=data.get("description", ""),
                                image_b64=data.get("image_b64", ""),
                            )
                        )
                    break
            except Exception as e:
                logger.warning("Failed to collect diagram recipe: %s", e)

        return recipes

    # ------------------------------------------------------------------
    # Context assembly
    # ------------------------------------------------------------------

    def assemble_context(
        self, chunks: list[ScoredChunk], turn_id: str
    ) -> RetrievalContext:
        if not chunks:
            return RetrievalContext(
                turn_id=turn_id, context_text="", sources=[], is_general_knowledge=True
            )

        context_parts: list[str] = []
        sources: list[SourceAttribution] = []

        for sc in chunks:
            chunk = sc.chunk
            relevance = (
                "high" if sc.score > _HIGH_RELEVANCE_THRESHOLD else "supplementary"
            )
            source = SourceAttribution(
                chunk_id=chunk.chunk_id,
                document_name=chunk.doc_name,
                page_number=chunk.page_number,
                section_title=chunk.section_title,
                text_excerpt=chunk.text[:200],
                relevance=relevance,
                score=sc.score,
            )
            sources.append(source)
            location = f"p.{chunk.page_number}" if chunk.page_number else "§"
            section = f" [{chunk.section_title}]" if chunk.section_title else ""
            context_parts.append(
                f"[Source: {chunk.doc_name}{section}, {location}]\n{chunk.text}"
            )

        diagram_recipes = self._collect_diagram_recipes(chunks)

        return RetrievalContext(
            turn_id=turn_id,
            context_text="\n\n---\n\n".join(context_parts),
            sources=sources,
            is_general_knowledge=False,
            diagram_recipes=diagram_recipes,
        )

    # ------------------------------------------------------------------
    # Main retrieve
    # ------------------------------------------------------------------

    async def retrieve(
        self,
        query: str,
        turn_id: str,
        top_k: int = 5,
        threshold: float = _DEFAULT_THRESHOLD,
    ) -> RetrievalResult:
        start = time.monotonic()
        try:
            vector_results, graph_results = await asyncio.gather(
                self.vector_search(query, top_k=top_k * 2),
                asyncio.to_thread(self.graph_search, query, top_k=top_k),
            )

            vector_filtered = [sc for sc in vector_results if sc.score >= threshold]
            graph_filtered = [sc for sc in graph_results if sc.score >= threshold]

            fused = self.rerank_rrf(vector_filtered, graph_filtered)
            top = fused[:top_k]

            context = self.assemble_context(top, turn_id)
            elapsed_ms = (time.monotonic() - start) * 1000

            logger.info(
                "Retrieval: %d chunks (threshold=%.2f, %.0fms)",
                len(top),
                threshold,
                elapsed_ms,
            )
            RAG_RETRIEVAL_LATENCY_SECONDS.observe(elapsed_ms / 1000)
            return RetrievalResult(context=context, elapsed_ms=elapsed_ms)
        except Exception as e:
            elapsed_ms = (time.monotonic() - start) * 1000
            RAG_RETRIEVAL_ERRORS_TOTAL.inc()
            logger.error("Retrieval failed: %s", e)
            context = RetrievalContext(
                turn_id=turn_id, context_text="", sources=[], is_general_knowledge=True
            )
            return RetrievalResult(context=context, elapsed_ms=elapsed_ms)
