"""Lightweight in-memory knowledge graph with JSON persistence."""

from __future__ import annotations

import json
import logging
import os
from collections import defaultdict

from .models import ConceptNode, ConceptRelationship, RelationType

logger = logging.getLogger("tablo-rag.kg")

_DEFAULT_PATH = os.path.join(
    os.path.dirname(__file__), "..", "data", "knowledge_graph.json"
)


class KnowledgeGraph:
    """In-memory concept graph with JSON persistence.

    Nodes are ConceptNodes keyed by concept_id.
    Edges are ConceptRelationships stored in adjacency lists keyed by source concept_id.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, ConceptNode] = {}  # concept_id -> ConceptNode
        self._by_name: dict[str, str] = {}  # name (lower) -> concept_id
        # adjacency: source_concept_id -> list[ConceptRelationship]
        self._edges: dict[str, list[ConceptRelationship]] = defaultdict(list)

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    def add_concept(self, node: ConceptNode) -> None:
        """Add or replace a concept node."""
        self._nodes[node.concept_id] = node
        self._by_name[node.name.lower()] = node.concept_id

    def add_relationship(
        self, source: str, target: str, rel_type: RelationType
    ) -> None:
        """Add a directed relationship between two concept IDs."""
        rel = ConceptRelationship(
            source_concept=source, target_concept=target, rel_type=rel_type
        )
        # Avoid duplicates
        existing = self._edges[source]
        for e in existing:
            if e.target_concept == target and e.rel_type == rel_type:
                return
        existing.append(rel)

    def remove_document_concepts(self, doc_id: str) -> None:
        """Remove all nodes and edges belonging to a document."""
        ids_to_remove = [
            cid for cid, node in self._nodes.items() if node.doc_id == doc_id
        ]
        for cid in ids_to_remove:
            node = self._nodes.pop(cid)
            self._by_name.pop(node.name.lower(), None)
            self._edges.pop(cid, None)
        # Remove edges pointing to removed nodes
        for src in list(self._edges.keys()):
            self._edges[src] = [
                e for e in self._edges[src] if e.target_concept not in ids_to_remove
            ]
            if not self._edges[src]:
                del self._edges[src]

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def query_by_name(self, name: str) -> ConceptNode | None:
        """Find a concept node by name (case-insensitive)."""
        cid = self._by_name.get(name.lower())
        return self._nodes.get(cid) if cid else None

    def get_related(
        self, concept_name: str, rel_type: RelationType | None = None
    ) -> list[ConceptNode]:
        """Return all concepts directly connected from concept_name, optionally filtered by rel_type."""
        node = self.query_by_name(concept_name)
        if not node:
            return []
        edges = self._edges.get(node.concept_id, [])
        result = []
        for e in edges:
            if rel_type is None or e.rel_type == rel_type:
                target = self._nodes.get(e.target_concept)
                if target:
                    result.append(target)
        return result

    def get_prerequisites(self, concept_name: str) -> list[ConceptNode]:
        return self.get_related(concept_name, RelationType.PREREQUISITE)

    def get_subtopics(self, concept_name: str) -> list[ConceptNode]:
        return self.get_related(concept_name, RelationType.SUBTOPIC)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: str = _DEFAULT_PATH) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = {
            "nodes": [
                {
                    "concept_id": n.concept_id,
                    "name": n.name,
                    "doc_id": n.doc_id,
                    "chunk_ids": n.chunk_ids,
                }
                for n in self._nodes.values()
            ],
            "edges": [
                {
                    "source_concept": e.source_concept,
                    "target_concept": e.target_concept,
                    "rel_type": e.rel_type.value,
                }
                for edges in self._edges.values()
                for e in edges
            ],
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        logger.info(
            "Knowledge graph saved to %s (%d nodes, %d edges)",
            path,
            len(self._nodes),
            sum(len(v) for v in self._edges.values()),
        )

    def load(self, path: str = _DEFAULT_PATH) -> None:
        if not os.path.exists(path):
            logger.info("No knowledge graph file at %s — starting empty", path)
            return
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        self._nodes.clear()
        self._by_name.clear()
        self._edges.clear()
        for n in data.get("nodes", []):
            node = ConceptNode(
                concept_id=n["concept_id"],
                name=n["name"],
                doc_id=n["doc_id"],
                chunk_ids=n.get("chunk_ids", []),
            )
            self.add_concept(node)
        for e in data.get("edges", []):
            self.add_relationship(
                e["source_concept"], e["target_concept"], RelationType(e["rel_type"])
            )
        logger.info("Knowledge graph loaded from %s (%d nodes)", path, len(self._nodes))
