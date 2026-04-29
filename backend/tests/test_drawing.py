"""Drawing Quality Tests — uses the same prompt the agent actually uses.

Tests cover:
  - Structural diagrams (logic gates, circuits, network topologies) → create_svg
  - Mathematical functions (sin/cos, x^2) → create_graph (frontend evaluates accurately)
  - Parametric curves (unit circle, spiral) → create_parametric_graph
  - Custom graphs that can't be expressed as y=f(x) → create_svg
  - Mixed diagrams (force diagrams, supply/demand) → create_svg

Run: cd backend && python tests/test_drawing.py
"""
from __future__ import annotations
import asyncio, json, os, re, sys, time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

@dataclass
class TestResult:
    name: str; passed: bool; score: float; latency_ms: float; details: str; recommendation: str = ""

# ─── The actual prompt the agent uses (from drawing_commands.md) ──────────────
# This is representative of what the agent sees — the full skill content.
# Tests that use a shorter prompt are testing a different model than production.

_AGENT_PROMPT = """Draw {diagram} as tldraw board commands. Return a JSON array ONLY — no markdown, no explanation.

Available ops and when to use each:
  create_graph        — for y=f(x) math functions (sin, cos, x^2, etc.) — frontend evaluates accurately
  create_parametric_graph — for parametric curves (unit circle, spiral, Lissajous)
  create_svg          — for structural diagrams (circuits, logic gates, network topologies, force diagrams, custom graphs)
  create_text         — for labels and equations
  create_geo          — for simple shapes (rectangle, ellipse, diamond)
  create_arrow        — for arrows between points
  create_polygon      — for regular polygons (pentagon, hexagon, star)

SVG rules (MANDATORY when using create_svg):
  fill='none'  stroke='black'  stroke-width='2'
  viewBox attribute is REQUIRED — must match your coordinate space
  Use <text> elements for labels inside SVG
  CRITICAL: Keep SVG under 400 characters total. Use simple shapes only: <rect>, <circle>, <line>, <polygon>, <text>. Never use complex <path> elements.

create_graph syntax:
  {{"op":"create_graph","expressions":[{{"expr":"sin(x)","label":"sin(x)"}},{{"expr":"cos(x)","label":"cos(x)"}}],"x":50,"y":50,"xMin":-6.28,"xMax":6.28}}
  Expression syntax: sin(x), cos(x), tan(x), x^2, sqrt(x), log(x), exp(x), abs(x), pi, e

create_parametric_graph syntax:
  {{"op":"create_parametric_graph","exprX":"cos(t)","exprY":"sin(t)","tMin":0,"tMax":6.28,"label":"unit circle","x":50,"y":50}}

Board coordinate space: x 0–800, y 0–600.
Return ONLY a valid JSON array. No explanation."""

# ─── Validation ───────────────────────────────────────────────────────────────

VALID_OPS = {
    "create_text","create_geo","create_arrow","create_svg","create_graph",
    "create_parametric_graph","create_polygon","create_freehand",
    "create_multiline_text","create_formula","update_shape","delete_shape",
    "clear_board","get_board_state","create_arrow_between_targets","create_text_on_target",
}

def strip_fences(text: str) -> str:
    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
    return re.sub(r"\s*```$", "", text).strip()

def extract_json_array(text: str) -> str:
    text = strip_fences(text)
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        return text[start:end+1]
    return text

def validate_svg(svg: str) -> list[str]:
    issues = []
    if not svg.strip().startswith("<svg"): issues.append("doesn't start with <svg")
    if "viewBox" not in svg: issues.append("missing viewBox")
    if 'fill="none"' not in svg and "fill='none'" not in svg: issues.append("missing fill='none'")
    if "stroke=" not in svg: issues.append("missing stroke")
    return issues

def score_commands(commands: list[dict], expect_op: str | None, expect_svg: bool) -> tuple[float, list[str]]:
    """Score 0-5 points:
      +1 valid JSON (already parsed)
      +1 all ops are known
      +1 uses the expected op (create_svg, create_graph, etc.)
      +1 SVG is valid (if create_svg present)
      +1 coordinates within board bounds
    """
    issues = []
    pts = 1  # valid JSON

    unknown = [c.get("op", "?") for c in commands if c.get("op") not in VALID_OPS]
    if not unknown: pts += 1
    else: issues.append(f"unknown ops: {unknown[:3]}")

    # Check expected op
    if expect_op:
        has_op = any(c.get("op") == expect_op for c in commands)
        if has_op: pts += 1
        else: issues.append(f"expected {expect_op} but not found")
    elif expect_svg:
        has_svg = any(c.get("op") == "create_svg" for c in commands)
        if has_svg: pts += 1
        else: issues.append("expected create_svg for structural diagram")
    else:
        pts += 1  # no specific op required

    # SVG validity
    svg_cmds = [c for c in commands if c.get("op") == "create_svg"]
    if svg_cmds:
        all_svg_ok = True
        for c in svg_cmds:
            svg_issues = validate_svg(c.get("svg", ""))
            if svg_issues:
                issues.extend(svg_issues)
                all_svg_ok = False
        if all_svg_ok: pts += 1
    else:
        pts += 1  # no SVG to validate

    # Coordinate bounds
    coords_ok = all(0 <= c.get("x", 0) <= 1200 and 0 <= c.get("y", 0) <= 900
                    for c in commands if "x" in c)
    if coords_ok: pts += 1
    else: issues.append("coords out of range")

    return pts / 5.0, issues

# ─── Test runner ──────────────────────────────────────────────────────────────

async def _test(name: str, diagram: str, expect_op: str | None = None, expect_svg: bool = False) -> TestResult:
    try:
        from google import genai
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        client = genai.Client(api_key=api_key)
        prompt = _AGENT_PROMPT.format(diagram=diagram)

        raw = ""
        ms = 0.0
        for attempt in range(3):
            try:
                start = time.monotonic()
                resp = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)
                ms = (time.monotonic() - start) * 1000
                raw = (resp.text or "").strip()
                break
            except Exception as e:
                err = str(e)
                if attempt < 2 and any(x in err for x in ["503", "502", "UNAVAILABLE", "overloaded"]):
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                return TestResult(name, False, 0.0, 0.0, f"API error: {err[:100]}", "Retry or check API key")

        extracted = extract_json_array(raw)
        try:
            commands = json.loads(extracted)
            if not isinstance(commands, list): raise ValueError("not a list")
        except Exception as e:
            return TestResult(name, False, 0.0, ms,
                f"JSON parse failed: {e}\nRaw (200 chars): {raw[:200]}")

        if not commands:
            return TestResult(name, False, 0.0, ms, "Empty array returned")

        score, issues = score_commands(commands, expect_op, expect_svg)
        passed = score >= 0.6
        details = f"{len(commands)} command(s)"
        if issues: details += "\nIssues: " + "; ".join(issues)
        else: details += " — all checks passed"

        # Show what op was actually used
        ops_used = list({c.get("op") for c in commands if c.get("op")})
        details += f"\nOps used: {ops_used}"

        rec = ""
        if not passed:
            if expect_op and not any(c.get("op") == expect_op for c in commands):
                rec = f"Model chose wrong op — expected {expect_op}"
            elif any("fill='none'" in i or "viewBox" in i for i in issues):
                rec = "SVG missing required attributes"
        return TestResult(name, passed, score, ms, details, rec)
    except Exception as e:
        return TestResult(name, False, 0.0, 0.0, f"Unexpected error: {e}")

# ─── Test definitions ─────────────────────────────────────────────────────────
# Each test specifies what op the agent SHOULD use for that diagram type.
# This tests whether the agent picks the right tool, not just whether it produces valid JSON.

# --- Mathematical functions: should use create_graph (frontend evaluates accurately) ---
async def test_sin_cos():
    return await _test("math/sin_cos_graph",
        "sin(x) and cos(x) from -2*pi to 2*pi on the same axes",
        expect_op="create_graph")

async def test_quadratic():
    return await _test("math/quadratic",
        "y = x^2 - 4 parabola from x=-4 to x=4",
        expect_op="create_graph")

async def test_tan():
    return await _test("math/tan_graph",
        "tan(x) from -pi/2 to pi/2 showing asymptotes",
        expect_op="create_graph")

# --- Parametric curves: should use create_parametric_graph ---
async def test_unit_circle():
    return await _test("math/unit_circle_parametric",
        "unit circle as a parametric curve x=cos(t) y=sin(t)",
        expect_op="create_parametric_graph")

async def test_spiral():
    return await _test("math/spiral",
        "Archimedean spiral x=t*cos(t) y=t*sin(t)",
        expect_op="create_parametric_graph")

# --- Custom graphs that can't be y=f(x): should use create_svg ---
async def test_supply_demand():
    return await _test("economics/supply_demand",
        "supply and demand curves intersecting at equilibrium point P* Q* with labeled axes Price and Quantity",
        expect_svg=True)

async def test_indifference_curve():
    return await _test("economics/indifference_curve",
        "two indifference curves (U1 and U2) with a budget constraint line, axes labeled Good X and Good Y",
        expect_svg=True)

async def test_bode_plot():
    return await _test("physics/bode_plot",
        "Bode magnitude plot showing gain in dB vs frequency on log scale with -20dB/decade slope",
        expect_svg=True)

# --- Structural diagrams: should use create_svg ---
async def test_and_gate():
    return await _test("digital_logic/and_gate",
        "AND gate with 2 inputs A and B and output Y, standard logic gate symbol",
        expect_svg=True)

async def test_full_adder():
    return await _test("digital_logic/full_adder",
        "full adder circuit with inputs A, B, Cin and outputs Sum and Cout using XOR, AND, OR gates",
        expect_svg=True)

async def test_kmap():
    return await _test("digital_logic/kmap",
        "4-variable Karnaugh map with 16 cells labeled with minterms and groupings highlighted",
        expect_svg=True)

async def test_circuit():
    return await _test("physics/series_circuit",
        "series circuit with a battery, two resistors R1 and R2, and a capacitor C, all labeled",
        expect_svg=True)

async def test_force_diagram():
    return await _test("physics/force_diagram",
        "free body diagram of a block on an inclined plane showing weight mg downward, normal force N perpendicular to surface, friction f along surface",
        expect_svg=True)

async def test_wave():
    return await _test("physics/transverse_wave",
        "transverse wave showing one full wavelength lambda, amplitude A, crest and trough labeled, with x and y axes",
        expect_svg=True)

async def test_osi_model():
    return await _test("network/osi_model",
        "OSI model 7 layers as a vertical stack of labeled boxes: Physical, Data Link, Network, Transport, Session, Presentation, Application",
        expect_svg=True)

async def test_router_topology():
    return await _test("network/router_topology",
        "network topology with 3 routers connected in a triangle, each router connected to 2 end hosts",
        expect_svg=True)

async def test_truth_table():
    return await _test("digital_logic/truth_table",
        "truth table for a 2-input AND gate with columns A, B, Output and all 4 rows filled in")
    # No specific op required — could be create_svg table or create_geo boxes

async def test_matrix_mult():
    return await _test("math/matrix_multiplication",
        "2x2 matrix multiplication showing [a b; c d] times [e f; g h] equals the result matrix")

async def test_pie_chart():
    return await _test("economics/pie_chart",
        "pie chart showing market share: Company A 40%, B 30%, C 20%, D 10% with labels",
        expect_svg=True)

async def test_bar_chart():
    return await _test("economics/bar_chart",
        "bar chart showing GDP growth rates for 5 countries with labeled axes and values on bars")

# ─── Runner ───────────────────────────────────────────────────────────────────

ALL_TESTS = [
    # Math functions → create_graph
    test_sin_cos, test_quadratic, test_tan,
    # Parametric → create_parametric_graph
    test_unit_circle, test_spiral,
    # Custom graphs → create_svg
    test_supply_demand, test_indifference_curve, test_bode_plot,
    # Structural → create_svg
    test_and_gate, test_full_adder, test_kmap,
    test_circuit, test_force_diagram, test_wave,
    test_osi_model, test_router_topology,
    # Mixed / flexible
    test_truth_table, test_matrix_mult, test_pie_chart, test_bar_chart,
]

async def run_all() -> list[TestResult]:
    results = []
    print("\n=== Drawing Quality Tests (agent-representative prompt) ===\n")
    for i, fn in enumerate(ALL_TESTS):
        if i > 0:
            await asyncio.sleep(2)
        r = await fn()
        status = "✅ PASS" if r.passed else "❌ FAIL"
        print(f"  {status} [{r.score:.0%}] {r.name} ({r.latency_ms:.0f}ms)")
        if not r.passed or r.recommendation:
            for line in r.details.split("\n")[:3]: print(f"       {line}")
        results.append(r)
    return results

if __name__ == "__main__":
    results = asyncio.run(run_all())
    passed = sum(1 for r in results if r.passed)
    avg = sum(r.score for r in results) / len(results)
    print(f"\nDrawing: {passed}/{len(results)} passed, avg {avg:.0%}")

    # Category breakdown
    cats = {
        "Math functions (create_graph)": [r for r in results if "sin_cos" in r.name or "quadratic" in r.name or "tan" in r.name],
        "Parametric (create_parametric_graph)": [r for r in results if "parametric" in r.name or "spiral" in r.name],
        "Custom graphs (create_svg)": [r for r in results if any(x in r.name for x in ["supply", "indifference", "bode", "pie"])],
        "Structural (create_svg)": [r for r in results if any(x in r.name for x in ["gate", "adder", "kmap", "circuit", "force", "wave", "osi", "router"])],
    }
    print("\nBy category:")
    for cat, cat_results in cats.items():
        if cat_results:
            cat_passed = sum(1 for r in cat_results if r.passed)
            cat_avg = sum(r.score for r in cat_results) / len(cat_results)
            print(f"  {cat}: {cat_passed}/{len(cat_results)} passed, avg {cat_avg:.0%}")

    if avg < 0.7:
        print("\n⚠️  ARCHITECTURE RECOMMENDATION:")
        print("   Drawing quality below 70% — consider subject-specific prompt templates")
        print("   or a dedicated diagram library (Mermaid.js for flowcharts, D3 for data viz)")
    elif avg >= 0.85:
        print("\n✅ Drawing quality good for production.")
    else:
        print("\n⚠️  Drawing quality marginal — review failing categories above.")
