"""Observability helpers: metrics, health, and tracing."""

from __future__ import annotations

import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Callable

from prometheus_client import (
    Counter,
    Gauge,
    Histogram,
    CONTENT_TYPE_LATEST,
    generate_latest,
)

logger = logging.getLogger("tablo.observability")


HTTP_REQUESTS_TOTAL = Counter(
    "tablo_http_requests_total",
    "Total HTTP requests",
    ["method", "path", "status"],
)
HTTP_REQUEST_LATENCY_SECONDS = Histogram(
    "tablo_http_request_latency_seconds",
    "HTTP request latency",
    ["method", "path"],
)

AGENT_TOOL_CALLS_TOTAL = Counter(
    "tablo_agent_tool_calls_total",
    "Agent tool calls",
    ["tool"],
)
AGENT_TOOL_ERRORS_TOTAL = Counter(
    "tablo_agent_tool_errors_total",
    "Agent tool errors",
    ["tool"],
)
AGENT_TOOL_LATENCY_SECONDS = Histogram(
    "tablo_agent_tool_latency_seconds",
    "Agent tool latency",
    ["tool"],
)

RAG_RETRIEVAL_LATENCY_SECONDS = Histogram(
    "tablo_rag_retrieval_latency_seconds",
    "RAG retrieval latency",
)
RAG_RETRIEVAL_ERRORS_TOTAL = Counter(
    "tablo_rag_retrieval_errors_total",
    "RAG retrieval errors",
)
RAG_COMPRESSION_LATENCY_SECONDS = Histogram(
    "tablo_rag_compression_latency_seconds",
    "RAG context compression latency",
)
RAG_COMPRESSION_TRUNCATIONS_TOTAL = Counter(
    "tablo_rag_compression_truncations_total",
    "RAG compressions that required truncation",
)

AGENT_UP = Gauge("tablo_agent_up", "Agent health (1=up, 0=down)")


_TRACING_INITIALIZED = False


def init_tracing(service_name: str):
    """Initialize OpenTelemetry tracing if OTLP endpoint is configured."""
    global _TRACING_INITIALIZED

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        from opentelemetry import trace

        return trace.get_tracer(service_name)

    if _TRACING_INITIALIZED:
        from opentelemetry import trace

        return trace.get_tracer(service_name)

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.logging import LoggingInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except Exception as e:
        logger.warning("Tracing dependencies not available: %s", e)
        from opentelemetry import trace

        return trace.get_tracer(service_name)

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    try:
        LoggingInstrumentor().instrument(set_logging_format=True)
    except Exception as e:
        logger.warning("Failed to instrument logging: %s", e)

    _TRACING_INITIALIZED = True
    return trace.get_tracer(service_name)


def record_http_metrics(method: str, path: str, status: int, duration_s: float) -> None:
    HTTP_REQUESTS_TOTAL.labels(method=method, path=path, status=str(status)).inc()
    HTTP_REQUEST_LATENCY_SECONDS.labels(method=method, path=path).observe(duration_s)


_METRICS_SERVER_STARTED = False


def start_metrics_server(
    port: int, health_fn: Callable[[], dict] | None = None
) -> None:
    """Start a tiny HTTP server exposing /health and /metrics endpoints."""
    global _METRICS_SERVER_STARTED
    if _METRICS_SERVER_STARTED:
        return

    health_fn = health_fn or (lambda: {"status": "ok"})

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/health":
                payload = health_fn()
                data = json.dumps(payload).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if self.path == "/metrics":
                data = generate_latest()
                self.send_response(200)
                self.send_header("Content-Type", CONTENT_TYPE_LATEST)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            self.send_response(404)
            self.end_headers()

        def log_message(self, format, *args):
            return

    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError:
        # Port already bound by a previous job process — metrics are best-effort.
        # Never crash the agent session over this.
        logger.info(
            "Metrics server port %d already in use — skipping (another job has it)", port
        )
        _METRICS_SERVER_STARTED = True
        return

    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _METRICS_SERVER_STARTED = True
    logger.info("Metrics server listening on :%d", port)

