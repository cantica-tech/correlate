"""The event engine (REQ-000043-sJpO9KMY, br-EVENT-000004-sJpO9KMY, decision D7).

Evaluates every enabled event on the Sump's live Redis streams, never on
what a window shows (cttc bug 15):

- A metric condition checks **every** watched series (bug 22): its latest
  sample, if at most `STALE_MS` old (decided in FEAT-000045-sJpO9KMY).
- A log condition reads **every** line appended since its stored position,
  page after page with no per-tick cap (bug 23); the position starts at the
  stream's tail when the event is made (bug 24), and for a container the
  stream gains later, at the event's creation.
- An event fires on an edge: once per change from not met to met. Every
  condition is evaluated on every tick, so log positions keep moving whatever
  the latch's state.

Events, their latch and their positions are kept in Redis (`EventStore`),
so they survive a restart; each firing is added to `FIRINGS`, a bounded
stream the actions (Item 47) and the app (Item 48) read. One failing event is
logged and skipped; the others are still evaluated.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
from collections.abc import Callable
from datetime import datetime
from typing import Any

from correlate_sump.ingest import stream_key
from sump_plugin_events.model import (
    Event,
    LogCondition,
    MetricCondition,
    parse_condition,
    validate,
)

logger = logging.getLogger(__name__)

#: A series counts only if its latest sample is at most this old.
STALE_MS = 15_000
#: The firings, newest last, at most `FIRINGS_MAXLEN` of them.
FIRINGS = "sump:events:firings"
FIRINGS_MAXLEN = 10_000
#: The ids of the Sump's events.
INDEX = "sump:events"
#: Log lines read per page; a condition reads pages until none are left.
LOG_PAGE = 500
#: The host's series name in a data stream (the SSH plugin's `HOST_NAME`).
HOST_NAME = "__host__"

_OPS: dict[str, Callable[[float, float], bool]] = {
    ">": lambda v, t: v > t,
    "<": lambda v, t: v < t,
    ">=": lambda v, t: v >= t,
    "<=": lambda v, t: v <= t,
    "=": lambda v, t: v == t,
}


def event_key(event_id: str) -> str:
    """The Redis key holding one event."""
    return f"sump:events:{event_id}"


def _text(value: Any) -> str:
    """A Redis reply as text, whether the client decodes or not."""
    return value.decode() if isinstance(value, bytes) else str(value)


def _record(fields: Any) -> dict[str, Any] | None:
    """A stream entry's record (its one `json` field), or None if unreadable."""
    raw = fields.get(b"json", fields.get("json")) if isinstance(fields, dict) else None
    if raw is None:
        return None
    try:
        record = json.loads(_text(raw))
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def _ts_ms(record: dict[str, Any]) -> int | None:
    """A record's event time, in epoch ms."""
    try:
        return int(datetime.fromisoformat(str(record["ts"])).timestamp() * 1000)
    except (KeyError, ValueError):
        return None


class EventStore:
    """The Sump's events, kept in Redis."""

    def __init__(self, redis: Any) -> None:
        self.redis = redis

    async def save(self, event: Event) -> None:
        await self.redis.set(event_key(event.id), json.dumps(event.to_json()))
        await self.redis.sadd(INDEX, event.id)

    async def get(self, event_id: str) -> Event | None:
        raw = await self.redis.get(event_key(event_id))
        return Event.from_json(json.loads(_text(raw))) if raw is not None else None

    async def all(self) -> list[Event]:
        """Every event, by id; one that cannot be read is logged and left out."""
        events = []
        for event_id in sorted(_text(i) for i in await self.redis.smembers(INDEX)):
            try:
                event = await self.get(event_id)
            except ValueError:
                logger.exception("event %s cannot be read; skipped", event_id)
                continue
            if event is not None:
                events.append(event)
        return events

    async def delete(self, event_id: str) -> None:
        await self.redis.delete(event_key(event_id))
        await self.redis.srem(INDEX, event_id)

    async def create(self, spec: dict[str, Any], now_ms: int) -> Event:
        """Make an event from `spec`, refused if invalid; its log positions at the tails."""
        conditions = [parse_condition(c) for c in spec.get("conditions") or []]
        event = Event(
            id=f"evt-{secrets.token_hex(6)}",
            name=str(spec.get("name", "")),
            stream=str(spec.get("stream", "")),
            conditions=conditions,
            match=spec.get("match", "any"),
            containers=list(spec.get("containers") or []),
            host=spec.get("host") is True,
            created_at=now_ms,
        )
        validate(event)
        engine = Engine(self.redis, self)
        for index, condition in enumerate(event.conditions):
            if isinstance(condition, LogCondition):
                tails: dict[str, str] = {}
                for source in await engine.sources(event, "log"):
                    last = await self.redis.xrevrange(stream_key(source, "log"), count=1)
                    if last:
                        tails[source] = _text(last[0][0])
                event.positions[str(index)] = tails
        await self.save(event)
        return event


class Engine:
    """Evaluates the Sump's events, one tick at a time."""

    def __init__(
        self,
        redis: Any,
        store: EventStore | None = None,
        now: Callable[[], float] = lambda: time.time() * 1000,
    ) -> None:
        self.redis = redis
        self.store = store or EventStore(redis)
        self.now = now

    async def sources(self, event: Event, kind: str) -> list[str]:
        """The watched sources of `kind` that have a stream: `<stream>/<container>`."""
        prefix = f"sump:records:{event.stream}/"
        suffix = f":{kind}"
        found = []
        async for key in self.redis.scan_iter(match=f"{prefix}*{suffix}"):
            name = _text(key)[len(prefix) : -len(suffix)]
            if "/" in name:
                continue
            if name == HOST_NAME:
                if event.host and kind == "metric":
                    found.append(name)
            elif not event.containers or name in event.containers:
                found.append(name)
        return [f"{event.stream}/{name}" for name in sorted(found)]

    async def tick(self) -> list[dict[str, Any]]:
        """Evaluate every enabled event once; the firings made."""
        fired = []
        for event in await self.store.all():
            if not event.enabled:
                continue
            try:
                firing = await self.evaluate(event)
            except Exception:
                logger.exception("event %s could not be evaluated", event.id)
                continue
            if firing is not None:
                fired.append(firing)
        return fired

    async def evaluate(self, event: Event) -> dict[str, Any] | None:
        """Check `event` once, fire it on an edge, keep its state; its firing, if any."""
        now = int(self.now())
        # Every condition, never short-circuited: log positions always move.
        details = [await self._check(event, i, c, now) for i, c in enumerate(event.conditions)]
        hits = [d for d in details if d is not None]
        met = bool(hits) if event.match == "any" else len(hits) == len(event.conditions)
        firing = None
        if met:
            if event.armed:
                event.trigger_count += 1
                event.triggered_at = now
                event.trigger_detail = "; ".join(hits)
                firing = {
                    "event": event.id,
                    "name": event.name,
                    "stream": event.stream,
                    "at": str(now),
                    "detail": event.trigger_detail,
                    "count": str(event.trigger_count),
                }
                await self.redis.xadd(FIRINGS, firing, maxlen=FIRINGS_MAXLEN, approximate=True)
            event.armed = False
            event.status = "triggered"
        else:
            event.armed = True
            event.status = "armed"
        await self.store.save(event)
        return firing

    async def _check(self, event: Event, index: int, condition: Any, now: int) -> str | None:
        if isinstance(condition, MetricCondition):
            return await self._check_metric(event, condition, now)
        return await self._check_log(event, index, condition)

    async def _check_metric(self, event: Event, cond: MetricCondition, now: int) -> str | None:
        """The first watched series whose latest live value passes, said; None if none does."""
        compare = _OPS[cond.op]
        for source in await self.sources(event, "metric"):
            entries = await self.redis.xrevrange(stream_key(source, "metric"), count=2)
            records = [r for r in (_record(f) for _, f in entries or []) if r is not None]
            if not records:
                continue
            latest = records[0]
            at = _ts_ms(latest)
            if at is None or now - at > STALE_MS:
                continue
            value = metric_value(cond.metric, latest, records[1] if len(records) > 1 else None)
            if value is not None and compare(value, cond.threshold):
                name = source.split("/", 1)[1]
                return f"{name} {cond.metric} {value:.1f} {cond.op} {cond.threshold:g}"
        return None

    async def _check_log(self, event: Event, index: int, cond: LogCondition) -> str | None:
        """Read every line since each watched source's position; the first match, said."""
        regex = re.compile(cond.pattern)
        positions = event.positions.setdefault(str(index), {})
        hit = None
        for source in await self.sources(event, "log"):
            position = positions.get(source, f"{event.created_at}-0")
            key = stream_key(source, "log")
            while True:
                page = await self.redis.xrange(key, min=f"({position}", count=LOG_PAGE)
                for entry_id, fields in page or []:
                    position = _text(entry_id)
                    record = _record(fields)
                    line = str(record.get("message", "")) if record else ""
                    if hit is None and regex.search(line):
                        first = line.splitlines()[0][:200] if line else ""
                        hit = f"{source.split('/', 1)[1]}: {first}"
                if not page or len(page) < LOG_PAGE:
                    break
            positions[source] = position
        return hit


def metric_value(
    metric: str, latest: dict[str, Any], previous: dict[str, Any] | None
) -> float | None:
    """A series' cpu %, mem % or network bytes/s from its latest two samples."""
    if metric == "cpu":
        value = latest.get("cpu_percent")
        return float(value) if isinstance(value, int | float) else None
    if metric == "mem":
        used, limit = latest.get("mem_used_bytes"), latest.get("mem_limit_bytes")
        if isinstance(used, int | float) and isinstance(limit, int | float) and limit > 0:
            return used / limit * 100
        return None
    # net: the rx + tx counters' rate between the two latest samples.
    if previous is None:
        return None
    t1, t0 = _ts_ms(latest), _ts_ms(previous)
    try:
        total1 = float(latest["net_rx_bytes"]) + float(latest["net_tx_bytes"])
        total0 = float(previous["net_rx_bytes"]) + float(previous["net_tx_bytes"])
    except (KeyError, TypeError, ValueError):
        return None
    if t1 is None or t0 is None or t1 <= t0 or total1 < total0:
        return None
    return (total1 - total0) / ((t1 - t0) / 1000)
