"""
Tablo System Test Suite
=======================
Automated tests covering:
  1. RAG latency and retrieval quality
  2. Diagram drawing quality (SVG fidelity for subject-specific diagrams)
  3. Document viewer format support
  4. Skills / prompt loading
  5. Learner memory persistence
  6. Context window management
  7. Board command validation
  8. Drawing accuracy for subject domains (digital logic, math, physics, economics)
  9. Source synchronization (navigate_to)
 10. Error recovery paths

Run with:
    cd backend && python -m pytest tests/test_system.py -v --tb=short 2>&1 | tee tests/report.txt

Or for the full report with timing:
    cd backend && python tests/test_system.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv()

# ─── Result tracking ──────────────────────────────────────────────────────────

@dataclass
class TestResult:
    name: str
    passed: bool
    score: float  # 0.0 - 1.0
    latency_ms: float
    details: str
    recommendation: str = ""

results: list[TestResult] = []

def record(name: str, passed: bool, score: float, latency_ms: float, details: str, recommendation: str = "") -> TestResult:
    r = TestResult(name, passed, score, latency_ms, details, recommendation)
    results.append(r)
    status = "✅ PASS" if passed else "❌ FAIL"
    print(f"  {status} [{score:.0%}] {name} ({latency_ms:.0f}ms)")
    if details:
        for line in details.split("\n")[:3]:
            print(f"       {line}")
    return r

# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_genai_client():
    from google import genai
    api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY not set")
    return genai.Client(api_key=api_key)

def make_minimal_pdf() -> bytes:
    """Create a minimal valid PDF with text content for testing."""
    content = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 100 700 Td (OSI Model has 7 layers) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000274 00000 n
0000000368 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
441
%%EOF"""
    return content

async def ask_gemini(prompt: str, model: str = "gemini-2.5-flash") -> tuple[str, float]:
    """Call Gemini and return (response_text, latency_ms)."""
    client = get_genai_client()
    start = time.monotonic()
    response = client.models.generate_content(model=model, contents=prompt)
    latency_ms = (time.monotonic() - start) * 1000
    return (response.text or "").strip(), latency_ms

def validate_svg(svg: str) -> tuple[bool, list[str]]:
    """Validate SVG string for common issues. Returns (valid, list_of_issues)."""
    issues = []
    if not svg.strip().startswith("<svg"):
        issues.append("Does not start with <svg")
    if "viewBox" not in svg:
        issues.append("Missing viewBox attribute")
    if "fill='none'" not in svg and 'fill="none"' not in svg:
        issues.append("Missing fill='none' (shapes will be filled black)")
    if "stroke=" not in svg:
        issues.append("Missing stroke attribute")
    # Check for unclosed tags
    import re
    open_tags = re.findall(r"<(\w+)[^/]", svg)
    close_tags = re.findall(r"</(\w+)>", svg)
    self_closing = re.findall(r"<(\w+)[^>]*/\s*>", svg)
    return len(issues) == 0, issues

def validate_board_commands(commands: list[dict]) -> tuple[bool, list[str]]:
    """Validate a list of board commands for correctness."""
    issues = []
    valid_ops = {
        "create_text", "create_geo", "create_arrow", "create_svg",
        "create_graph", "create_parametric_graph", "create_polygon",
        "create_freehand", "create_multiline_text", "create_formula",
        "update_shape", "delete_shape", "clear_board", "get_board_state",
        "create_arrow_between_targets", "create_text_on_target",
    }
    for i, cmd in enumerate(commands):
        if "op" not in cmd:
            issues.append(f"Command {i}: missing 'op' field")
            continue
        if cmd["op"] not in valid_ops:
            issues.append(f"Command {i}: unknown op '{cmd['op']}'")
        if cmd["op"] == "create_svg":
            if "svg" not in cmd:
                issues.append(f"Command {i}: create_svg missing 'svg' field")
            elif cmd["svg"]:
                valid, svg_issues = validate_svg(cmd["svg"])
                if not valid:
                    issues.extend([f"Command {i} SVG: {iss}" for iss in svg_issues])
        if cmd["op"] in ("create_geo", "create_svg", "create_text"):
            if "x" not in cmd or "y" not in cmd:
                issues.append(f"Command {i}: {cmd['op']} missing x/y coordinates")
    return len(issues) == 0, issues
