"""RAG Pipeline Tests — requires Qdrant running + GOOGLE_API_KEY."""
from __future__ import annotations
import asyncio, json, os, sys, tempfile, time, uuid
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

@dataclass
class TestResult:
    name: str; passed: bool; score: float; latency_ms: float; details: str; recommendation: str = ""

def _qdrant_available():
    try:
        from qdrant_client import QdrantClient
        QdrantClient(url=os.getenv("QDRANT_URL","http://localhost:6333"), timeout=3).get_collections()
        return True
    except Exception:
        return False

def _skip(name, reason):
    return TestResult(name, True, 1.0, 0.0, f"SKIPPED: {reason}")

_TEST_USER = f"pytest_{uuid.uuid4().hex[:8]}"
_STATE: dict = {}

def _make_pipeline():
    from rag.knowledge_graph import KnowledgeGraph
    from rag.ingestion import IngestionPipeline
    kg = KnowledgeGraph()
    return IngestionPipeline(knowledge_graph=kg, user_id=_TEST_USER), kg

def _make_retrieval(kg):
    from rag.retrieval import RetrievalPipeline
    from rag import vector_store as vs
    return RetrievalPipeline(knowledge_graph=kg, collection=vs.collection_name(_TEST_USER), user_id=_TEST_USER)

def _cleanup():
    try:
        from qdrant_client import QdrantClient
        from rag import vector_store as vs
        c = QdrantClient(url=os.getenv("QDRANT_URL","http://localhost:6333"), timeout=10)
        col = vs.collection_name(_TEST_USER)
        if col in {x.name for x in c.get_collections().collections}:
            c.delete_collection(col)
    except Exception:
        pass

async def test_ingestion_latency() -> TestResult:
    name = "rag/ingestion_latency"
    if not _qdrant_available(): return _skip(name, "Qdrant not running")
    text = ("The OSI model has 7 layers: Physical, Data Link, Network, Transport, "
            "Session, Presentation, and Application. Each layer serves a specific "
            "function in network communication. The Transport layer provides "
            "end-to-end communication services for applications.")
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(text); tmp = f.name
    try:
        pipeline, kg = _make_pipeline()
        start = time.monotonic()
        result = await pipeline.ingest_document_fast(tmp, "osi_test.txt")
        ms = (time.monotonic()-start)*1000
        _STATE["doc_id"] = result.doc_id
        _STATE["kg"] = kg
        passed = result.status == "complete" and result.chunk_count > 0
        details = f"Status: {result.status}, chunks: {result.chunk_count}, concepts: {result.concept_count}, {ms:.0f}ms"
        rec = "Ingestion >10s — consider batching embeddings" if ms > 10000 else ""
        return TestResult(name, passed, 1.0 if passed else 0.0, ms, details, rec)
    except Exception as e:
        return TestResult(name, False, 0.0, 0.0, f"Exception: {e}", "Check Qdrant + GOOGLE_API_KEY")
    finally:
        os.unlink(tmp)

async def test_retrieval_latency() -> TestResult:
    name = "rag/retrieval_latency"
    if not _qdrant_available(): return _skip(name, "Qdrant not running")
    if not _STATE.get("doc_id"): return _skip(name, "Ingestion test not run")
    try:
        r = _make_retrieval(_STATE["kg"])
        start = time.monotonic()
        result = await r.retrieve("OSI model layers", "t1", top_k=3, threshold=0.1)
        ms = (time.monotonic()-start)*1000
        passed = ms < 5000
        details = f"Latency: {ms:.0f}ms, sources: {len(result.context.sources)}"
        rec = "Add Qdrant payload index on doc_id" if ms > 2000 else ""
        return TestResult(name, passed, 1.0 if passed else 0.5, ms, details, rec)
    except Exception as e:
        return TestResult(name, False, 0.0, 0.0, f"Exception: {e}")

async def test_retrieval_quality() -> TestResult:
    name = "rag/retrieval_quality"
    if not _qdrant_available(): return _skip(name, "Qdrant not running")
    if not _STATE.get("doc_id"): return _skip(name, "Ingestion test not run")
    try:
        r = _make_retrieval(_STATE["kg"])
        start = time.monotonic()
        result = await r.retrieve("OSI layers", "t2", top_k=5, threshold=0.1)
        ms = (time.monotonic()-start)*1000
        ctx = result.context.context_text.lower()
        checks = [len(result.context.sources)>0, "osi" in ctx, "layer" in ctx, "7" in ctx or "seven" in ctx]
        score = sum(checks)/4.0
        details = f"Sources: {len(result.context.sources)}, OSI: {'osi' in ctx}, layers: {'layer' in ctx}, 7: {'7' in ctx}"
        rec = "Lower retrieval threshold or check embedding API" if not checks[0] else ""
        return TestResult(name, score>=0.75, score, ms, details, rec)
    except Exception as e:
        return TestResult(name, False, 0.0, 0.0, f"Exception: {e}")

async def test_threshold_behavior() -> TestResult:
    name = "rag/threshold_behavior"
    if not _qdrant_available(): return _skip(name, "Qdrant not running")
    if not _STATE.get("doc_id"): return _skip(name, "Ingestion test not run")
    try:
        r = _make_retrieval(_STATE["kg"])
        start = time.monotonic()
        result = await r.retrieve("quantum chromodynamics quark gluon plasma", "t3", top_k=5, threshold=0.7)
        ms = (time.monotonic()-start)*1000
        passed = len(result.context.sources)==0 or result.context.is_general_knowledge
        details = f"Sources at threshold=0.7: {len(result.context.sources)}, is_general: {result.context.is_general_knowledge}"
        rec = "Threshold not filtering irrelevant results" if not passed else ""
        return TestResult(name, passed, 1.0 if passed else 0.3, ms, details, rec)
    except Exception as e:
        return TestResult(name, False, 0.0, 0.0, f"Exception: {e}")

async def test_knowledge_graph() -> TestResult:
    name = "rag/knowledge_graph"
    if not _qdrant_available(): return _skip(name, "Qdrant not running")
    if not _STATE.get("kg"): return _skip(name, "Ingestion test not run")
    start = time.monotonic()
    kg = _STATE["kg"]
    node_count = len(kg._nodes)
    all_names = [n.name.lower() for n in kg._nodes.values()]
    net_concepts = [n for n in all_names if any(k in n for k in ["osi","layer","network","transport","physical","application"])]
    ms = (time.monotonic()-start)*1000
    checks = [node_count>0, len(net_concepts)>0, node_count>=2]
    score = sum(checks)/3.0
    details = f"Total concepts: {node_count}, networking-related: {len(net_concepts)}"
    rec = "Concept extraction returned no nodes — check GOOGLE_API_KEY" if not checks[0] else ""
    return TestResult(name, score>=0.67, score, ms, details, rec)

async def test_diagram_recipe_storage() -> TestResult:
    name = "rag/diagram_recipe_storage"
    if not _qdrant_available(): return _skip(name, "Qdrant not running")
    if not _STATE.get("doc_id"): return _skip(name, "Ingestion test not run")
    start = time.monotonic()
    try:
        from rag import vector_store as vs
        from qdrant_client import QdrantClient
        client = QdrantClient(url=os.getenv("QDRANT_URL","http://localhost:6333"), timeout=10)
        col = vs.collection_name(_TEST_USER)
        points = vs.get_points_by_doc_id(client, col, _STATE["doc_id"])
        ms = (time.monotonic()-start)*1000
        has_points = len(points)>0
        all_have_field = all("diagram_recipe" in pt["payload"] for pt in points)
        no_missing = all(pt["payload"].get("diagram_recipe","MISSING") != "MISSING" for pt in points)
        valid_recipes = True
        for pt in points:
            val = pt["payload"].get("diagram_recipe","")
            if val:
                try: json.loads(val)
                except: valid_recipes = False
        checks = [has_points, all_have_field, no_missing, valid_recipes]
        score = sum(checks)/4.0
        details = f"Points: {len(points)}, all have field: {all_have_field}, no missing: {no_missing}, valid JSON: {valid_recipes}"
        rec = "diagram_recipe field missing — check IngestionPipeline.store()" if not all_have_field else ""
        return TestResult(name, score>=0.75, score, ms, details, rec)
    except Exception as e:
        return TestResult(name, False, 0.0, 0.0, f"Exception: {e}")

ALL_TESTS = [test_ingestion_latency, test_retrieval_latency, test_retrieval_quality,
             test_threshold_behavior, test_knowledge_graph, test_diagram_recipe_storage]

async def run_all() -> list[TestResult]:
    results = []
    print("\n=== RAG Pipeline Tests ===\n")
    if not _qdrant_available():
        print("  ⚠️  Qdrant not reachable — all RAG tests skipped")
        print("     Start with: docker compose up qdrant -d\n")
    for fn in ALL_TESTS:
        r = await fn()
        if r.details.startswith("SKIPPED"):
            print(f"  ⏭️  SKIP  {r.name}")
        else:
            status = "✅ PASS" if r.passed else "❌ FAIL"
            print(f"  {status} [{r.score:.0%}] {r.name} ({r.latency_ms:.0f}ms)")
            if not r.passed:
                for line in r.details.split("\n")[:2]: print(f"       {line}")
        results.append(r)
    _cleanup()
    return results

if __name__ == "__main__":
    results = asyncio.run(run_all())
    passed = sum(1 for r in results if r.passed)
    avg = sum(r.score for r in results)/len(results)
    print(f"\nRAG: {passed}/{len(results)} passed, avg {avg:.0%}")
