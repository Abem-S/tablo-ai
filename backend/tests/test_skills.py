"""Skills System Tests — no external API calls needed."""
from __future__ import annotations
import json, os, sys, tempfile, time, uuid
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

@dataclass
class TestResult:
    name: str; passed: bool; score: float; latency_ms: float; details: str; recommendation: str = ""

def test_skills_loading() -> TestResult:
    name = "skills/loading"
    start = time.monotonic()
    expected = ["core_teaching.md","learner_adaptation.md","document_grounding.md","drawing_commands.md"]
    try:
        import skills_loader
        skills_loader.reload_skills()
        issues = []
        loaded = {}
        for f in expected:
            c = skills_loader.load_skill(f)
            if not c: issues.append(f"{f}: empty or not found")
            else: loaded[f] = c
        ms = (time.monotonic()-start)*1000
        score = (len(expected)-len(issues))/len(expected)
        details = f"Loaded {len(loaded)}/{len(expected)} files\n" + "\n".join(f"  {k}: {len(v)} chars" for k,v in loaded.items())
        if issues: details += "\nIssues: " + "; ".join(issues)
        return TestResult(name, len(issues)==0, score, ms, details,
            "Check backend/skills/ directory" if issues else "")
    except Exception as e:
        return TestResult(name, False, 0.0, (time.monotonic()-start)*1000, f"Exception: {e}", "Check skills_loader.py")

def test_prompt_assembly() -> TestResult:
    name = "skills/prompt_assembly"
    start = time.monotonic()
    try:
        import skills_loader
        skills_loader.reload_skills()
        prompt = skills_loader.build_system_prompt()
        ms = (time.monotonic()-start)*1000
        issues = []
        if not isinstance(prompt, str): issues.append(f"returned {type(prompt).__name__}")
        elif len(prompt) < 500: issues.append(f"too short: {len(prompt)} chars")
        if "---" not in prompt: issues.append("missing section separators")
        sections = [s.strip() for s in prompt.split("---") if s.strip()]
        if len(sections) < 3: issues.append(f"only {len(sections)} sections")
        score = max(0.0, 1.0 - len(issues)*0.25)
        details = f"Length: {len(prompt)} chars, sections: {len(sections)}"
        if issues: details += "\nIssues: " + "; ".join(issues)
        return TestResult(name, len(issues)==0, score, ms, details)
    except Exception as e:
        return TestResult(name, False, 0.0, (time.monotonic()-start)*1000, f"Exception: {e}")

def test_learner_profile_injection() -> TestResult:
    name = "skills/profile_injection"
    start = time.monotonic()
    try:
        import skills_loader, learner_memory
        p = learner_memory._default_profile("test-inject")
        p["mastered"] = ["binary arithmetic"]
        p["struggle_areas"] = ["TCP handshake"]
        p["last_session_summary"] = "Covered OSI layers 1-3"
        section = learner_memory.format_profile_for_prompt(p)
        prompt = skills_loader.build_system_prompt(learner_profile_section=section)
        ms = (time.monotonic()-start)*1000
        issues = []
        for phrase in ["Learner Profile","binary arithmetic","TCP handshake","OSI layers 1-3"]:
            if phrase not in prompt: issues.append(f"'{phrase}' not in prompt")
        score = max(0.0, 1.0 - len(issues)*0.25)
        details = f"Prompt length: {len(prompt)} chars"
        if issues: details += "\nMissing: " + "; ".join(issues)
        return TestResult(name, len(issues)==0, score, ms, details)
    except Exception as e:
        return TestResult(name, False, 0.0, (time.monotonic()-start)*1000, f"Exception: {e}")

def test_skills_content() -> TestResult:
    name = "skills/content_validation"
    start = time.monotonic()
    required = [
        ("Socratic","core_teaching.md"),
        ("execute_command","drawing_commands.md"),
        ("search_documents","document_grounding.md"),
        ("get_board_image","core_teaching.md or drawing_commands.md"),
        ("create_svg","drawing_commands.md"),
        ("viewBox","drawing_commands.md"),
    ]
    try:
        import skills_loader
        skills_loader.reload_skills()
        all_skills = skills_loader.load_all_skills()
        ms = (time.monotonic()-start)*1000
        missing = [f"'{p}' ({src})" for p,src in required if p not in all_skills]
        score = (len(required)-len(missing))/len(required)
        details = f"Checked {len(required)} phrases in {len(all_skills)} chars"
        if missing: details += "\nMissing: " + "; ".join(missing)
        return TestResult(name, len(missing)==0, score, ms, details,
            "Review backend/skills/ files" if missing else "")
    except Exception as e:
        return TestResult(name, False, 0.0, (time.monotonic()-start)*1000, f"Exception: {e}")

def test_profile_persistence() -> TestResult:
    name = "skills/profile_persistence"
    start = time.monotonic()
    lid = f"test_{uuid.uuid4().hex[:8]}"
    try:
        import learner_memory
        orig = learner_memory._PROFILES_DIR
        with tempfile.TemporaryDirectory() as tmp:
            learner_memory._PROFILES_DIR = tmp
            try:
                p = learner_memory.load_profile(lid)
                p["mastered"] = ["subnetting","binary arithmetic"]
                p["struggle_areas"] = ["TCP handshake","routing protocols"]
                p["learning_styles"] = {"networking":"needs visual diagrams"}
                p["preferred_pace"] = "slow"
                p["last_session_summary"] = "Covered OSI model layers 1-4"
                p["hints_that_worked"] = {"subnetting":"pizza slice analogy"}
                learner_memory.save_profile(p)
                r = learner_memory.load_profile(lid)
                ms = (time.monotonic()-start)*1000
                issues = []
                if set(r["mastered"]) != {"subnetting","binary arithmetic"}: issues.append("mastered mismatch")
                if set(r["struggle_areas"]) != {"TCP handshake","routing protocols"}: issues.append("struggle_areas mismatch")
                if r["learning_styles"].get("networking") != "needs visual diagrams": issues.append("learning_styles mismatch")
                if r["preferred_pace"] != "slow": issues.append("preferred_pace mismatch")
                if r["last_session_summary"] != "Covered OSI model layers 1-4": issues.append("summary mismatch")
                if r["hints_that_worked"].get("subnetting") != "pizza slice analogy": issues.append("hints mismatch")
                score = max(0.0, 1.0 - len(issues)*0.15)
                details = "All fields persisted correctly" if not issues else "Issues: " + "; ".join(issues)
                return TestResult(name, len(issues)==0, score, ms, details)
            finally:
                learner_memory._PROFILES_DIR = orig
    except Exception as e:
        return TestResult(name, False, 0.0, (time.monotonic()-start)*1000, f"Exception: {e}")

def test_profile_update_logic() -> TestResult:
    name = "skills/profile_update_logic"
    start = time.monotonic()
    try:
        import learner_memory
        p = learner_memory._default_profile("test-update")
        p["struggle_areas"] = ["TCP handshake","routing protocols","subnetting"]
        p["mastered"] = ["binary arithmetic"]
        issues = []
        # mastered removes from struggle_areas
        p = learner_memory.apply_update(p, {"mastered":["TCP handshake","subnetting"]})
        if "TCP handshake" in p["struggle_areas"]: issues.append("mastered didn't remove TCP handshake from struggles")
        if "subnetting" in p["struggle_areas"]: issues.append("mastered didn't remove subnetting from struggles")
        if "routing protocols" not in p["struggle_areas"]: issues.append("routing protocols incorrectly removed")
        # remove_struggle
        p = learner_memory.apply_update(p, {"remove_struggle":["routing protocols"]})
        if "routing protocols" in p["struggle_areas"]: issues.append("remove_struggle failed")
        # learning_styles merge
        p["learning_styles"] = {"math":"visual"}
        p = learner_memory.apply_update(p, {"learning_styles":{"networking":"analogies"}})
        if p["learning_styles"].get("math") != "visual": issues.append("learning_styles merge overwrote existing key")
        if p["learning_styles"].get("networking") != "analogies": issues.append("learning_styles merge didn't add new key")
        # session_history capped at 10
        for i in range(12):
            p = learner_memory.apply_update(p, {"session_history_entry":{"topic":f"s{i}"}})
        if len(p["session_history"]) > 10: issues.append(f"session_history not capped (got {len(p['session_history'])})")
        ms = (time.monotonic()-start)*1000
        score = max(0.0, 1.0 - len(issues)*0.2)
        details = "All update logic correct" if not issues else "Issues:\n" + "\n".join(f"  - {i}" for i in issues)
        return TestResult(name, len(issues)==0, score, ms, details,
            "Review learner_memory.apply_update()" if issues else "")
    except Exception as e:
        return TestResult(name, False, 0.0, (time.monotonic()-start)*1000, f"Exception: {e}")

ALL_TESTS = [test_skills_loading, test_prompt_assembly, test_learner_profile_injection,
             test_skills_content, test_profile_persistence, test_profile_update_logic]

def run_all() -> list[TestResult]:
    results = []
    print("\n=== Skills System Tests ===\n")
    for fn in ALL_TESTS:
        r = fn()
        status = "✅ PASS" if r.passed else "❌ FAIL"
        print(f"  {status} [{r.score:.0%}] {r.name} ({r.latency_ms:.0f}ms)")
        if not r.passed:
            for line in r.details.split("\n")[:3]: print(f"       {line}")
        results.append(r)
    return results

if __name__ == "__main__":
    results = run_all()
    passed = sum(1 for r in results if r.passed)
    avg = sum(r.score for r in results)/len(results)
    print(f"\nSkills: {passed}/{len(results)} passed, avg {avg:.0%}")
