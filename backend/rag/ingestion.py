"""Document ingestion pipeline: parse → chunk → embed → extract concepts → store."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from .knowledge_graph import KnowledgeGraph
from .models import (
    Chunk,
    ChunkWithEmbedding,
    ConceptNode,
    ConceptRelationship,
    IngestionResult,
    RelationType,
)

logger = logging.getLogger("tablo-rag.ingestion")

_CHROMA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "chromadb")
_COLLECTION_NAME = "tablo_chunks"
_HIGH_RELEVANCE_THRESHOLD = 0.7
_MAX_CHUNK_CHARS = 1200
_MIN_CHUNK_CHARS = 100


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
    """Offline document ingestion: parse → chunk → embed → store."""

    def __init__(self, knowledge_graph: KnowledgeGraph) -> None:
        self._kg = knowledge_graph
        self._chroma_client = None
        self._collection = None
        self._doc_metadata: dict[str, dict] = {}  # doc_id -> metadata dict
        self._init_chroma()

    def _init_chroma(self) -> None:
        try:
            import chromadb
            os.makedirs(_CHROMA_PATH, exist_ok=True)
            self._chroma_client = chromadb.PersistentClient(path=_CHROMA_PATH)
            self._collection = self._chroma_client.get_or_create_collection(
                name=_COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
            logger.info("ChromaDB initialised at %s (collection: %s)", _CHROMA_PATH, _COLLECTION_NAME)
        except Exception as e:
            logger.error("Failed to initialise ChromaDB: %s", e)
            raise

    @staticmethod
    def _get_genai_client():
        """Return a configured google.genai Client."""
        from google import genai
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not api_key:
            logger.warning("No GOOGLE_API_KEY or GEMINI_API_KEY found — Gemini calls will fail")
        return genai.Client(api_key=api_key)

    # ------------------------------------------------------------------
    # Parsing
    # ------------------------------------------------------------------

    def parse_pdf(self, file_path: str) -> ParsedDocument:
        """Extract text with page/section structure using PyMuPDF."""
        try:
            import fitz  # PyMuPDF
        except ImportError as exc:
            raise RuntimeError("PyMuPDF (fitz) is not installed. Run: pip install pymupdf") from exc

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
                    if block.get("type") != 0:  # 0 = text block
                        continue
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            text = span.get("text", "").strip()
                            if not text:
                                continue
                            font_size = span.get("size", 0)
                            flags = span.get("flags", 0)
                            is_bold = bool(flags & 2**4)
                            # Heuristic: large or bold text at start of block = section heading
                            if font_size >= 14 or (is_bold and font_size >= 12):
                                if section_title is None:
                                    section_title = text
                            page_text_parts.append(text)

                page_text = " ".join(page_text_parts)
                if page_text.strip():
                    start = char_offset
                    end = char_offset + len(page_text)
                    pages.append(ParsedPage(
                        page_number=page_num + 1,
                        section_title=section_title,
                        text=page_text,
                        char_offset_start=start,
                        char_offset_end=end,
                    ))
                    char_offset = end + 1
            except Exception as e:
                raise ValueError(f"Failed to parse PDF '{doc_name}' at page {page_num + 1}: {e}") from e

        pdf.close()
        return ParsedDocument(
            doc_id=doc_id,
            doc_name=doc_name,
            format="pdf",
            pages=pages,
            total_chars=char_offset,
        )

    def parse_text(self, file_path: str) -> ParsedDocument:
        """Parse plain text preserving paragraph structure."""
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
            # Detect section headings: all-caps line or line ending with colon
            first_line = para.split("\n")[0].strip()
            if first_line.isupper() or first_line.endswith(":"):
                section_title = first_line

            start = char_offset
            end = char_offset + len(para)
            pages.append(ParsedPage(
                page_number=None,
                section_title=section_title,
                text=para,
                char_offset_start=start,
                char_offset_end=end,
            ))
            char_offset = end + 2  # account for double newline

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
        """Split into semantic chunks respecting section/paragraph boundaries."""
        chunks: list[Chunk] = []
        chunk_index = 0

        for page in parsed.pages:
            # Split page text into sentences, then group into chunks
            sentences = self._split_sentences(page.text)
            current_sentences: list[str] = []
            current_len = 0
            current_offset = page.char_offset_start

            for sentence in sentences:
                sentence_len = len(sentence)
                if current_len + sentence_len > _MAX_CHUNK_CHARS and current_sentences:
                    # Flush current chunk
                    chunk_text = " ".join(current_sentences)
                    chunks.append(Chunk(
                        chunk_id=str(uuid4()),
                        doc_id=parsed.doc_id,
                        doc_name=parsed.doc_name,
                        text=chunk_text,
                        page_number=page.page_number,
                        section_title=page.section_title,
                        char_offset_start=current_offset,
                        char_offset_end=current_offset + len(chunk_text),
                        chunk_index=chunk_index,
                    ))
                    chunk_index += 1
                    current_offset += len(chunk_text) + 1
                    current_sentences = []
                    current_len = 0

                current_sentences.append(sentence)
                current_len += sentence_len + 1

            # Flush remaining sentences
            if current_sentences:
                chunk_text = " ".join(current_sentences)
                if len(chunk_text) >= _MIN_CHUNK_CHARS:
                    chunks.append(Chunk(
                        chunk_id=str(uuid4()),
                        doc_id=parsed.doc_id,
                        doc_name=parsed.doc_name,
                        text=chunk_text,
                        page_number=page.page_number,
                        section_title=page.section_title,
                        char_offset_start=current_offset,
                        char_offset_end=current_offset + len(chunk_text),
                        chunk_index=chunk_index,
                    ))
                    chunk_index += 1

        return chunks

    def _split_sentences(self, text: str) -> list[str]:
        """Split text into sentences without breaking mid-sentence."""
        # Simple sentence splitter on . ! ? followed by whitespace
        parts = re.split(r"(?<=[.!?])\s+", text.strip())
        return [p.strip() for p in parts if p.strip()]

    # ------------------------------------------------------------------
    # Embedding
    # ------------------------------------------------------------------

    async def generate_embeddings(self, chunks: list[Chunk]) -> list[ChunkWithEmbedding]:
        """Generate embeddings via gemini-embedding-2 (multimodal) with retry."""
        results: list[ChunkWithEmbedding] = []
        for chunk in chunks:
            embedding = await self._embed_with_retry(chunk.text, task_type="RETRIEVAL_DOCUMENT")
            results.append(ChunkWithEmbedding(chunk=chunk, embedding=embedding))
        return results

    async def _embed_with_retry(self, text: str, task_type: str, retries: int = 2) -> list[float]:
        from google.genai import types as genai_types

        client = self._get_genai_client()
        delay = 1.0
        last_error: Exception | None = None
        for attempt in range(retries + 1):
            try:
                response = client.models.embed_content(
                    model="gemini-embedding-2",
                    contents=text,
                    config=genai_types.EmbedContentConfig(task_type=task_type),
                )
                return response.embeddings[0].values
            except Exception as e:
                last_error = e
                if attempt < retries:
                    logger.warning("Embedding attempt %d failed: %s — retrying in %.1fs", attempt + 1, e, delay)
                    await asyncio.sleep(delay)
                    delay *= 2
        raise RuntimeError(f"Embedding generation failed after {retries + 1} attempts: {last_error}") from last_error

    # ------------------------------------------------------------------
    # Concept extraction
    # ------------------------------------------------------------------

    async def extract_concepts(self, chunks: list[Chunk]) -> list[ConceptNode]:
        """Extract concept nodes and relationships using Gemini Flash."""
        if not chunks:
            return []

        # Build a sample of text to extract concepts from (first 3000 chars)
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

        try:
            client = self._get_genai_client()
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
            )
            raw = response.text.strip() if response.text else ""
            # Strip markdown code fences if present
            raw = re.sub(r"^```(?:json)?\s*", "", raw)
            raw = re.sub(r"\s*```$", "", raw)
            concept_data = json.loads(raw)
        except Exception as e:
            logger.warning("Concept extraction failed: %s — continuing without concepts", e)
            return []

        nodes: list[ConceptNode] = []
        name_to_id: dict[str, str] = {}

        for item in concept_data:
            name = item.get("name", "").strip()
            if not name:
                continue
            cid = str(uuid4())
            name_to_id[name.lower()] = cid
            # Associate with chunks that mention this concept
            related_chunk_ids = [
                c.chunk_id for c in chunks
                if name.lower() in c.text.lower()
            ]
            node = ConceptNode(
                concept_id=cid,
                name=name,
                doc_id=chunks[0].doc_id,
                chunk_ids=related_chunk_ids,
            )
            nodes.append(node)
            self._kg.add_concept(node)

        # Add relationships
        for item, node in zip(concept_data, nodes):
            for rel in item.get("relationships", []):
                target_name = rel.get("target", "").strip().lower()
                rel_type_str = rel.get("type", "")
                target_id = name_to_id.get(target_name)
                if target_id and rel_type_str in RelationType._value2member_map_:
                    self._kg.add_relationship(node.concept_id, target_id, RelationType(rel_type_str))

        return nodes

    # ------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------

    async def store(self, chunks: list[ChunkWithEmbedding], concepts: list[ConceptNode]) -> None:
        """Write chunks to ChromaDB and concepts to KnowledgeGraph."""
        if not chunks:
            return
        try:
            ids = [c.chunk.chunk_id for c in chunks]
            documents = [c.chunk.text for c in chunks]
            embeddings = [c.embedding for c in chunks]
            metadatas = [
                {
                    "chunk_id": c.chunk.chunk_id,
                    "doc_id": c.chunk.doc_id,
                    "doc_name": c.chunk.doc_name,
                    "page_number": c.chunk.page_number if c.chunk.page_number is not None else -1,
                    "section_title": c.chunk.section_title or "",
                    "char_offset_start": c.chunk.char_offset_start,
                    "char_offset_end": c.chunk.char_offset_end,
                    "chunk_index": c.chunk.chunk_index,
                }
                for c in chunks
            ]
            self._collection.add(
                ids=ids,
                documents=documents,
                embeddings=embeddings,
                metadatas=metadatas,
            )
            logger.info("Stored %d chunks in ChromaDB", len(chunks))
        except Exception as e:
            # Clean up partial state
            try:
                ids_to_remove = [c.chunk.chunk_id for c in chunks]
                self._collection.delete(ids=ids_to_remove)
            except Exception:
                pass
            raise RuntimeError(f"Failed to store document chunks: {e}") from e

    # ------------------------------------------------------------------
    # Deletion
    # ------------------------------------------------------------------

    def delete_document(self, doc_id: str) -> int:
        """Remove all chunks for a document from ChromaDB. Returns chunk count removed."""
        results = self._collection.get(where={"doc_id": doc_id})
        ids = results.get("ids", [])
        if ids:
            self._collection.delete(ids=ids)
        self._kg.remove_document_concepts(doc_id)
        self._doc_metadata.pop(doc_id, None)
        logger.info("Deleted %d chunks for doc_id=%s", len(ids), doc_id)
        return len(ids)

    def list_documents(self) -> list[dict]:
        """Return document metadata from ChromaDB."""
        try:
            results = self._collection.get(include=["metadatas"])
            metadatas = results.get("metadatas") or []
            # Group by doc_id
            docs: dict[str, dict] = {}
            for m in metadatas:
                did = m.get("doc_id", "")
                if did not in docs:
                    docs[did] = {
                        "doc_id": did,
                        "name": m.get("doc_name", ""),
                        "chunk_count": 0,
                    }
                docs[did]["chunk_count"] += 1
            return list(docs.values())
        except Exception as e:
            logger.error("Failed to list documents: %s", e)
            return []

    # ------------------------------------------------------------------
    # Orchestration
    # ------------------------------------------------------------------

    async def ingest_document(self, file_path: str, doc_name: str) -> IngestionResult:
        """Full pipeline: parse → chunk → embed → extract concepts → store."""
        ext = os.path.splitext(file_path)[1].lower().lstrip(".")
        if ext not in ("pdf", "txt"):
            raise ValueError(f"Unsupported format '{ext}'. Supported: pdf, txt")

        # Parse
        if ext == "pdf":
            parsed = self.parse_pdf(file_path)
        else:
            parsed = self.parse_text(file_path)

        if not parsed.pages:
            raise ValueError("Document contains no extractable text")

        # Chunk
        chunks = self.chunk_document(parsed)
        if not chunks:
            raise ValueError("Document produced no chunks after parsing")

        # Embed
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

        # Extract concepts (non-fatal)
        concepts = await self.extract_concepts(chunks)

        # Store
        await self.store(chunks_with_embeddings, concepts)

        # Persist KG
        try:
            self._kg.save()
        except Exception as e:
            logger.warning("Failed to persist knowledge graph: %s", e)

        return IngestionResult(
            doc_id=parsed.doc_id,
            chunk_count=len(chunks),
            concept_count=len(concepts),
            status="complete",
        )
