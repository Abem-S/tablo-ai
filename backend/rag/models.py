"""Data models for the Tablo RAG system."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class RelationType(str, Enum):
    PREREQUISITE = "prerequisite"
    RELATED_TOPIC = "related_topic"
    SUBTOPIC = "subtopic"


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    doc_name: str
    text: str
    page_number: int | None
    section_title: str | None
    char_offset_start: int
    char_offset_end: int
    chunk_index: int


@dataclass
class ChunkWithEmbedding:
    chunk: Chunk
    embedding: list[float]


@dataclass
class ScoredChunk:
    chunk: Chunk
    score: float          # 0.0–1.0
    source: str           # "vector" | "graph" | "fused"


@dataclass
class ConceptNode:
    concept_id: str
    name: str
    doc_id: str
    chunk_ids: list[str] = field(default_factory=list)


@dataclass
class ConceptRelationship:
    source_concept: str   # concept_id
    target_concept: str   # concept_id
    rel_type: RelationType


@dataclass
class SourceAttribution:
    chunk_id: str
    document_name: str
    page_number: int | None
    section_title: str | None
    text_excerpt: str     # first ~200 chars of chunk
    relevance: str        # "high" | "supplementary"
    score: float


@dataclass
class RetrievalContext:
    turn_id: str
    context_text: str
    sources: list[SourceAttribution]
    is_general_knowledge: bool


@dataclass
class DocumentMetadata:
    doc_id: str
    name: str
    format: str           # "pdf" | "txt"
    page_count: int | None
    chunk_count: int
    concept_count: int
    ingestion_status: str  # "processing" | "complete" | "failed"
    ingested_at: str       # ISO timestamp
    error_message: str | None = None


@dataclass
class IngestionResult:
    doc_id: str
    chunk_count: int
    concept_count: int
    status: str           # "complete" | "failed"
    error_message: str | None = None


@dataclass
class RetrievalResult:
    context: RetrievalContext
    elapsed_ms: float
