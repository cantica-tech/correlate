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
from typing import TYPE_CHECKING, Any

from redis.exceptions import WatchError

from correlate_sump.ingest import stream_key
from sump_plugin_events.model import (
    Event,
    LogCondition,
    MetricCondition,
    parse_action,
    parse_condition,
    validate,
)
from sump_plugin_events.schedule import describe, next_due, parse_schedule, zone

if TYPE_CHECKING:
    from sump_plugin_events.artifacts import Artifacts

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


async def watched_sources(
    redis: Any, stream: str, containers: list[str], host: bool, kind: str
) -> list[str]:
    """The sources of `kind` with a stream in `stream`: all its containers, or
    `containers`; its host (`__host__`) for metrics when `host`."""
    prefix = f"sump:records:{stream}/"
    suffix = f":{kind}"
    found = []
    async for key in redis.scan_iter(match=f"{prefix}*{suffix}"):
        name = _text(key)[len(prefix) : -len(suffix)]
        if "/" in name:
            continue
        if name == HOST_NAME:
            if host and kind == "metric":
                found.append(name)
        elif not containers or name in containers:
            found.append(name)
    return [f"{stream}/{name}" for name in sorted(found)]


class EventRefused(Exception):
    """An API call the store refuses: its HTTP status and why."""

    status = 400


class EventNotFound(EventRefused):
    status = 404


class EventForbidden(EventRefused):
    status = 403


class EventConflict(EventRefused):
    """The edit was based on another version (br-EVENT-000007-sJpO9KMY)."""

    status = 409


#: The definition fields an edit may change.
EDITABLE = (
    "name",
    "stream",
    "conditions",
    "match",
    "action",
    "schedule",
    "containers",
    "host",
    "enabled",
)
#: A schedule this late when the engine sees it was missed: said, not run (Item 49).
MISSED_AFTER_MS = 90_000


def state_key(event_id: str) -> str:
    """The Redis key holding one event's state, written by the engine only."""
    return f"sump:events:{event_id}:state"


class EventStore:
    """The Sump's events, kept in Redis as a versioned definition and a state.

    The API writes definitions, each edit compared and set on its version, so
    a concurrent change is refused, never overwritten; the engine writes only
    states, and only for the definition version it evaluated (decided in
    FEAT-000046-sJpO9KMY, cttc bug 25).
    """

    def __init__(self, redis: Any) -> None:
        self.redis = redis

    async def get(self, event_id: str) -> Event | None:
        raw = await self.redis.get(event_key(event_id))
        if raw is None:
            return None
        state = await self.redis.get(state_key(event_id))
        merged = {**(json.loads(_text(state)) if state is not None else {})}
        merged.update(json.loads(_text(raw)))
        return Event.from_json(merged)

    async def all(self) -> list[Event]:
        """Every event, by id; one that cannot be read is logged and left out."""
        events = []
        for event_id in sorted(_text(i) for i in await self.redis.smembers(INDEX)):
            try:
                event = await self.get(event_id)
            except (ValueError, KeyError):
                logger.exception("event %s cannot be read; skipped", event_id)
                continue
            if event is not None:
                events.append(event)
        return events

    async def save_state(self, event: Event) -> bool:
        """Keep `event`'s state, unless its definition changed or went meanwhile."""
        key = event_key(event.id)
        try:
            async with self.redis.pipeline(transaction=True) as pipe:
                await pipe.watch(key)
                raw = await pipe.get(key)
                if raw is None or json.loads(_text(raw)).get("version") != event.version:
                    await pipe.reset()
                    return False
                pipe.multi()
                pipe.set(state_key(event.id), json.dumps(event.state()))
                await pipe.execute()
                return True
        except WatchError:
            return False

    async def _seed(self, event: Event, now_ms: int | None = None) -> None:
        """Re-arm `event`, its log positions at the streams' tails, its schedule's next time."""
        event.armed, event.status = True, "armed"
        event.positions = {}
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        event.next_due = next_due(event.schedule, now)
        engine = Engine(self.redis, self)
        for index, condition in enumerate(event.conditions):
            if isinstance(condition, LogCondition):
                tails: dict[str, str] = {}
                for source in await engine.sources(event, "log"):
                    last = await self.redis.xrevrange(stream_key(source, "log"), count=1)
                    if last:
                        tails[source] = _text(last[0][0])
                event.positions[str(index)] = tails

    async def create(self, spec: dict[str, Any], owner: str, now_ms: int) -> Event:
        """Make `owner`'s event from `spec`, refused if invalid; its log positions at the tails."""
        conditions = [parse_condition(c) for c in spec.get("conditions") or []]
        event = Event(
            id=f"evt-{secrets.token_hex(6)}",
            name=str(spec.get("name", "")),
            stream=str(spec.get("stream", "")),
            conditions=conditions,
            match=spec.get("match", "any"),
            action=parse_action(spec.get("action")),
            schedule=parse_schedule(spec.get("schedule"), now_ms),
            containers=list(spec.get("containers") or []),
            host=spec.get("host") is True,
            enabled=spec.get("enabled") is not False,
            created_at=now_ms,
            owner=owner,
            version=1,
        )
        validate(event)
        await self._seed(event, now_ms)
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.set(event_key(event.id), json.dumps(event.definition()))
            pipe.set(state_key(event.id), json.dumps(event.state()))
            pipe.sadd(INDEX, event.id)
            await pipe.execute()
        return event

    async def update(self, event_id: str, spec: dict[str, Any], editor: str) -> Event:
        """Edit the event as `spec` says, based on `spec["version"]`; its owner only.

        Changing the conditions or the stream re-arms it and moves its log
        positions to the tails; any other change keeps its state.
        """
        key = event_key(event_id)
        try:
            async with self.redis.pipeline(transaction=True) as pipe:
                await pipe.watch(key, state_key(event_id))
                current = await self.get(event_id)
                if current is None:
                    raise EventNotFound(f"no event {event_id}")
                if current.owner != editor:
                    raise EventForbidden("only the event's owner can edit it")
                based_on = spec.get("version")
                if based_on != current.version:
                    raise EventConflict(
                        f"the event is at version {current.version}, not {based_on}: "
                        "reload it and edit again"
                    )
                edited = Event.from_json(current.to_json())
                for name in EDITABLE:
                    if name not in spec:
                        continue
                    value = spec[name]
                    if name == "conditions":
                        value = [parse_condition(c) for c in value or []]
                    elif name == "action":
                        value = parse_action(value)
                    elif name == "schedule":
                        value = parse_schedule(value, int(time.time() * 1000))
                    elif name in ("host", "enabled"):
                        value = value is True
                    elif name == "containers":
                        value = list(value or [])
                    setattr(edited, name, value)
                validate(edited)
                edited.version = current.version + 1
                reseed = (
                    edited.stream != current.stream
                    or edited.conditions != current.conditions
                    or edited.schedule != current.schedule
                )
                if reseed:
                    await self._seed(edited)
                pipe.multi()
                pipe.set(key, json.dumps(edited.definition()))
                if reseed:
                    pipe.set(state_key(event_id), json.dumps(edited.state()))
                await pipe.execute()
                return edited
        except WatchError as error:
            raise EventConflict("the event changed meanwhile: reload it and edit again") from error

    async def delete(
        self, event_id: str, version: Any, caller: str, sump_owner: str | None
    ) -> None:
        """Delete the event at `version`: its owner, or the Sump's owner. Its firings stay."""
        try:
            async with self.redis.pipeline(transaction=True) as pipe:
                await pipe.watch(event_key(event_id))
                current = await self.get(event_id)
                if current is None or not visible(current, caller, sump_owner):
                    raise EventNotFound(f"no event {event_id}")
                if current.owner != caller and caller != sump_owner:
                    raise EventForbidden("only the event's owner can delete it")
                if version != current.version:
                    raise EventConflict(f"the event is at version {current.version}, not {version}")
                pipe.multi()
                pipe.delete(event_key(event_id), state_key(event_id))
                pipe.srem(INDEX, event_id)
                await pipe.execute()
        except WatchError as error:
            raise EventConflict("the event changed meanwhile: reload it") from error

    async def reset(self, event_id: str, caller: str) -> Event:
        """Re-arm the event without waiting for its conditions to clear; its owner only."""
        current = await self.get(event_id)
        if current is None:
            raise EventNotFound(f"no event {event_id}")
        if current.owner != caller:
            raise EventForbidden("only the event's owner can reset it")
        current.armed, current.status = True, "armed"
        if not await self.save_state(current):
            raise EventConflict("the event changed meanwhile: reload it")
        return current


def visible(event: Event, caller: str, sump_owner: str | None) -> bool:
    """Whether `caller` sees `event`: their own, or any for the Sump's owner."""
    return event.owner == caller or (sump_owner is not None and caller == sump_owner)


class Engine:
    """Evaluates the Sump's events, one tick at a time."""

    def __init__(
        self,
        redis: Any,
        store: EventStore | None = None,
        now: Callable[[], float] = lambda: time.time() * 1000,
        artifacts: Artifacts | None = None,
        hidden: Callable[[str, str], bool] | None = None,
    ) -> None:
        self.redis = redis
        self.store = store or EventStore(redis)
        self.now = now
        #: Whether a source is hidden from a user (br-STREAM-000007-sJpO9KMY):
        #: an event sees no data from a source hidden from its owner.
        self.hidden = hidden
        #: Where a firing's action makes its artifact (Item 47); none, no action.
        self.artifacts = artifacts

    async def sources(self, event: Event, kind: str) -> list[str]:
        """The watched sources of `kind` that have a stream: `<stream>/<container>`,
        those hidden from the event's owner left out (br-STREAM-000007-sJpO9KMY)."""
        found = await watched_sources(self.redis, event.stream, event.containers, event.host, kind)
        if self.hidden is None:
            return found
        return [s for s in found if not self.hidden(s, event.owner)]

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
        if self.artifacts is not None:
            try:
                await self.artifacts.tick(int(self.now()))
            except Exception:
                logger.exception("artifacts could not be completed or swept")
        return fired

    async def evaluate(self, event: Event) -> dict[str, Any] | None:
        """Check `event` once, fire it on an edge, keep its state; its firing, if any."""
        now = int(self.now())
        if event.schedule.kind != "none":
            return await self._evaluate_schedule(event, now)
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
                    "owner": event.owner,
                    "stream": event.stream,
                    "at": str(now),
                    "detail": event.trigger_detail,
                    "count": str(event.trigger_count),
                }
            event.armed = False
            event.status = "triggered"
        else:
            event.armed = True
            event.status = "armed"
        # Kept only if the definition was not edited meanwhile; then no firing.
        if not await self.store.save_state(event):
            return None
        if firing is not None:
            # The action, on the Sump; the firing names what it made (REQ-000045).
            artifact, note = None, None
            if self.artifacts is not None:
                try:
                    artifact, note = await self.artifacts.on_firing(event, now)
                except Exception as error:
                    logger.exception("event %s's action failed", event.id)
                    note = f"the action failed: {error}"
            firing["artifact"] = artifact or ""
            firing["note"] = note or ""
            await self.redis.xadd(FIRINGS, firing, maxlen=FIRINGS_MAXLEN, approximate=True)
        return firing

    async def _evaluate_schedule(self, event: Event, now: int) -> dict[str, Any] | None:
        """Fire a scheduled event when it is due (Item 49); a time missed while
        the Sump was down is said once as missed, never run late."""
        due = event.next_due
        if due is None or due > now:
            return None
        missed = now - due > MISSED_AFTER_MS
        event.trigger_count += 1
        event.triggered_at = now
        event.trigger_detail = describe(event.schedule)
        event.next_due = next_due(event.schedule, now)
        event.status = "triggered" if event.next_due is None else "armed"
        if not await self.store.save_state(event):
            return None
        firing = {
            "event": event.id,
            "name": event.name,
            "owner": event.owner,
            "stream": event.stream,
            "at": str(now),
            "detail": event.trigger_detail,
            "count": str(event.trigger_count),
            "artifact": "",
            "note": "",
        }
        if missed:
            local = datetime.fromtimestamp(due / 1000, zone(event.schedule.tz))
            firing["note"] = f"missed: the Sump was not running at {local:%Y-%m-%d %H:%M}"
        elif self.artifacts is not None:
            try:
                artifact, note = await self.artifacts.on_firing(event, now)
                firing["artifact"], firing["note"] = artifact or "", note or ""
            except Exception as error:
                logger.exception("event %s's action failed", event.id)
                firing["note"] = f"the action failed: {error}"
        await self.redis.xadd(FIRINGS, firing, maxlen=FIRINGS_MAXLEN, approximate=True)
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
        # A source hidden from the owner moves its position to its tail unread:
        # made shared again, its lines from the private time are not matched.
        if self.hidden is not None:
            every = await watched_sources(
                self.redis, event.stream, event.containers, event.host, "log"
            )
            for source in every:
                if self.hidden(source, event.owner):
                    last = await self.redis.xrevrange(stream_key(source, "log"), count=1)
                    if last:
                        positions[source] = _text(last[0][0])
        for source in await self.sources(event, "log"):
            position = positions.get(source, f"{event.created_at}-0")
            key = stream_key(source, "log")
            while True:
                page = await self.redis.xrange(key, min=f"({position}", count=LOG_PAGE)
                for entry_id, fields in page or []:
                    position = _text(entry_id)
                    record = _record(fields)
                    line = log_text(record) if record else ""
                    if hit is None and regex.search(line):
                        first = line.splitlines()[0][:200] if line else ""
                        hit = f"{source.split('/', 1)[1]}: {first}"
                if not page or len(page) < LOG_PAGE:
                    break
            positions[source] = position
        return hit


def log_text(record: dict[str, Any]) -> str:
    """A log record's line: `text`, as the SSH plugin writes it, or `message`."""
    return str(record.get("text", record.get("message", "")))


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
