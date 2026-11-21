"""br-OBS-000001-sJpO9KMY: the Sump's OpenTelemetry setup (REQ-000004-sJpO9KMY Requirement 3)."""

from correlate_sump.otel import (
    METRIC_ENDPOINT_VARS,
    TRACE_ENDPOINT_VARS,
    SumpMetrics,
    export_enabled,
)


def test_export_is_off_without_endpoint_variables() -> None:
    assert not export_enabled({}, TRACE_ENDPOINT_VARS)
    assert not export_enabled({"OTEL_EXPORTER_OTLP_ENDPOINT": ""}, METRIC_ENDPOINT_VARS)


def test_generic_endpoint_turns_both_signals_on() -> None:
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"}
    assert export_enabled(env, TRACE_ENDPOINT_VARS)
    assert export_enabled(env, METRIC_ENDPOINT_VARS)


def test_signal_specific_endpoint_turns_only_that_signal_on() -> None:
    env = {"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://127.0.0.1:4318/v1/traces"}
    assert export_enabled(env, TRACE_ENDPOINT_VARS)
    assert not export_enabled(env, METRIC_ENDPOINT_VARS)


def test_metrics_are_recorded(otel) -> None:
    _, reader = otel
    instruments = SumpMetrics()
    instruments.records_ingested.add(2, {"kind": "log"})
    instruments.records_dropped.add(1, {"reason": "invalid_json"})
    instruments.stream_depth.set(5, {"stream": "sump:records:h1:log"})

    data = reader.get_metrics_data()
    names = {m.name for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics}
    assert {"sump.records.ingested", "sump.records.dropped", "sump.stream.depth"} <= names


def test_metric_points_helper_reads_one_metric(otel, metric_points) -> None:
    _, reader = otel
    SumpMetrics().records_dropped.add(3, {"reason": "missing_field"})
    points = metric_points(reader, "sump.records.dropped")
    assert sum(p.value for p in points) >= 3
