"""Ingestion (REQ-000004-sJpO9KMY Requirement 1): br-RECORD-000001-sJpO9KMY
(validation), br-RECORD-000002-sJpO9KMY (one stream per source and kind) and
br-RECORD-000004-sJpO9KMY (bounded streams)."""

import asyncio
import json

import fakeredis.aioredis
import pytest

from correlate_sump.ingest import (
    DEFAULT_MAXLEN,
    IngestAdapter,
    handle_connection,
    maxlen_from_env,
    run_ingest_server,
    stream_key,
    validate_record,
)
from correlate_sump.otel import SumpMetrics


def record(**overrides) -> bytes:
    """A valid record, with any field replaced or removed (value None)."""
    fields = {"kind": "log", "source": "h1", "ts": "2026-11-21T10:00:00+00:00", "line": "hi"}
    fields.update(overrides)
    return json.dumps({k: v for k, v in fields.items() if v is not None}).encode()


@pytest.fixture
def redis_client():
    return fakeredis.aioredis.FakeRedis()


class _Reader:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""


class _Writer:
    closed = False

    def close(self) -> None:
        self.closed = True


# --- br-RECORD-000001: validation ---------------------------------------------


def test_valid_record_passes() -> None:
    parsed, reason = validate_record(record())
    assert reason is None
    assert parsed is not None and parsed["source"] == "h1"


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        (b"not json", "invalid_json"),
        (b"\xff\xfe", "invalid_json"),
        (b"[1, 2]", "not_object"),
        (record(kind=None), "missing_field"),
        (record(source=None), "missing_field"),
        (record(ts=None), "missing_field"),
        (record(kind="container"), "bad_kind"),
        (record(source=""), "bad_source"),
        (record(source=7), "bad_source"),
        (record(ts="yesterday"), "bad_ts"),
        (record(ts="2026-11-21T10:00:00"), "bad_ts"),
    ],
)
def test_invalid_records_are_dropped_with_a_reason(raw: bytes, reason: str) -> None:
    assert validate_record(raw) == (None, reason)


async def test_dropped_record_is_counted_and_not_stored(redis_client, otel, metric_points) -> None:
    _, reader = otel
    adapter = IngestAdapter(redis_client, metrics=SumpMetrics())
    assert await adapter.ingest(record(ts="nope")) is False
    assert await redis_client.keys("sump:records:*") == []
    points = metric_points(reader, "sump.records.dropped")
    assert any(p.attributes == {"reason": "bad_ts"} and p.value >= 1 for p in points)


async def test_bad_record_does_not_stop_the_connection(redis_client) -> None:
    adapter = IngestAdapter(redis_client)
    lines = [record(line="a") + b"\n", b"garbage\n", record(line="b") + b"\n"]
    writer = _Writer()
    await handle_connection(_Reader(lines), writer, adapter)
    assert await redis_client.xlen(stream_key("h1", "log")) == 2
    assert writer.closed


# --- br-RECORD-000002: one stream per source and kind ------------------------------


async def test_records_go_to_their_source_and_kind_stream(redis_client) -> None:
    adapter = IngestAdapter(redis_client)
    await adapter.ingest(record(source="h1", kind="log"))
    await adapter.ingest(record(source="h1", kind="metric", cpu=0.5))
    await adapter.ingest(record(source="h2", kind="log"))
    assert await redis_client.xlen(stream_key("h1", "log")) == 1
    assert await redis_client.xlen(stream_key("h1", "metric")) == 1
    assert await redis_client.xlen(stream_key("h2", "log")) == 1


async def test_record_is_stored_unchanged_with_its_event_time(redis_client) -> None:
    adapter = IngestAdapter(redis_client)
    raw = record(ts="2020-01-01T00:00:00+00:00", nested={"a": [1, 2]})
    await adapter.ingest(raw)
    entries = await redis_client.xrange(stream_key("h1", "log"))
    assert entries[0][1][b"json"] == raw


async def test_ingest_is_traced_and_counted(redis_client, otel, metric_points) -> None:
    exporter, reader = otel
    adapter = IngestAdapter(redis_client, metrics=SumpMetrics())
    await adapter.ingest(record())
    spans = {s.name: s for s in exporter.get_finished_spans()}
    assert spans["sump.ingest"].attributes["sump.ingest.stream"] == stream_key("h1", "log")
    ingested = metric_points(reader, "sump.records.ingested")
    assert any(p.attributes == {"kind": "log"} for p in ingested)


# --- br-RECORD-000004: bounded streams --------------------------------------------


async def test_stream_is_trimmed_to_the_cap_oldest_first(redis_client) -> None:
    adapter = IngestAdapter(redis_client, maxlen=5)
    for i in range(30):
        await adapter.ingest(record(line=f"l{i}"))
    entries = await redis_client.xrange(stream_key("h1", "log"))
    lines = [json.loads(fields[b"json"])["line"] for _, fields in entries]
    assert len(lines) == 5
    assert lines[-5:] == [f"l{i}" for i in range(25, 30)]
    assert "l0" not in lines


def test_maxlen_defaults_when_unset() -> None:
    assert maxlen_from_env({}) == DEFAULT_MAXLEN == 100_000
    assert maxlen_from_env({"SUMP_RECORD_MAXLEN": " "}) == DEFAULT_MAXLEN


def test_maxlen_reads_a_positive_integer() -> None:
    assert maxlen_from_env({"SUMP_RECORD_MAXLEN": "500"}) == 500


@pytest.mark.parametrize("value", ["0", "-3", "lots", "1.5"])
def test_invalid_maxlen_is_refused(value: str) -> None:
    with pytest.raises(ValueError, match="SUMP_RECORD_MAXLEN must be a positive integer"):
        maxlen_from_env({"SUMP_RECORD_MAXLEN": value})


# --- the TCP server ----------------------------------------------------------------


async def test_server_ingests_lines_over_tcp(redis_client) -> None:
    adapter = IngestAdapter(redis_client)
    server = await run_ingest_server(adapter, port=0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        _, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(record(line="over tcp") + b"\n")
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        for _ in range(50):
            if await redis_client.exists(stream_key("h1", "log")):
                break
            await asyncio.sleep(0.02)
    assert await redis_client.xlen(stream_key("h1", "log")) == 1


def test_server_listens_on_loopback_by_default() -> None:
    import inspect

    assert inspect.signature(run_ingest_server).parameters["host"].default == "127.0.0.1"
