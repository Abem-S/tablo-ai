"""Hybrid retrieval pipeline: vector search + knowledge graph + RRF reranking."""
from __future__ import annotations

import asyncio
import logging
import os
import time
from uuid import uuid4

from .knowledge_graph import KnowledgeGraph
from .models import (
    Chunk,
    RetrievalContext,
    RetrievalResult,
    ScoredChunk,
    SourceAttribution,
)

logger = logging.getLogger("tablo-rag.retrieval")

_HIGH_RELEVANCE_THRESHOLD = 0.7
_DEFAULT_THRESHOLD = 0.3
_RETRIEVAL_TIMEOUT_S = 5.0
_RRF_K = 60  # standard RRF constant
# RRF scores are 1/(k+rank) — max possible with k=60 is ~0.016 for rank 0.
# We filter on raw cosine scores before RRF, then use a separate RRF floor.
_RRF_SCORE_FLOOR = 0.0  # no floor — pre-filter handles quality


class RetrievalPipeline:
    """Hybrid retrieval: vector search + knowledge graph + RRF reranking."""

    def __init__(self, knowledge_graph: KnowledgeGraph, chroma_collection) -> None:
        self._kg = knowledge_graph
        self._collection = chroma_collection

    # ------------------------------------------------------------------
    # Vector search
    # ------------------------------------------------------------------

    async def vector_search(self, query: str, top_k: int = 10) -> list[ScoredChunk]:
        """Embed query and search ChromaDB. Returns empty list on timeout/error."""
        try:
            embedding = await asyncio.wait_for(
                self._embed_query(query),
                timeout=_RETRIEVAL_TIMEOUT_S,
            )
            results = self._collection.query(
                query_embeddings=[embedding],
                n_results=min(top_k, max(1, self._collection.count())),
                include=["documents", "metadatas", "distances"],
            )
            scored: list[ScoredChunk] = []
            ids = results.get("ids", [[]])[0]
            metadatas = results.get("metadatas", [[]])[0]
            distances = results.get("distances", [[]])[0]
            documents = results.get("documents", [[]])[0]

            for i, cid in enumerate(ids):
                meta = metadatas[i]
                distance = distances[i]
                # ChromaDB cosine distance: 0 = identical, 2 = opposite
                # Convert to similarity score 0–1
                score = max(0.0, 1.0 - distance / 2.0)
                chunk = Chunk(
                    chunk_id=meta.get("chunk_id", cid),
                    doc_id=meta.get("doc_id", ""),
                    doc_name=meta.get("doc_name", ""),
                    text=documents[i] if i < len(documents) else "",
                    page_number=meta.get("page_number") if meta.get("page_number", -1) != -1 else None,
                    section_title=meta.get("section_title") or None,
                    char_offset_start=meta.get("char_offset_start", 0),
                    char_offset_end=meta.get("char_offset_end", 0),
                    chunk_index=meta.get("chunk_index", 0),
                )
                scored.append(ScoredChunk(chunk=chunk, score=score, source="vector"))
            return scored
        except asyncio.TimeoutError:
            logger.warning("Vector search timed out after %.1fs", _RETRIEVAL_TIMEOUT_S)
            return []
        except Exception as e:
            logger.error("Vector search failed: %s", e)
            return []

    async def _embed_query(self, text: str) -> list[float]:
        from google import genai
        from google.genai import types as genai_types
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        client = genai.Client(api_key=api_key)
        response = client.models.embed_content(
            model="gemini-embedding-2",
            contents=text,
            config=genai_types.EmbedContentConfig(task_type="RETRIEVAL_QUERY"),
        )
        return response.embeddings[0].values

    # ------------------------------------------------------------------
    # Graph search
    # ------------------------------------------------------------------

    def graph_search(self, query: str, top_k: int = 5) -> list[ScoredChunk]:
        """Traverse knowledge graph for concepts matching query keywords."""
        try:
            query_words = set(query.lower().split())
            matched_chunks: dict[str, tuple[Chunk, float]] = {}

            for concept_name, concept_id in self._kg._by_name.items():
                node = self._kg._nodes.get(concept_id)
                if not node:
                    continue
                # Simple keyword overlap score
                concept_words = set(concept_name.split())
                overlap = len(query_words & concept_words) / max(len(concept_words), 1)
                if overlap < 0.3:
                    continue

                # Also include prerequisite concepts for scaffolding
                related = self._kg.get_prerequisites(node.name)
                all_nodes = [node] + related

                for n in all_nodes:
                    for chunk_id in n.chunk_ids:
                        if chunk_id not in matched_chunks:
                            # Fetch chunk text from ChromaDB
                            try:
                                result = self._collection.get(ids=[chunk_id], include=["documents", "metadatas"])
                                if result["ids"]:
                                    meta = result["metadatas"][0]
                                    chunk = Chunk(
                                        chunk_id=chunk_id,
                                        doc_id=meta.get("doc_id", ""),
                                        doc_name=meta.get("doc_name", ""),
                                        text=result["documents"][0],
                                        page_number=meta.get("page_number") if meta.get("page_number", -1) != -1 else None,
                                        section_title=meta.get("section_title") or None,
                                        char_offset_start=meta.get("char_offset_start", 0),
                                        char_offset_end=meta.get("char_offset_end", 0),
                                        chunk_index=meta.get("chunk_index", 0),
                                    )
                                    matched_chunks[chunk_id] = (chunk, overlap)
                            except Exception:
                                pass

            scored = [
                ScoredChunk(chunk=chunk, score=score, source="graph")
                for chunk, score in matched_chunks.values()
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
        """Reciprocal Rank Fusion: merge, deduplicate, sort by RRF score."""
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

        fused = [
            ScoredChunk(chunk=chunk_map[cid], score=score, source="fused")
            for cid, score in sorted(rrf_scores.items(), key=lambda x: x[1], reverse=True)
        ]
        return fused

    # ------------------------------------------------------------------
    # Context assembly
    # ------------------------------------------------------------------

    def assemble_context(self, chunks: list[ScoredChunk], turn_id: str) -> RetrievalContext:
        """Build RetrievalContext with formatted text and SourceAttribution list."""
        if not chunks:
            return RetrievalContext(
                turn_id=turn_id,
                context_text="",
                sources=[],
                is_general_knowledge=True,
            )

        context_parts: list[str] = []
        sources: list[SourceAttribution] = []

        for sc in chunks:
            chunk = sc.chunk
            relevance = "high" if sc.score > _HIGH_RELEVANCE_THRESHOLD else "supplementary"
            text_excerpt = chunk.text[:200]

            source = SourceAttribution(
                chunk_id=chunk.chunk_id,
                document_name=chunk.doc_name,
                page_number=chunk.page_number,
                section_title=chunk.section_title,
                text_excerpt=text_excerpt,
                relevance=relevance,
                score=sc.score,
            )
            sources.append(source)

            # Build context text for injection
            location = f"p.{chunk.page_number}" if chunk.page_number else "§"
            section = f" [{chunk.section_title}]" if chunk.section_title else ""
            context_parts.append(
                f"[Source: {chunk.doc_name}{section}, {location}]\n{chunk.text}"
            )

        context_text = "\n\n---\n\n".join(context_parts)
        return RetrievalContext(
            turn_id=turn_id,
            context_text=context_text,
            sources=sources,
            is_general_knowledge=False,
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
        """Execute hybrid retrieval and return ranked chunks with attribution."""
        start = time.monotonic()

        vector_results, graph_results = await asyncio.gather(
            self.vector_search(query, top_k=top_k * 2),
            asyncio.to_thread(self.graph_search, query, top_k=top_k),
        )

        # Filter by cosine similarity BEFORE RRF (RRF scores are tiny fractions ~0.016)
        vector_filtered = [sc for sc in vector_results if sc.score >= threshold]
        graph_filtered = [sc for sc in graph_results if sc.score >= threshold]

        fused = self.rerank_rrf(vector_filtered, graph_filtered)
        top = fused[:top_k]

        context = self.assemble_context(top, turn_id)
        elapsed_ms = (time.monotonic() - start) * 1000

        logger.info(
            "Retrieval complete: %d chunks (threshold=%.2f, elapsed=%.0fms)",
            len(top), threshold, elapsed_ms,
        )
        return RetrievalResult(context=context, elapsed_ms=elapsed_ms)
