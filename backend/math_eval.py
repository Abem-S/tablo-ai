"""Safe math expression evaluation for the agent's calculate tool."""
from __future__ import annotations

import io
import math
from dataclasses import dataclass

from asteval import Interpreter

_MAX_EXPR_LEN = 200


class MathEvaluationError(ValueError):
    """Raised when a math expression cannot be evaluated safely."""


def _safe_symbols() -> dict:
    return {
        "sqrt": math.sqrt,
        "sin": math.sin,
        "cos": math.cos,
        "tan": math.tan,
        "asin": math.asin,
        "acos": math.acos,
        "atan": math.atan,
        "atan2": math.atan2,
        "sinh": math.sinh,
        "cosh": math.cosh,
        "tanh": math.tanh,
        "log": math.log,
        "ln": math.log,
        "log10": math.log10,
        "log2": math.log2,
        "exp": math.exp,
        "abs": abs,
        "floor": math.floor,
        "ceil": math.ceil,
        "round": round,
        "factorial": math.factorial,
        "gcd": math.gcd,
        "pow": pow,
        "pi": math.pi,
        "e": math.e,
    }


def evaluate_expression(expression: str) -> float | int:
    """Evaluate a math expression using a constrained evaluator.

    Supports basic arithmetic, trig, logs, and constants like pi/e.
    """
    if not expression or not expression.strip():
        raise MathEvaluationError("Empty expression")
    if len(expression) > _MAX_EXPR_LEN:
        raise MathEvaluationError("Expression too long")

    expr = expression.strip().replace("^", "**")

    error_sink = io.StringIO()
    aeval = Interpreter(
        usersyms=_safe_symbols(),
        minimal=True,
        no_print=True,
        err_writer=error_sink,
    )

    result = aeval(expr)
    if aeval.error:
        err = aeval.error[0]
        msg = err.get_error() if hasattr(err, "get_error") else str(err)
        raise MathEvaluationError(msg)

    if result is None:
        raise MathEvaluationError("No result")
    if isinstance(result, complex):
        raise MathEvaluationError("Complex numbers are not supported")
    return result
