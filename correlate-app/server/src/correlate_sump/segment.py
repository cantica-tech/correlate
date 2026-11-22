"""A recording's segment (REQ-000037-sJpO9KMY Requirement 1): a stream's
records over a time range in the recording format's shapes (cttc's archive
format version 3, `sample_archive.py`), for the app to append to its scratch
`*.recording`, and for Item 47's recordings made on the Sump.

- One stats source of the containers' series, each row `[ts ms, cpu %, mem %,
  mem bytes, net bytes/s]`: the memory percentage from used over limit, the
  network rate from the change of the received and sent counters since the
  row before (none for a series' first row).
- One stats source of the host's series, when asked, alike.
- One log source per container, each row `{"ts": ms, "text"}`, oldest first
  (ties in arrival order).
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from correlate_sump.ingest import stream_key
from correlate_sump.records import QueryError, RedisLike

#: At most this many sources in one segment.
MAX_SOURCES = 200


def _check(sources: list[str], start: datetime, end: datetime) -> None:
    if start.tzinfo is None or end.tzinfo is None:
        raise QueryError("from and to need a timezone")
    if end <= start:
        raise QueryError("to must be after from")
    if len(sources) > MAX_SOURCES:
        raise QueryError(f"at most {MAX_SOURCES} sources")
    if any(not s or len(s) > 400 or "/" not in s for s in sources):
        raise QueryError("a source is stream/container, 1 to 400 characters")


async def _read(
    redis_client: RedisLike, source: str, kind: str, start: datetime, end: datetime
) -> list[dict[str, Any]]:
    """`source`'s records of `kind` within `[start, end]`, oldest first, ties by arrival."""
    entries = await redis_client.xrange(stream_key(source, kind), min="-", max="+") or []
    rows: list[tuple[datetime, int, dict[str, Any]]] = []
    for n, (_id, raw) in enumerate(entries):
        data = raw.get(b"json", raw.get("json")) if raw else None
        if data is None:
            continue
        record = json.loads(data.decode() if isinstance(data, bytes) else data)
        ts = datetime.fromisoformat(record["ts"])
        if start <= ts <= end:
            rows.append((ts, n, record))
    rows.sort(key=lambda r: (r[0], r[1]))
    return [r[2] for r in rows]


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def stats_rows(records: list[dict[str, Any]]) -> list[list[float | None]]:
    """Metric records as the format's stats rows."""
    out: list[list[float | None]] = []
    previous: tuple[float, float] | None = None
    for r in records:
        ms = datetime.fromisoformat(r["ts"]).timestamp() * 1000
        used = _number(r.get("mem_used_bytes"))
        limit = _number(r.get("mem_limit_bytes"))
        mem_pct = round(used / limit * 100, 4) if used is not None and limit else None
        rx, tx = _number(r.get("net_rx_bytes")), _number(r.get("net_tx_bytes"))
        rate: float | None = None
        if rx is not None and tx is not None:
            total = rx + tx
            if previous is not None and ms > previous[0] and total >= previous[1]:
                rate = round((total - previous[1]) / ((ms - previous[0]) / 1000), 3)
            previous = (ms, total)
        out.append([ms, _number(r.get("cpu_percent")), mem_pct, used, rate])
    return out


async def segment(
    redis_client: RedisLike,
    sources: list[str],
    *,
    host: str | None,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    """The segment of `sources` (and `host`) over `[start, end]`."""
    _check([*sources, *([host] if host else [])], start, end)
    series: dict[str, list[list[float | None]]] = {}
    logs: list[dict[str, Any]] = []
    for source in sources:
        name = source.split("/", 1)[1]
        metrics = await _read(redis_client, source, "metric", start, end)
        if metrics:
            series[name] = stats_rows(metrics)
        rows = [
            {"ts": datetime.fromisoformat(r["ts"]).timestamp() * 1000, "text": r.get("text", "")}
            for r in await _read(redis_client, source, "log", start, end)
        ]
        logs.append({"type": "log", "name": name, "rows": rows})
    stream = sources[0].split("/", 1)[0] if sources else (host or "").split("/", 1)[0]
    out: list[dict[str, Any]] = [
        {"type": "stats", "name": f"stats@{stream}", "is_host": False, "series": series}
    ]
    if host:
        host_rows = stats_rows(await _read(redis_client, host, "metric", start, end))
        out.append(
            {
                "type": "stats",
                "name": f"host@{stream}",
                "is_host": True,
                "series": {f"host@{stream}": host_rows},
            }
        )
    out.extend(logs)
    return {
        "from": start.timestamp() * 1000,
        "to": end.timestamp() * 1000,
        "sources": out,
    }
