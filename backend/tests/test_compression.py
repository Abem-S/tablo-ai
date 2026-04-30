"""RAG compression tests — no external API calls required."""
from __future__ import annotations
import asyncio
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from rag.models import RetrievalContext, DiagramRecipe
from rag.retrieval import compress_context


@dataclass
class TestResult:
    name: str
    passed: bool
    score: float
    latency_ms: float
    details: str
    recommendation: str = ""


def _result(name, passed, start, details, rec=""):
    return TestResult(name, passed, 1.0 if passed else 0.0, (time.monotonic()-start)*1000, details, rec)


async def test_compression_max_len() -> TestResult:
    name = "rag/compression_max_len"
    start = time.monotonic()
    long_text = "Lorem ipsum " * 300
    ctx = RetrievalContext(
        turn_id="t1",
        context_text=long_text,
        sources=[],
        is_general_knowledge=False,
        diagram_recipes=[
            DiagramRecipe(page_number=2, description="Network diagram with routers and switches", image_b64=""),
        ],
    )
    result = await compress_context("Explain OSI layers", ctx, max_chars=200, allow_llm=False)
    passed = len(result) <= 200 and "Diagrams available" in result
    details = f"len={len(result)}"
    return _result(name, passed, start, details)


async def test_compression_truncation() -> TestResult:
    name = "rag/compression_truncation"
    start = time.monotonic()
    long_text = "Sentence. " * 200
    ctx = RetrievalContext(
        turn_id="t2",
        context_text=long_text,
        sources=[],
        is_general_knowledge=False,
        diagram_recipes=[],
    )
    result = await compress_context("Explain TCP", ctx, max_chars=120, allow_llm=False)
    passed = len(result) <= 120
    details = f"len={len(result)}"
    return _result(name, passed, start, details)


async def test_compression_empty_context() -> TestResult:
    name = "rag/compression_empty_context"
    start = time.monotonic()
    ctx = RetrievalContext(
        turn_id="t3",
        context_text="",
        sources=[],
        is_general_knowledge=True,
        diagram_recipes=[],
    )
    result = await compress_context("Explain TCP", ctx, max_chars=500, allow_llm=False)
    passed = len(result) <= 500
    details = f"len={len(result)}, result='{result[:50]}'"
    return _result(name, passed, start, details)


async def test_compression_diagram_hints_only() -> TestResult:
    name = "rag/compression_diagram_hints_only"
    start = time.monotonic()
    ctx = RetrievalContext(
        turn_id="t4",
        context_text="Short text.",
        sources=[],
        is_general_knowledge=False,
        diagram_recipes=[
            DiagramRecipe(page_number=5, description="OSI model 7-layer stack diagram", image_b64=""),
            DiagramRecipe(page_number=12, description="TCP/IP handshake sequence diagram", image_b64=""),
        ],
    )
    result = await compress_context("Explain OSI", ctx, max_chars=500, allow_llm=False)
    passed = (
        len(result) <= 500
        and "p.5" in result
        and "p.12" in result
        and "draw_diagram" in result
    )
    details = f"len={len(result)}, has p.5: {'p.5' in result}, has p.12: {'p.12' in result}"
    return _result(name, passed, start, details)


async def test_compression_respects_max_chars() -> TestResult:
    """Verify output never exceeds max_chars regardless of input size."""
    name = "rag/compression_respects_max_chars"
    start = time.monotonic()
    issues = []
    for max_chars in [50, 100, 200, 500]:
        ctx = RetrievalContext(
            turn_id="t5",
            context_text="Word " * 500,
            sources=[],
            is_general_knowledge=False,
            diagram_recipes=[DiagramRecipe(page_number=1, description="A diagram", image_b64="")],
        )
        result = await compress_context("query", ctx, max_chars=max_chars, allow_llm=False)
        if len(result) > max_chars:
            issues.append(f"max_chars={max_chars}: got {len(result)} chars")
    passed = len(issues) == 0
    details = "All max_chars limits respected" if passed else "; ".join(issues)
    return _result(name, passed, start, details,
        "compress_context is not respecting max_chars — check _truncate_text logic" if not passed else "")


def run_all() -> list[TestResult]:
    print("\n=== RAG Compression Tests ===\n")
    return asyncio.run(_run_all())


async def _run_all() -> list[TestResult]:
    tests = [
        test_compression_max_len,
        test_compression_truncation,
        test_compression_empty_context,
        test_compression_diagram_hints_only,
        test_compression_respects_max_chars,
    ]
    results = []
    for fn in tests:
        r = await fn()
        status = "✅ PASS" if r.passed else "❌ FAIL"
        print(f"  {status} [{r.score:.0%}] {r.name} ({r.latency_ms:.0f}ms)")
        if not r.passed:
            print(f"       {r.details}")
        results.append(r)
    return results


if __name__ == "__main__":
    results = run_all()
    passed = sum(1 for r in results if r.passed)
    avg = sum(r.score for r in results) / len(results)
    print(f"\nCompression: {passed}/{len(results)} passed, avg {avg:.0%}")
