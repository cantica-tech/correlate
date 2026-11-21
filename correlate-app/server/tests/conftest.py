"""Shared fixtures.

OpenTelemetry accepts its global tracer and meter providers once per process,
so the tests install them once, with in-memory exporters, and each test
clears what earlier tests recorded before asserting on its own.
"""

from collections.abc import Iterator

import pytest
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from correlate_sump.otel import configure_otel


@pytest.fixture(autouse=True)
def no_installed_plugins(monkeypatch: pytest.MonkeyPatch) -> None:
    """The core's tests see only the plugins they give it: the SSH plugin,
    installed in this environment (REQ-000024-sJpO9KMY), is not discovered
    unless a test says so; a test that stubs discovery itself overrides this."""
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": []
    )


@pytest.fixture(scope="session")
def otel_test_exporters() -> tuple[InMemorySpanExporter, InMemoryMetricReader]:
    """Install the global providers once, with in-memory span and metric exporters."""
    exporter = InMemorySpanExporter()
    reader = InMemoryMetricReader()
    configure_otel(span_exporter=exporter, metric_reader=reader)
    return exporter, reader


@pytest.fixture
def otel(
    otel_test_exporters: tuple[InMemorySpanExporter, InMemoryMetricReader],
) -> Iterator[tuple[InMemorySpanExporter, InMemoryMetricReader]]:
    """The in-memory exporters, with spans from earlier tests cleared."""
    exporter, reader = otel_test_exporters
    exporter.clear()
    reader.get_metrics_data()  # drain what earlier tests recorded
    yield exporter, reader


def _metric_points(reader: InMemoryMetricReader, name: str) -> list:
    """Every data point recorded for the metric `name` since the last read."""
    data = reader.get_metrics_data()
    if data is None:
        return []
    return [
        point
        for rm in data.resource_metrics
        for sm in rm.scope_metrics
        for m in sm.metrics
        if m.name == name
        for point in m.data.data_points
    ]


@pytest.fixture
def metric_points():
    """`metric_points(reader, name)`: the data points of one metric since the last read.

    A fixture rather than an import: with `--import-mode=importlib`, tests
    cannot import from conftest.
    """
    return _metric_points
