"""Record ingestion: Fluent Bit's `tcp` output -> this adapter -> Redis Streams.

Fluent Bit forwards each record unchanged, one JSON object per line. The
adapter validates it (br-RECORD-000001-sJpO9KMY) and appends a valid record to
its stream, one per source and kind (br-RECORD-000002-sJpO9KMY), trimmed to
`SUMP_RECORD_MAXLEN` records (br-RECORD-000004-sJpO9KMY). An invalid record is
logged, counted by reason and dropped; it never stops ingestion.

Started from correlator's `server/src/correlator_sump/ingest.py` (decision D6
of `docs/roadmap/correlate-app-rewrite.md`), with REQ-000004-sJpO9KMY's
changes: the event time `ts` is required, `docker_host` is now `source`, and
correlator's extra write of every record to an unbounded flat list is gone.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Mapping
from datetime import datetime
from typing import Any, Protocol

from correlate_sump.otel import SumpMetrics, get_tracer

logger = logging.getLogger(__name__)

#: Record kinds the Sump accepts.
KINDS = ("log", "metric")

#: Fields every record must carry.
REQUIRED_FIELDS = ("kind", "source", "ts")

#: Environment variable capping each record stream, and its default.
MAXLEN_VAR = "SUMP_RECORD_MAXLEN"
DEFAULT_MAXLEN = 100_000

#: Where the adapter listens for Fluent Bit, inside the Sump's container.
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5170


class RedisLike(Protocol):
    """The part of `redis.asyncio.Redis` the adapter uses."""

    def xadd(
        self, name: str, fields: dict[Any, Any], maxlen: int | None = ..., approximate: bool = ...
    ) -> Awaitable[Any]: ...

    def xlen(self, name: str) -> Awaitable[int]: ...


class StreamReaderLike(Protocol):
    """The part of `asyncio.StreamReader` a connection handler uses."""

    async def readline(self) -> bytes: ...


class StreamWriterLike(Protocol):
    """The part of `asyncio.StreamWriter` a connection handler uses."""

    def close(self) -> Any: ...


def stream_key(source: str, kind: str) -> str:
    """The Redis stream holding the records of one source and kind."""
    return f"sump:records:{source}:{kind}"


def maxlen_from_env(env: Mapping[str, str]) -> int:
    """Read the stream cap from `SUMP_RECORD_MAXLEN`, or the default if unset.

    Raises `ValueError`, naming the variable, if it is set to anything but a
    positive integer, so the Sump refuses to start rather than run uncapped.
    """
    value = env.get(MAXLEN_VAR, "").strip()
    if not value:
        return DEFAULT_MAXLEN
    try:
        maxlen = int(value)
    except ValueError:
        maxlen = 0
    if maxlen <= 0:
        raise ValueError(f"{MAXLEN_VAR} must be a positive integer, got {value!r}")
    return maxlen


def _parse_ts(value: Any) -> datetime | None:
    """An ISO 8601 timestamp with a timezone, or `None` if `value` is not one."""
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def validate_record(raw: bytes) -> tuple[dict[str, Any] | None, str | None]:
    """Parse and check one raw record.

    Returns `(record, None)` if it is valid, or `(None, reason)` naming why it
    must be dropped: `invalid_json`, `not_object`, `missing_field`,
    `bad_kind`, `bad_source` or `bad_ts`.
    """
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None, "invalid_json"
    if not isinstance(parsed, dict):
        return None, "not_object"
    if any(field not in parsed for field in REQUIRED_FIELDS):
        return None, "missing_field"
    if parsed["kind"] not in KINDS:
        return None, "bad_kind"
    if not isinstance(parsed["source"], str) or not parsed["source"]:
        return None, "bad_source"
    if _parse_ts(parsed["ts"]) is None:
        return None, "bad_ts"
    return parsed, None


class IngestAdapter:
    """Validates and stores incoming records; one per Sump process."""

    def __init__(
        self,
        redis_client: RedisLike,
        maxlen: int = DEFAULT_MAXLEN,
        metrics: SumpMetrics | None = None,
    ) -> None:
        self.redis = redis_client
        self.maxlen = maxlen
        self._metrics = metrics
        self._tracer = get_tracer()

    async def ingest(self, raw: bytes) -> bool:
        """Store one raw record; return whether it was stored.

        A record that fails validation is logged, counted and dropped; this
        never raises for a bad record.
        """
        with self._tracer.start_as_current_span("sump.ingest") as span:
            span.set_attribute("sump.ingest.raw_bytes", len(raw))
            record, reason = validate_record(raw)
            if record is None:
                logger.warning("dropping invalid record (%s): %r", reason, raw[:200])
                span.set_attribute("sump.ingest.dropped", reason or "invalid")
                if self._metrics is not None:
                    self._metrics.records_dropped.add(1, {"reason": reason or "invalid"})
                return False
            key = stream_key(record["source"], record["kind"])
            # The whole record as one JSON field: nested fields survive, which
            # Redis Streams' flat string fields could not hold. Exact trimming:
            # approximate trimming removes whole internal nodes (about 100
            # entries) and so never trims a small stream, while exact trimming
            # removes at most one old record per new one.
            await self.redis.xadd(key, {"json": raw}, maxlen=self.maxlen, approximate=False)
            span.set_attribute("sump.ingest.stream", key)
            span.set_attribute("sump.ingest.kind", record["kind"])
            if self._metrics is not None:
                self._metrics.records_ingested.add(1, {"kind": record["kind"]})
                self._metrics.stream_depth.set(await self.redis.xlen(key), {"stream": key})
            return True


async def handle_connection(
    reader: StreamReaderLike, writer: StreamWriterLike, adapter: IngestAdapter
) -> None:
    """Serve one Fluent Bit connection: one record per line, until it closes."""
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            raw = line.rstrip(b"\r\n")
            if raw:
                await adapter.ingest(raw)
    finally:
        writer.close()


async def run_ingest_server(
    adapter: IngestAdapter, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT
) -> asyncio.Server:
    """Start the TCP server Fluent Bit forwards records to; the caller owns its lifecycle."""
    return await asyncio.start_server(
        lambda r, w: handle_connection(r, w, adapter), host=host, port=port
    )
