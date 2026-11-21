"""OpenTelemetry setup for the Sump (br-OBS-000001-sJpO9KMY).

Traces cover ingestion (`sump.ingest`) and queries (`sump.records.query`);
metrics give stream depth, records ingested and records dropped. Export is
driven by the standard `OTEL_*` environment variables: with
`OTEL_EXPORTER_OTLP_ENDPOINT` (or a signal-specific endpoint) set, traces and
metrics go there over OTLP/HTTP; with none set, nothing is exported.

Started from correlator's `server/src/correlator_sump/otel.py` (decision D6
of `docs/roadmap/correlate-app-rewrite.md`); its counter-based stream depth
is replaced by a gauge, since capped streams (br-RECORD-000004-sJpO9KMY)
shrink as well as grow.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter

#: The service name every span and metric carries.
SERVICE = "correlate-sump"

#: Environment variables that, when any is set, turn OTLP export on.
TRACE_ENDPOINT_VARS = ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
METRIC_ENDPOINT_VARS = ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")


def configure_otel(
    span_exporter: SpanExporter | None = None,
    metric_reader: MetricReader | None = None,
) -> None:
    """Install the global tracer and meter providers.

    Tests pass in-memory exporters; `configure_from_env` passes the OTLP ones.
    With neither, spans and metrics are recorded but never exported. OpenTelemetry
    accepts global providers once per process, so call this once, at startup.
    """
    resource = Resource.create({SERVICE_NAME: SERVICE})
    tracer_provider = TracerProvider(resource=resource)
    if span_exporter is not None:
        tracer_provider.add_span_processor(SimpleSpanProcessor(span_exporter))
    trace.set_tracer_provider(tracer_provider)
    readers = [metric_reader] if metric_reader is not None else []
    metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=readers))


def export_enabled(env: Mapping[str, str], variables: tuple[str, ...]) -> bool:
    """Whether any of `variables` is set to a non-empty value in `env`."""
    return any(env.get(name) for name in variables)


def configure_from_env(env: Mapping[str, str] | None = None) -> tuple[bool, bool]:
    """Configure OpenTelemetry from the `OTEL_*` variables; return whether
    traces and metrics are exported. Nothing is exported when no endpoint is set."""
    env = os.environ if env is None else env
    traces_on = export_enabled(env, TRACE_ENDPOINT_VARS)
    metrics_on = export_enabled(env, METRIC_ENDPOINT_VARS)
    span_exporter = None
    metric_reader = None
    if traces_on:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        span_exporter = OTLPSpanExporter()
    if metrics_on:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

        metric_reader = PeriodicExportingMetricReader(OTLPMetricExporter())
    configure_otel(metric_reader=metric_reader)
    if span_exporter is not None:
        provider = trace.get_tracer_provider()
        if isinstance(provider, TracerProvider):
            provider.add_span_processor(BatchSpanProcessor(span_exporter))
    return traces_on, metrics_on


def get_tracer() -> trace.Tracer:
    """The Sump's tracer, from the global provider."""
    return trace.get_tracer(SERVICE)


def get_meter() -> metrics.Meter:
    """The Sump's meter, from the global provider."""
    return metrics.get_meter(SERVICE)


class SumpMetrics:
    """The Sump's metric instruments (br-OBS-000001-sJpO9KMY)."""

    def __init__(self, meter: metrics.Meter | None = None) -> None:
        meter = meter or get_meter()
        #: Records currently held in a stream, labelled by `stream`.
        self.stream_depth = meter.create_gauge(
            "sump.stream.depth",
            unit="{record}",
            description="Records currently held in a record stream.",
        )
        #: Records stored, labelled by `kind`.
        self.records_ingested = meter.create_counter(
            "sump.records.ingested",
            unit="{record}",
            description="Records validated and stored.",
        )
        #: Records refused at ingestion, labelled by `reason`.
        self.records_dropped = meter.create_counter(
            "sump.records.dropped",
            unit="{record}",
            description="Records refused at ingestion because they were invalid.",
        )
