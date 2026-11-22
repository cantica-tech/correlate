"""Schedules and the snapshot window (REQ-000047-sJpO9KMY): events firing once
or on cron in their zone, a missed time said once and never run late; a
warning when a stream's cap holds less than a snapshot's window."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import fakeredis.aioredis
import pytest
from sump_plugin_events.artifacts import Artifacts, window_warnings
from sump_plugin_events.engine import Engine, EventStore
from sump_plugin_events.model import InvalidEvent
from sump_plugin_events.schedule import Cron, Schedule, next_due, parse_schedule

from correlate_sump.ingest import stream_key

PARIS = ZoneInfo("Europe/Paris")
MIN = 60_000


def ms(*args: int, tz: Any = UTC) -> int:
    return int(datetime(*args, tzinfo=tz).timestamp() * 1000)


@pytest.mark.parametrize(
    ("raw", "why"),
    [
        ({"kind": "cron", "cron": "* * *", "tz": "UTC"}, "five fields"),
        ({"kind": "cron", "cron": "60 * * * *", "tz": "UTC"}, "outside 0-59"),
        ({"kind": "cron", "cron": "*/0 * * * *", "tz": "UTC"}, "positive number"),
        ({"kind": "cron", "cron": "a * * * *", "tz": "UTC"}, "not a number"),
        ({"kind": "cron", "cron": "0 2 * * *", "tz": "Mars/Olympus"}, "unknown time zone"),
        ({"kind": "once", "tz": "UTC"}, "needs a time"),
        ({"kind": "once", "at": 1000, "tz": "UTC"}, "already past"),
        ({"kind": "weekly"}, "unknown schedule"),
    ],
)
def test_a_schedule_the_sump_could_not_keep_is_refused(raw: dict[str, Any], why: str) -> None:
    with pytest.raises(InvalidEvent, match=why):
        parse_schedule(raw, now_ms=2000)


def test_cron_fields_ranges_lists_steps_and_cron_day_rule() -> None:
    cron = Cron.parse("*/15 9-17 * * 1-5")
    assert sorted(cron.minutes) == [0, 15, 30, 45]
    assert cron.matches(datetime(2026, 11, 23, 9, 30))  # a Monday
    assert not cron.matches(datetime(2026, 11, 22, 9, 30))  # a Sunday
    # Both day fields restricted: either is enough (the 1st, or any Sunday).
    either = Cron.parse("0 0 1 * 0")
    assert either.matches(datetime(2026, 11, 1, 0, 0))
    assert either.matches(datetime(2026, 11, 22, 0, 0))
    assert not either.matches(datetime(2026, 11, 23, 0, 0))
    assert Cron.parse("0 0 * * 7").matches(datetime(2026, 11, 22, 0, 0))  # 7 is Sunday too


def test_cron_is_due_in_the_events_zone_across_daylight_saving() -> None:
    nightly = Schedule(kind="cron", cron="0 2 * * *", tz="Europe/Paris")
    # 02:00 in Paris is 01:00 UTC in winter, 00:00 UTC in summer.
    assert next_due(nightly, ms(2026, 11, 22, 12, 0)) == ms(2026, 11, 23, 2, 0, tz=PARIS)
    assert next_due(nightly, ms(2026, 7, 1, 12, 0)) == ms(2026, 7, 2, 0, 0)
    once = Schedule(kind="once", at=ms(2026, 12, 1, 8, 0), tz="UTC")
    assert next_due(once, ms(2026, 11, 22)) == ms(2026, 12, 1, 8, 0)
    assert next_due(once, ms(2026, 12, 2)) is None


class Clock:
    def __init__(self, at: int) -> None:
        self.now = at


async def scheduled(tmp_path: Path, schedule: dict[str, Any], clock: Clock) -> tuple[Engine, Any]:
    redis = fakeredis.aioredis.FakeRedis()
    store = EventStore(redis)
    engine = Engine(redis, store, lambda: clock.now, Artifacts(redis, tmp_path))
    event = await store.create(
        {
            "name": "nightly",
            "stream": "self",
            "conditions": [],
            "schedule": schedule,
            "action": {"kind": "snapshot"},
        },
        "ann",
        clock.now,
    )
    return engine, event


async def test_a_cron_event_fires_when_due_with_its_action(tmp_path: Path) -> None:
    clock = Clock(ms(2026, 11, 22, 1, 59))
    engine, event = await scheduled(
        tmp_path, {"kind": "cron", "cron": "0 2 * * *", "tz": "UTC"}, clock
    )
    assert event.next_due == ms(2026, 11, 22, 2, 0)
    assert await engine.tick() == []
    clock.now = ms(2026, 11, 22, 2, 0, 1)
    [firing] = await engine.tick()
    assert firing["detail"] == "scheduled (0 2 * * *, UTC)"
    assert firing["note"] == "" and firing["artifact"]
    assert await engine.tick() == []
    stored = await engine.store.get(event.id)
    assert stored is not None and stored.next_due == ms(2026, 11, 23, 2, 0)


async def test_a_time_missed_while_the_sump_was_down_is_said_once_never_run(tmp_path: Path) -> None:
    clock = Clock(ms(2026, 11, 20, 1, 0))
    engine, _ = await scheduled(tmp_path, {"kind": "cron", "cron": "0 2 * * *", "tz": "UTC"}, clock)
    # The Sump comes back two days later: three nights passed, one firing says so.
    clock.now = ms(2026, 11, 22, 12, 0)
    [missed] = await engine.tick()
    assert missed["note"] == "missed: the Sump was not running at 2026-11-20 02:00"
    assert missed["artifact"] == ""
    assert await engine.tick() == []


async def test_a_one_off_event_fires_once_then_is_done(tmp_path: Path) -> None:
    clock = Clock(ms(2026, 11, 22, 12, 0))
    engine, event = await scheduled(
        tmp_path, {"kind": "once", "at": ms(2026, 11, 22, 12, 30), "tz": "UTC"}, clock
    )
    clock.now = ms(2026, 11, 22, 12, 30, 5)
    assert len(await engine.tick()) == 1
    clock.now = ms(2026, 11, 23)
    assert await engine.tick() == []
    stored = await engine.store.get(event.id)
    assert stored is not None and (stored.next_due, stored.status) == (None, "triggered")


async def test_an_event_needs_conditions_or_a_schedule(tmp_path: Path) -> None:
    store = EventStore(fakeredis.aioredis.FakeRedis())
    with pytest.raises(InvalidEvent, match="or a schedule"):
        await store.create({"name": "x", "stream": "self", "conditions": []}, "ann", 0)


async def test_a_stream_keeping_less_than_the_window_is_warned_and_its_snapshot_noted(
    tmp_path: Path,
) -> None:
    redis = fakeredis.aioredis.FakeRedis()
    now = ms(2026, 11, 22, 12, 0)
    key = stream_key("self/web", "metric")
    # 10 records a minute apart, a cap of 3: about 2 minutes held of a 5-minute window.
    for i in range(10):
        ts = datetime.fromtimestamp((now - (9 - i) * MIN) / 1000, UTC).isoformat()
        record = {"kind": "metric", "source": "self/web", "ts": ts, "cpu_percent": 99}
        await redis.xadd(key, {"json": json.dumps(record)}, id=f"{now - (9 - i) * MIN}-0")
    await redis.xtrim(key, maxlen=3, approximate=False)
    store = EventStore(redis)
    cpu = {"type": "metric", "metric": "cpu", "op": ">", "threshold": 50}
    event = await store.create(
        {
            "name": "x",
            "stream": "self",
            "conditions": [cpu],
            "action": {"kind": "snapshot", "minutes": 5},
        },
        "ann",
        now,
    )
    assert await window_warnings(redis, event, 3) == [
        "self/web metrics: about 3.0 of the 5 minutes are kept at the current rate"
    ]
    assert await window_warnings(redis, event, 100) == []
    artifacts = Artifacts(redis, tmp_path, maxlen=3)
    engine = Engine(redis, store, lambda: now, artifacts)
    [firing] = await engine.tick()
    record = await artifacts.get(firing["artifact"])
    assert record is not None
    assert (record["status"], record["note"]) == (
        "complete",
        "shorter than asked: a stream no longer held its start",
    )
