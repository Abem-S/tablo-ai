"""Safe math evaluation tests — no external APIs."""
from __future__ import annotations
import sys
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from math_eval import evaluate_expression, MathEvaluationError


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


def test_basic_arithmetic() -> TestResult:
    name = "calculate/basic_arithmetic"
    start = time.monotonic()
    try:
        result = evaluate_expression("2 + 2")
        passed = result == 4
        details = f"Result: {result}"
        return _result(name, passed, start, details)
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_exponent_caret() -> TestResult:
    name = "calculate/exponent_caret"
    start = time.monotonic()
    try:
        result = evaluate_expression("2^10")
        passed = result == 1024
        details = f"Result: {result}"
        return _result(name, passed, start, details)
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_trig() -> TestResult:
    name = "calculate/trig"
    start = time.monotonic()
    try:
        result = float(evaluate_expression("sin(pi/2)"))
        passed = abs(result - 1.0) < 1e-6
        details = f"Result: {result}"
        return _result(name, passed, start, details)
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_rejects_bad_input() -> TestResult:
    name = "calculate/rejects_bad_input"
    start = time.monotonic()
    try:
        evaluate_expression("__import__('os').system('echo x')")
        return _result(name, False, start, "Unexpectedly evaluated unsafe expression")
    except MathEvaluationError:
        return _result(name, True, start, "Unsafe expression rejected")
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_empty_expression() -> TestResult:
    name = "calculate/empty_expression"
    start = time.monotonic()
    try:
        evaluate_expression("")
        return _result(name, False, start, "Should have raised MathEvaluationError")
    except MathEvaluationError:
        return _result(name, True, start, "Empty expression rejected correctly")
    except Exception as e:
        return _result(name, False, start, f"Wrong exception type: {e}")


def test_too_long_expression() -> TestResult:
    name = "calculate/too_long_expression"
    start = time.monotonic()
    try:
        evaluate_expression("1 + " * 100 + "1")
        return _result(name, False, start, "Should have raised MathEvaluationError for long expression")
    except MathEvaluationError:
        return _result(name, True, start, "Too-long expression rejected correctly")
    except Exception as e:
        return _result(name, False, start, f"Wrong exception type: {e}")


def test_sqrt() -> TestResult:
    name = "calculate/sqrt"
    start = time.monotonic()
    try:
        result = float(evaluate_expression("sqrt(144)"))
        passed = abs(result - 12.0) < 1e-9
        return _result(name, passed, start, f"Result: {result}")
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_factorial() -> TestResult:
    name = "calculate/factorial"
    start = time.monotonic()
    try:
        result = evaluate_expression("factorial(5)")
        passed = result == 120
        return _result(name, passed, start, f"Result: {result}")
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_pi_constant() -> TestResult:
    name = "calculate/pi_constant"
    start = time.monotonic()
    try:
        import math
        result = float(evaluate_expression("pi"))
        passed = abs(result - math.pi) < 1e-9
        return _result(name, passed, start, f"Result: {result}")
    except Exception as e:
        return _result(name, False, start, f"Exception: {e}")


def test_rejects_exec() -> TestResult:
    name = "calculate/rejects_exec"
    start = time.monotonic()
    try:
        evaluate_expression("exec('import os')")
        return _result(name, False, start, "exec() should be rejected")
    except MathEvaluationError:
        return _result(name, True, start, "exec() rejected correctly")
    except Exception as e:
        return _result(name, True, start, f"Rejected with: {type(e).__name__}")


def run_all() -> list[TestResult]:
    results = []
    print("\n=== Calculate Tool Tests ===\n")
    for fn in [
        test_basic_arithmetic, test_exponent_caret, test_trig,
        test_rejects_bad_input, test_empty_expression, test_too_long_expression,
        test_sqrt, test_factorial, test_pi_constant, test_rejects_exec,
    ]:
        r = fn()
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
    print(f"\nCalculate: {passed}/{len(results)} passed, avg {avg:.0%}")
