"""
Tablo Test Suite — Master Runner
Usage:
    cd backend && python tests/run_all.py              # full suite
    cd backend && python tests/run_all.py --no-drawing # skip Gemini drawing tests
    cd backend && python tests/run_all.py --skills-only
    cd backend && python tests/run_all.py --rag-only
    cd backend && python tests/run_all.py --formats-only
    cd backend && python tests/run_all.py --json       # print JSON report
"""
from __future__ import annotations
import asyncio, json, os, sys, time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_BACKEND = Path(__file__).parent.parent
sys.path.insert(0, str(_BACKEND))
from dotenv import load_dotenv
load_dotenv(_BACKEND / ".env")

@dataclass
class TestResult:
    name: str; passed: bool; score: float; latency_ms: float; details: str; recommendation: str = ""

async def _run_drawing():
    try:
        import tests.test_drawing as m
        return [TestResult(**{k:getattr(r,k) for k in TestResult.__dataclass_fields__}) for r in await m.run_all()]
    except Exception as e:
        return [TestResult("drawing/suite_error",False,0.0,0.0,f"Suite error: {e}")]

async def _run_rag():
    try:
        import tests.test_rag as m
        return [TestResult(**{k:getattr(r,k) for k in TestResult.__dataclass_fields__}) for r in await m.run_all()]
    except Exception as e:
        return [TestResult("rag/suite_error",False,0.0,0.0,f"Suite error: {e}")]

async def _run_agent():
    try:
        import tests.test_agent_behavior as m
        return [TestResult(**{k:getattr(r,k) for k in TestResult.__dataclass_fields__}) for r in await m.run_all()]
    except Exception as e:
        return [TestResult("agent/suite_error",False,0.0,0.0,f"Suite error: {e}")]

def _run_skills():
    try:
        import tests.test_skills as m
        return [TestResult(**{k:getattr(r,k) for k in TestResult.__dataclass_fields__}) for r in m.run_all()]
    except Exception as e:
        return [TestResult("skills/suite_error",False,0.0,0.0,f"Suite error: {e}")]

def _run_formats():
    try:
        import tests.test_formats as m
        return [TestResult(**{k:getattr(r,k) for k in TestResult.__dataclass_fields__}) for r in m.run_all()]
    except Exception as e:
        return [TestResult("formats/suite_error",False,0.0,0.0,f"Suite error: {e}")]

def _recommendations(drawing, rag, skills, formats):
    recs = []
    real_drawing = [r for r in drawing if not r.details.startswith("SKIPPED")]
    if real_drawing:
        svg_fails = [r for r in real_drawing if not r.passed and ("create_svg" in r.details or "fill='none'" in r.details or "viewBox" in r.details)]
        if len(svg_fails) > len(real_drawing)*0.5:
            recs.append(f"Switch from SVG generation to Mermaid.js or D3 for subject diagrams — {len(svg_fails)}/{len(real_drawing)} SVG tests failed")
        low = [r for r in real_drawing if r.score < 0.4]
        if low:
            recs.append(f"Drawing quality low for: {', '.join(r.name for r in low[:3])} — add subject-specific prompt templates")
    real_rag = [r for r in rag if not r.details.startswith("SKIPPED")]
    if real_rag:
        slow = [r for r in real_rag if "retrieval_latency" in r.name and r.latency_ms > 2000]
        if slow: recs.append(f"Add Qdrant payload index on doc_id — retrieval {slow[0].latency_ms:.0f}ms > 2000ms target")
        qfail = [r for r in real_rag if "quality" in r.name and not r.passed]
        if qfail: recs.append("RAG quality test failed — check gemini-embedding-2 access and Qdrant threshold")
    for r in skills:
        if not r.passed and not r.details.startswith("SKIPPED"):
            if "loading" in r.name: recs.append("Skills loading failed — check backend/skills/ directory")
            elif "content" in r.name: recs.append("Skills content missing key phrases — review skill files")
            elif "persistence" in r.name: recs.append("Learner profile persistence broken — check learner_memory.py")
    for r in formats:
        if not r.passed and not r.details.startswith("SKIPPED"):
            if "docx" in r.name: recs.append("DOCX parser broken — pip install python-docx")
            elif "pptx" in r.name: recs.append("PPTX parser broken — pip install python-pptx")
            elif "html" in r.name: recs.append("HTML parser broken — pip install beautifulsoup4")
    if not recs: recs.append("All tests passing — no architecture changes recommended")
    return recs

def _cat_stats(results):
    real = [r for r in results if not r.details.startswith("SKIPPED")]
    skipped = [r for r in results if r.details.startswith("SKIPPED")]
    lats = [r.latency_ms for r in real if r.latency_ms > 0]
    return {
        "passed": sum(1 for r in real if r.passed),
        "failed": sum(1 for r in real if not r.passed),
        "skipped": len(skipped),
        "avg_latency_ms": round(sum(lats)/len(lats),1) if lats else 0,
        "avg_score": round(sum(r.score for r in real)/len(real),3) if real else 0.0,
        "issues": [r.recommendation for r in real if not r.passed and r.recommendation][:5],
    }

def _build_report(drawing, rag, skills, formats, recs, elapsed_ms, agent=None):
    agent = agent or []
    all_r = drawing+rag+skills+formats+agent
    real = [r for r in all_r if not r.details.startswith("SKIPPED")]
    total = len(real); passed = sum(1 for r in real if r.passed)
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_elapsed_ms": round(elapsed_ms,1),
        "summary": {"total":total,"passed":passed,"failed":total-passed,"avg_score":round(sum(r.score for r in real)/total,3) if total else 0},
        "categories": {"drawing":_cat_stats(drawing),"rag":_cat_stats(rag),"skills":_cat_stats(skills),"formats":_cat_stats(formats),"agent":_cat_stats(agent)},
        "recommendations": recs,
        "results": [{"name":r.name,"passed":r.passed,"score":round(r.score,3),"latency_ms":round(r.latency_ms,1),"details":r.details,"recommendation":r.recommendation,"skipped":r.details.startswith("SKIPPED")} for r in all_r],
    }

def _print_summary(report):
    s = report["summary"]; cats = report["categories"]; recs = report["recommendations"]
    print("\n" + "="*70)
    print("  TABLO TEST SUITE — SUMMARY")
    print("="*70)
    print(f"  {'Category':<12} {'Pass':>5} {'Fail':>5} {'Skip':>5} {'Score':>7} {'Latency':>10}")
    print("  "+"-"*50)
    for cat, st in cats.items():
        lat = f"{st['avg_latency_ms']:.0f}ms" if st['avg_latency_ms'] else "—"
        score_str = f"{st['avg_score']:.0%}"
        print(f"  {cat:<12} {st['passed']:>5} {st['failed']:>5} {st['skipped']:>5} {score_str:>7} {lat:>10}")
    print("  "+"-"*50)
    elapsed = f"{report['total_elapsed_ms']/1000:.1f}s"
    overall_score = f"{s['avg_score']:.0%}"
    print(f"  {'TOTAL':<12} {s['passed']:>5} {s['failed']:>5} {'':>5} {overall_score:>7} {elapsed:>10}")
    print("\n  DETAILED RESULTS")
    print("  "+"-"*60)
    for r in report["results"]:
        if r["skipped"]: icon = "⏭️ "
        elif r["passed"]: icon = "✅"
        else: icon = "❌"
        score = f"[{r['score']:.0%}]"
        lat = f"({r['latency_ms']:.0f}ms)" if r["latency_ms"] else ""
        print(f"  {icon} {score:>6} {r['name']:<45} {lat}")
        if not r["passed"] and not r["skipped"] and r["details"]:
            print(f"           ↳ {r['details'].split(chr(10))[0][:65]}")
    print("\n  ARCHITECTURE RECOMMENDATIONS")
    print("  "+"-"*60)
    for i,rec in enumerate(recs,1):
        words = rec.split(); lines = []; cur = ""
        for w in words:
            if len(cur)+len(w)+1 > 65: lines.append(cur); cur = w
            else: cur = (cur+" "+w).strip()
        if cur: lines.append(cur)
        print(f"  {i}. {lines[0]}")
        for l in lines[1:]: print(f"     {l}")
    print("\n"+"="*70)
    print(f"  Report: backend/tests/report.json")
    print("="*70+"\n")

async def main():
    args = sys.argv[1:]
    only = next((a for a in args if a.endswith("-only")), None)
    no_drawing = "--no-drawing" in args

    run_d = (only=="--drawing-only") or (not only and not no_drawing)
    run_r = (only=="--rag-only") or not only
    run_s = (only=="--skills-only") or not only
    run_f = (only=="--formats-only") or not only
    run_a = (only=="--agent-only") or not only

    print(f"\n🎓 Tablo AI — Test Suite  [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]")
    suite_start = time.monotonic()

    drawing = await _run_drawing() if run_d else []
    rag = await _run_rag() if run_r else []
    skills = _run_skills() if run_s else []
    formats = _run_formats() if run_f else []
    agent = await _run_agent() if run_a else []

    elapsed = (time.monotonic()-suite_start)*1000
    recs = _recommendations(drawing, rag, skills, formats)
    report = _build_report(drawing, rag, skills, formats, recs, elapsed, agent)

    path = Path(__file__).parent / "report.json"
    with open(path,"w",encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    if "--json" in args:
        print(json.dumps(report, indent=2))
    else:
        _print_summary(report)

    sys.exit(1 if report["summary"]["failed"] > 0 else 0)

if __name__ == "__main__":
    asyncio.run(main())
