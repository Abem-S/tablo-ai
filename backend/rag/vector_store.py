"""Qdrant vector store — thin wrapper used by ingestion and retrieval.

Each user gets their own Qdrant collection: tablo_{user_id}
A shared collection tablo_shared is used when no user_id is provided
(single-user / open-source mode).

Connection is configured via env vars:
  QDRANT_URL    — defaults to http://localhost:6333
  QDRANT_API_KEY — optional, required for Qdrant Cloud
"""
from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("tablo-rag.vector_store")

# Gemini embedding-2 produces 3072-dim vectors
VECTOR_DIM = 3072
COLLECTION_PREFIX = "tablo_"
SHARED_COLLECTION = "tablo_shared"

# Distance metric — Cosine works best with Gemini embeddings
DISTANCE = "COSINE"


def _get_client():
    """Return a configured Qdrant client (lazy import)."""
    from qdrant_client import QdrantClient
    url = os.getenv("QDRANT_URL", "http://localhost:6333")
    api_key = os.getenv("QDRANT_API_KEY")  # None for local, set for Qdrant Cloud
    return QdrantClient(url=url, api_key=api_key, timeout=30)


def collection_name(user_id: str | None = None) -> str:
    """Return the Qdrant collection name for a given user."""
    if not user_id:
        return SHARED_COLLECTION
    # Sanitise: only alphanumeric and underscores
    safe = "".join(c if c.isalnum() or c == "_" else "_" for c in user_id)
    return f"{COLLECTION_PREFIX}{safe}"


def ensure_collection(client, name: str) -> None:
    """Create the collection if it doesn't exist, with payload indexes for fast filtering."""
    from qdrant_client.models import Distance, VectorParams, PayloadSchemaType
    existing = {c.name for c in client.get_collections().collections}
    if name not in existing:
        client.create_collection(
            collection_name=name,
            vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
        )
        logger.info("Created Qdrant collection with payload indexes: %s", name)
    else:
        logger.debug("Qdrant collection already exists: %s", name)
    # Always ensure indexes exist (idempotent — safe to call on existing collections)
    _ensure_payload_indexes(client, name)


def _ensure_payload_indexes(client, name: str) -> None:
    """Create payload indexes if they don't already exist. Idempotent."""
    from qdrant_client.models import PayloadSchemaType
    try:
        info = client.get_collection(name)
        existing_indexes = set(info.payload_schema.keys()) if info.payload_schema else set()
        for field, schema in [
            ("doc_id", PayloadSchemaType.KEYWORD),
            ("page_number", PayloadSchemaType.INTEGER),
            ("chunk_index", PayloadSchemaType.INTEGER),
        ]:
            if field not in existing_indexes:
                client.create_payload_index(collection_name=name, field_name=field, field_schema=schema)
                logger.debug("Created payload index: %s.%s", name, field)
    except Exception as e:
        logger.warning("Could not ensure payload indexes for %s: %s", name, e)


def upsert_chunks(
    client,
    collection: str,
    ids: list[str],
    vectors: list[list[float]],
    payloads: list[dict[str, Any]],
) -> None:
    """Upsert points into a Qdrant collection."""
    from qdrant_client.models import PointStruct
    points = [
        PointStruct(id=_str_to_uuid(id_), vector=vec, payload=payload)
        for id_, vec, payload in zip(ids, vectors, payloads)
    ]
    client.upsert(collection_name=collection, points=points)
    logger.debug("Upserted %d points into %s", len(points), collection)


def search_vectors(
    client,
    collection: str,
    query_vector: list[float],
    top_k: int = 10,
    filter_: dict | None = None,
) -> list[dict[str, Any]]:
    """Search a collection. Returns list of {id, score, payload} dicts."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue, QueryRequest

    qdrant_filter = None
    if filter_:
        conditions = [
            FieldCondition(key=k, match=MatchValue(value=v))
            for k, v in filter_.items()
        ]
        qdrant_filter = Filter(must=conditions)

    results = client.query_points(
        collection_name=collection,
        query=query_vector,
        limit=top_k,
        query_filter=qdrant_filter,
        with_payload=True,
    )
    return [
        {"id": str(r.id), "score": r.score, "payload": r.payload}
        for r in results.points
    ]


def delete_by_doc_id(client, collection: str, doc_id: str) -> int:
    """Delete all points with a given doc_id. Returns count deleted."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    # Scroll to count first
    points, _ = client.scroll(
        collection_name=collection,
        scroll_filter=Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]),
        limit=10000,
        with_payload=False,
    )
    count = len(points)
    if count:
        client.delete(
            collection_name=collection,
            points_selector=Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]),
        )
    logger.info("Deleted %d points for doc_id=%s from %s", count, doc_id, collection)
    return count


def list_docs_in_collection(client, collection: str) -> list[dict]:
    """Return document metadata grouped by doc_id."""
    from qdrant_client.models import Filter
    try:
        all_points = []
        offset = None
        while True:
            batch, next_offset = client.scroll(
                collection_name=collection,
                limit=1000,
                offset=offset,
                with_payload=True,
                with_vectors=False,
            )
            all_points.extend(batch)
            if next_offset is None:
                break
            offset = next_offset

        docs: dict[str, dict] = {}
        for pt in all_points:
            p = pt.payload or {}
            did = p.get("doc_id", "")
            if not did:
                continue
            if did not in docs:
                docs[did] = {"doc_id": did, "name": p.get("doc_name", ""), "chunk_count": 0}
            docs[did]["chunk_count"] += 1
        return list(docs.values())
    except Exception as e:
        logger.error("Failed to list docs in %s: %s", collection, e)
        return []


def get_points_by_doc_id(client, collection: str, doc_id: str) -> list[dict]:
    """Fetch all points for a doc_id. Returns list of payload dicts."""
    from qdrant_client.models import Filter, FieldCondition, MatchValue
    points, _ = client.scroll(
        collection_name=collection,
        scroll_filter=Filter(must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]),
        limit=10000,
        with_payload=True,
        with_vectors=False,
    )
    return [{"id": str(p.id), "payload": p.payload} for p in points]


def update_payloads(client, collection: str, updates: list[tuple[str, dict]]) -> None:
    """Update payloads for a list of (point_id, payload_patch) tuples."""
    for point_id, patch in updates:
        client.set_payload(
            collection_name=collection,
            payload=patch,
            points=[_str_to_uuid(point_id)],
        )


def _str_to_uuid(s: str) -> str:
    """Qdrant requires UUID-format IDs. Our chunk_ids are already UUID4 strings."""
    return s
