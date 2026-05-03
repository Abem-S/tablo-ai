"""Document ingestion pipeline: parse → chunk → embed → extract concepts → store.

Vector store: Qdrant (self-hosted or Qdrant Cloud).
Collection per user: tablo_{user_id} or tablo_shared for single-user mode.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from uuid import uuid4

from .knowledge_graph import KnowledgeGraph
from .models import (
    Chunk,
    ChunkWithEmbedding,
    ConceptNode,
    DiagramRecipe,
    IngestionResult,
    RelationType,
)
from . import vector_store as vs
from config import get_env

logger = logging.getLogger("tablo-rag.ingestion")

_HIGH_RELEVANCE_THRESHOLD = 0.7
_MAX_CHUNK_CHARS = 1200
_MIN_CHUNK_CHARS = 100
_PARSE_TIMEOUT_S = float(os.getenv("RAG_PARSE_TIMEOUT_S", "300"))
_EMBED_TIMEOUT_S = float(os.getenv("RAG_EMBED_TIMEOUT_S", "10"))
_EMBED_RETRIES = int(os.getenv("RAG_EMBED_RETRIES", "2"))
_CONCEPT_TIMEOUT_S = float(os.getenv("RAG_CONCEPT_TIMEOUT_S", "60"))
_CONCEPT_RETRIES = int(os.getenv("RAG_CONCEPT_RETRIES", "1"))


@dataclass
class ParsedPage:
    page_number: int | None
    section_title: str | None
    text: str
    char_offset_start: int
    char_offset_end: int


@dataclass
class ParsedDocument:
    doc_id: str
    doc_name: str
    format: str
    pages: list[ParsedPage]
    total_chars: int


class IngestionPipeline:
    """Offline document ingestion: parse → chunk → embed → store in Qdrant."""

    def __init__(
        self, knowledge_graph: KnowledgeGraph, user_id: str | None = None
    ) -> None:
        self._kg = knowledge_graph
        self._user_id = user_id
        self._collection = vs.collection_name(user_id)
        self._client = vs._get_client()
        self._ensure_collection()

    def _ensure_collection(self) -> None:
        try:
            vs.ensure_collection(self._client, self._collection)
            logger.info("Qdrant ready — collection: %s", self._collection)
        except Exception as e:
            logger.error(
                "Failed to connect to Qdrant at %s: %s",
                os.getenv("QDRANT_URL", "http://localhost:6333"),
                e,
            )
            raise

    @staticmethod
    def _get_genai_client():
        from google import genai

        api_key = get_env("GOOGLE_API_KEY") or get_env("GEMINI_API_KEY")
        if not api_key:
            return None
        return genai.Client(api_key=api_key)

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    def parse_pdf(self, file_path: str) -> ParsedDocument:
        try:
            import fitz
        except ImportError as exc:
            raise RuntimeError("PyMuPDF (fitz) is not installed.") from exc

        doc_name = os.path.basename(file_path)
        doc_id = str(uuid4())
        pages: list[ParsedPage] = []
        char_offset = 0

        try:
            pdf = fitz.open(file_path)
        except Exception as e:
            raise ValueError(f"Failed to open PDF '{doc_name}': {e}") from e

        for page_num in range(len(pdf)):
            try:
                page = pdf[page_num]
                blocks = page.get_text("dict")["blocks"]
                section_title: str | None = None
                page_text_parts: list[str] = []

                for block in blocks:
                    if block.get("type") != 0:
                        continue
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text = span.get("text", "").strip()
                            if not text:
                                continue
                            font_size = span.get("size", 0)
                            flags = span.get("flags", 0)
                            is_bold = bool(flags & 2**4)
                            if font_size >= 14 or (is_bold and font_size >= 12):
                                if section_title is None:
                                    section_title = text
                            page_text_parts.append(text)

                page_text = " ".join(page_text_parts)
                if page_text.strip():
                    start = char_offset
                    end = char_offset + len(page_text)
                    pages.append(
                        ParsedPage(
                            page_number=page_num + 1,
                            section_title=section_title,
                            text=page_text,
                            char_offset_start=start,
                            char_offset_end=end,
                        )
                    )
                    char_offset = end + 1
            except Exception as e:
                raise ValueError(
                    f"Failed to parse PDF '{doc_name}' at page {page_num + 1}: {e}"
                ) from e

        pdf.close()
        return ParsedDocument(
            doc_id=doc_id,
            doc_name=doc_name,
            format="pdf",
            pages=pages,
            total_chars=char_offset,
        )

    def parse_text(self, file_path: str) -> ParsedDocument:
        doc_name = os.path.basename(file_path)
        doc_id = str(uuid4())
        try:
            with open(file_path, encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            raise ValueError(f"Failed to read text file '{doc_name}': {e}") from e

        paragraphs = re.split(r"\n{2,}", content.strip())
        pages: list[ParsedPage] = []
        char_offset = 0
        section_title: str | None = None

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            first_line = para.split("\n")[0].strip()
            if first_line.isupper() or first_line.endswith(":"):
                section_title = first_line
            start = char_offset
            end = char_offset + len(para)
            pages.append(
                ParsedPage(
                    page_number=None,
                    section_title=section_title,
                    text=para,
                    char_offset_start=start,
                    char_offset_end=end,
                )
            )
            char_offset = end + 2

        return ParsedDocument(
            doc_id=doc_id,
            doc_name=doc_name,
            format="txt",
            pages=pages,
            total_chars=char_offset,
        )

    # ------------------------------------------------------------------
    # Chunking
    # ------------------------------------------------------------------

    def chunk_document(self, parsed: ParsedDocument) -> list[Chunk]:
        chunks: list[Chunk] = []
        chunk_index = 0

        for page in parsed.pages:
            sentences = self._split_sentences(page.text)
            current_sentences: list[str] = []
            current_len = 0
            current_offset = page.char_offset_start

            for sentence in sentences:
                sentence_len = len(sentence)
                if current_len + sentence_len > _MAX_CHUNK_CHARS and current_sentences:
                    chunk_text = " ".join(current_sentences)
                    chunks.append(
                        Chunk(
                            chunk_id=str(uuid4()),
                            doc_id=parsed.doc_id,
                            doc_name=parsed.doc_name,
                            text=chunk_text,
                            page_number=page.page_number,
                            section_title=page.section_title,
                            char_offset_start=current_offset,
                            char_offset_end=current_offset + len(chunk_text),
                            chunk_index=chunk_index,
                        )
                    )
                    chunk_index += 1
                    current_offset += len(chunk_text) + 1
                    current_sentences = []
                    current_len = 0
                current_sentences.append(sentence)
                current_len += sentence_len + 1

            if current_sentences:
                chunk_text = " ".join(current_sentences)
                if len(chunk_text) >= _MIN_CHUNK_CHARS:
                    chunks.append(
                        Chunk(
                            chunk_id=str(uuid4()),
                            doc_id=parsed.doc_id,
                            doc_name=parsed.doc_name,
                            text=chunk_text,
                            page_number=page.page_number,
                            section_title=page.section_title,
                            char_offset_start=current_offset,
                            char_offset_end=current_offset + len(chunk_text),
                            chunk_index=chunk_index,
                        )
                    )
                    chunk_index += 1

        return chunks

    def _split_sentences(self, text: str) -> list[str]:
        parts = re.split(r"(?<=[.!?])\s+", text.strip())
        return [p.strip() for p in parts if p.strip()]

    # ------------------------------------------------------------------
    # Embedding
    # ------------------------------------------------------------------

    async def generate_embeddings(
        self, chunks: list[Chunk]
    ) -> list[ChunkWithEmbedding]:
        """Generate embeddings for all chunks concurrently.

        gemini-embedding-2 doesn't support true batch input, but we can run
        multiple calls in parallel. Semaphore limits to 5 concurrent calls
        to stay within rate limits while being ~5x faster than sequential.
        """
        if not chunks:
            return []

        semaphore = asyncio.Semaphore(5)  # max 5 concurrent embedding calls

        async def embed_one(chunk: Chunk) -> ChunkWithEmbedding:
            async with semaphore:
                embedding = await self._embed_text_with_retry(
                    chunk.text, task_type="RETRIEVAL_DOCUMENT"
                )
                return ChunkWithEmbedding(chunk=chunk, embedding=embedding)

        results = await asyncio.gather(*[embed_one(c) for c in chunks])
        return list(results)

    async def _embed_text_with_retry(
        self, text: str, task_type: str, retries: int = _EMBED_RETRIES
    ) -> list[float]:
        from google.genai import types as genai_types

        client = self._get_genai_client()
        if client is None:
            raise RuntimeError("Gemini API key is not configured")

        delay = 1.0
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        client.models.embed_content,
                        model="gemini-embedding-2",
                        contents=text,
                        config=genai_types.EmbedContentConfig(task_type=task_type),
                    ),
                    timeout=_EMBED_TIMEOUT_S,
                )
                return response.embeddings[0].values
            except Exception as e:
                last_error = e
                if attempt < retries:
                    logger.warning(
                        "Embedding attempt %d failed: %s — retrying in %.1fs",
                        attempt + 1,
                        e,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    delay *= 2
        raise RuntimeError(
            f"Embedding failed after {retries + 1} attempts: {last_error}"
        ) from last_error

    async def embed_image(self, image_b64: str) -> list[float] | None:
        """Embed a base64 PNG image using gemini-embedding-2 multimodal capability.

        Returns None on failure (non-fatal — text embedding is the primary signal).
        """
        try:
            from google.genai import types as genai_types

            client = self._get_genai_client()
            if client is None:
                logger.warning(
                    "Image embedding skipped: Gemini API key is not configured"
                )
                return None
            # gemini-embedding-2 accepts inline image parts
            image_part = genai_types.Part.from_bytes(
                data=__import__("base64").b64decode(image_b64),
                mime_type="image/png",
            )
            response = await asyncio.wait_for(
                asyncio.to_thread(
                    client.models.embed_content,
                    model="gemini-embedding-2",
                    contents=image_part,
                    config=genai_types.EmbedContentConfig(
                        task_type="RETRIEVAL_DOCUMENT"
                    ),
                ),
                timeout=_EMBED_TIMEOUT_S,
            )
            return response.embeddings[0].values
        except Exception as e:
            logger.warning("Image embedding failed (non-fatal): %s", e)
            return None

    # ------------------------------------------------------------------
    # Concept extraction
    # ------------------------------------------------------------------

    async def extract_concepts(self, chunks: list[Chunk]) -> list[ConceptNode]:
        if not chunks:
            return []
        sample_text = "\n\n".join(c.text for c in chunks[:10])[:3000]
        prompt = (
            "Extract the key educational concepts from the following text. "
            "For each concept, identify its name and its relationships to other concepts "
            "(prerequisite, related_topic, or subtopic). "
            "Return a JSON array of objects with fields: "
            "name (string), relationships (array of {target: string, type: 'prerequisite'|'related_topic'|'subtopic'}). "
            "Return ONLY valid JSON, no markdown.\n\n"
            f"Text:\n{sample_text}"
        )
        client = self._get_genai_client()
        if client is None:
            logger.warning(
                "Concept extraction skipped: Gemini API key is not configured"
            )
            return []

        delay = 1.0
        for attempt in range(_CONCEPT_RETRIES + 1):
            try:
                response = await asyncio.wait_for(
                    asyncio.to_thread(
                        client.models.generate_content,
                        model="gemini-2.5-flash",
                        contents=prompt,
                    ),
                    timeout=_CONCEPT_TIMEOUT_S,
                )
                raw = response.text.strip() if response.text else ""
                raw = re.sub(r"^```(?:json)?\s*", "", raw)
                raw = re.sub(r"\s*```$", "", raw)
                concept_data = json.loads(raw)
                break
            except Exception as e:
                if attempt < _CONCEPT_RETRIES:
                    logger.warning(
                        "Concept extraction failed (attempt %d): %s — retrying",
                        attempt + 1,
                        e,
                    )
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue
                logger.warning(
                    "Concept extraction failed: %s — continuing without concepts", e
                )
                return []

        nodes: list[ConceptNode] = []
        name_to_id: dict[str, str] = {}

        for item in concept_data:
            name = item.get("name", "").strip()
            if not name:
                continue
            cid = str(uuid4())
            name_to_id[name.lower()] = cid
            related_chunk_ids = [
                c.chunk_id for c in chunks if name.lower() in c.text.lower()
            ]
            node = ConceptNode(
                concept_id=cid,
                name=name,
                doc_id=chunks[0].doc_id,
                chunk_ids=related_chunk_ids,
            )
            nodes.append(node)
            self._kg.add_concept(node)

        for item, node in zip(concept_data, nodes):
            for rel in item.get("relationships", []):
                target_name = rel.get("target", "").strip().lower()
                rel_type_str = rel.get("type", "")
                target_id = name_to_id.get(target_name)
                if target_id and rel_type_str in RelationType._value2member_map_:
                    self._kg.add_relationship(
                        node.concept_id, target_id, RelationType(rel_type_str)
                    )

        return nodes

    # ------------------------------------------------------------------
    # Diagram extraction helpers
    # ------------------------------------------------------------------

    async def _extract_diagrams(self, file_path: str) -> dict[int, DiagramRecipe]:
        try:
            from .diagram_extractor import DiagramExtractor

            client = self._get_genai_client()
            if client is None:
                logger.warning(
                    "Diagram extraction skipped: Gemini API key is not configured"
                )
                return {}
            extractor = DiagramExtractor(client)
            return await asyncio.wait_for(
                extractor.extract_all(file_path), timeout=120.0
            )
        except asyncio.TimeoutError:
            logger.warning("Diagram extraction timed out — continuing without diagrams")
            return {}
        except Exception as e:
            logger.warning(
                "Diagram extraction failed: %s — continuing without diagrams", e
            )
            return {}

    @staticmethod
    def _serialise_recipe(recipe: DiagramRecipe | None) -> str:
        if recipe is None:
            return ""
        try:
            return json.dumps(
                {
                    "page_number": recipe.page_number,
                    "description": recipe.description,
                    "image_b64": recipe.image_b64 or "",
                }
            )
        except Exception as e:
            logger.error("Failed to serialise DiagramRecipe: %s", e)
            return ""

    # ------------------------------------------------------------------
    # Storage (Qdrant)
    # ------------------------------------------------------------------

    async def store(
        self,
        chunks: list[ChunkWithEmbedding],
        concepts: list[ConceptNode],
        diagram_recipes: dict[int, DiagramRecipe] | None = None,
    ) -> None:
        """Write chunks to Qdrant. Each chunk becomes one point with full payload."""
        if not chunks:
            return

        ids = [c.chunk.chunk_id for c in chunks]
        vectors = [c.embedding for c in chunks]
        payloads = [
            {
                "chunk_id": c.chunk.chunk_id,
                "doc_id": c.chunk.doc_id,
                "doc_name": c.chunk.doc_name,
                "text": c.chunk.text,
                "page_number": c.chunk.page_number
                if c.chunk.page_number is not None
                else -1,
                "section_title": c.chunk.section_title or "",
                "char_offset_start": c.chunk.char_offset_start,
                "char_offset_end": c.chunk.char_offset_end,
                "chunk_index": c.chunk.chunk_index,
                "diagram_recipe": self._serialise_recipe(
                    diagram_recipes.get(c.chunk.page_number)
                    if diagram_recipes and c.chunk.page_number is not None
                    else None
                ),
            }
            for c in chunks
        ]

        try:
            vs.upsert_chunks(self._client, self._collection, ids, vectors, payloads)
            logger.info(
                "Stored %d chunks in Qdrant collection %s",
                len(chunks),
                self._collection,
            )
        except Exception as e:
            raise RuntimeError(f"Failed to store chunks in Qdrant: {e}") from e

        # Also embed and store diagram images directly for multimodal retrieval
        if diagram_recipes:
            await self._store_diagram_embeddings(
                diagram_recipes, chunks[0].chunk.doc_id, chunks[0].chunk.doc_name
            )

    async def _store_diagram_embeddings(
        self,
        diagram_recipes: dict[int, DiagramRecipe],
        doc_id: str,
        doc_name: str,
    ) -> None:
        """Embed diagram page images and store as separate points for visual retrieval."""
        for page_num, recipe in diagram_recipes.items():
            if not recipe.image_b64:
                continue
            embedding = await self.embed_image(recipe.image_b64)
            if embedding is None:
                continue
            point_id = str(uuid4())
            payload = {
                "chunk_id": point_id,
                "doc_id": doc_id,
                "doc_name": doc_name,
                "text": f"[Diagram on page {page_num}] {recipe.description}",
                "page_number": page_num,
                "section_title": "Diagram",
                "char_offset_start": 0,
                "char_offset_end": 0,
                "chunk_index": -1,  # marks as diagram point
                "diagram_recipe": self._serialise_recipe(recipe),
                "is_diagram_embedding": True,
            }
            try:
                vs.upsert_chunks(
                    self._client, self._collection, [point_id], [embedding], [payload]
                )
                logger.debug("Stored diagram embedding for page %d", page_num)
            except Exception as e:
                logger.warning(
                    "Failed to store diagram embedding for page %d: %s", page_num, e
                )

    # ------------------------------------------------------------------
    # Deletion
    # ------------------------------------------------------------------

    def delete_document(self, doc_id: str) -> int:
        count = vs.delete_by_doc_id(self._client, self._collection, doc_id)
        self._kg.remove_document_concepts(doc_id)
        return count

    def list_documents(self) -> list[dict]:
        return vs.list_docs_in_collection(self._client, self._collection)

    # ------------------------------------------------------------------
    # Supported formats
    # ------------------------------------------------------------------

    _SUPPORTED_FORMATS = frozenset(
        {
            "pdf",
            "txt",
            "docx",
            "doc",
            "pptx",
            "rtf",
            "png",
            "jpg",
            "jpeg",
            "webp",
            "heif",
            "xlsx",
            "xls",
            "csv",
            "tsv",
            "html",
            "hwp",
        }
    )
    _IMAGE_FORMATS = frozenset({"png", "jpg", "jpeg", "webp", "heif"})
    _DIAGRAM_FORMATS = frozenset({"pdf"}) | _IMAGE_FORMATS

    def _parse_by_format(self, file_path: str, ext: str) -> ParsedDocument:
        from . import parsers

        client = self._get_genai_client()
        if ext == "pdf":
            return self.parse_pdf(file_path)
        elif ext == "txt":
            return self.parse_text(file_path)
        elif ext == "docx":
            return parsers.parse_docx(file_path)
        elif ext == "doc":
            return parsers.parse_doc(file_path, client)
        elif ext == "pptx":
            return parsers.parse_pptx(file_path)
        elif ext == "rtf":
            return parsers.parse_rtf(file_path)
        elif ext in self._IMAGE_FORMATS:
            return parsers.parse_image(file_path, client)
        elif ext == "xlsx":
            return parsers.parse_xlsx(file_path)
        elif ext == "xls":
            return parsers.parse_xls(file_path)
        elif ext == "csv":
            return parsers.parse_csv_file(file_path, delimiter=",")
        elif ext == "tsv":
            return parsers.parse_csv_file(file_path, delimiter="\t")
        elif ext == "html":
            return parsers.parse_html(file_path)
        elif ext == "hwp":
            return parsers.parse_hwp(file_path, client)
        else:
            raise ValueError(f"Unsupported format '{ext}'")

    # ------------------------------------------------------------------
    # Orchestration
    # ------------------------------------------------------------------

    async def ingest_document_fast(
        self, file_path: str, doc_name: str
    ) -> IngestionResult:
        """Phase 1: parse → chunk → embed → store. Returns quickly."""
        ext = os.path.splitext(file_path)[1].lower().lstrip(".")
        if ext not in self._SUPPORTED_FORMATS:
            raise ValueError(f"Unsupported format '{ext}'")

        try:
            parsed = await asyncio.wait_for(
                asyncio.to_thread(self._parse_by_format, file_path, ext),
                timeout=_PARSE_TIMEOUT_S,
            )
        except asyncio.TimeoutError as e:
            raise ValueError(f"Parsing timed out after {_PARSE_TIMEOUT_S:.0f}s") from e
        except Exception as e:
            raise ValueError(f"Parsing failed: {e}") from e
        if not parsed.pages:
            raise ValueError("Document contains no extractable text")

        chunks = self.chunk_document(parsed)
        if not chunks:
            raise ValueError("Document produced no chunks after parsing")

        try:
            chunks_with_embeddings = await self.generate_embeddings(chunks)
        except RuntimeError as e:
            return IngestionResult(
                doc_id=parsed.doc_id,
                chunk_count=0,
                concept_count=0,
                status="failed",
                error_message=str(e),
            )

        concepts = await self.extract_concepts(chunks)
        await self.store(chunks_with_embeddings, concepts, diagram_recipes=None)

        try:
            self._kg.save()
        except Exception as e:
            logger.warning("Failed to persist knowledge graph: %s", e)

        return IngestionResult(
            doc_id=parsed.doc_id,
            chunk_count=len(chunks),
            concept_count=len(concepts),
            status="complete",
            diagram_count=0,
        )

    async def extract_and_attach_diagrams(self, file_path: str, doc_id: str) -> None:
        """Phase 2 (background): extract diagrams and update Qdrant payloads."""
        try:
            diagram_recipes = await self._extract_diagrams(file_path)
            if not diagram_recipes:
                logger.info("No diagrams found for doc_id=%s", doc_id)
                return

            # Fetch all points for this doc
            points = vs.get_points_by_doc_id(self._client, self._collection, doc_id)
            if not points:
                logger.warning(
                    "No points found for doc_id=%s when attaching diagrams", doc_id
                )
                return

            # Update diagram_recipe payload on matching page chunks
            updates = []
            for pt in points:
                page_num = pt["payload"].get("page_number", -1)
                recipe = diagram_recipes.get(page_num) if page_num != -1 else None
                if recipe:
                    updates.append(
                        (pt["id"], {"diagram_recipe": self._serialise_recipe(recipe)})
                    )

            if updates:
                vs.update_payloads(self._client, self._collection, updates)
                logger.info(
                    "Attached %d diagram recipes for doc_id=%s", len(updates), doc_id
                )

            # Also store diagram image embeddings
            doc_name = points[0]["payload"].get("doc_name", "") if points else ""
            await self._store_diagram_embeddings(diagram_recipes, doc_id, doc_name)

        except Exception as e:
            logger.error(
                "Background diagram extraction failed for doc_id=%s: %s", doc_id, e
            )
