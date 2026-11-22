"""The event engine (REQ-000043-sJpO9KMY, br-EVENT-000004-sJpO9KMY): events
checked when made, fired on an edge, every series and every new line
evaluated on the Sump's live streams, kept in Redis."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from typing import Any

import fakeredis.aioredis
import pytest
from sump_plugin_events.engine import FIRINGS, LOG_PAGE, Engine, EventStore, event_key
from sump_plugin_events.model import InvalidEvent
from sump_plugin_events.plugin import plugin, run

from correlate_sump.ingest import stream_key


def _iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, UTC).isoformat()


class Sump:
    """A fake Sump's Redis, its clock, and helpers to write records."""

    def __init__(self) -> None:
        self.redis = fakeredis.aioredis.FakeRedis()
        self.now = time.time() * 1000
        self.store = EventStore(self.redis)
        self.engine = Engine(self.redis, self.store, now=lambda: self.now)

    async def metric(self, source: str, ago_ms: float = 0, **fields: Any) -> None:
        record = {"kind": "metric", "source": source, "ts": _iso(self.now - ago_ms), **fields}
        await self.redis.xadd(stream_key(source, "metric"), {"json": json.dumps(record)})

    async def log(self, source: str, message: str) -> None:
        record = {"kind": "log", "source": source, "ts": _iso(self.now), "message": message}
        await self.redis.xadd(stream_key(source, "log"), {"json": json.dumps(record)})

    async def event(self, **spec: Any) -> Any:
        spec.setdefault("name", "busy")
        spec.setdefault("stream", "self")
        return await self.store.create(spec, "ann", int(self.now))

    async def firings(self) -> list[dict[str, str]]:
        entries: Any = await self.redis.xrange(FIRINGS)
        return [{k.decode(): v.decode() for k, v in f.items()} for _, f in entries]

    async def stored(self, event_id: str) -> Any:
        """The event as stored now; it must exist."""
        event = await self.store.get(event_id)
        assert event is not None
        return event


CPU_OVER_50 = {"type": "metric", "metric": "cpu", "op": ">", "threshold": 50}


@pytest.fixture
def sump() -> Sump:
    return Sump()


@pytest.mark.parametrize(
    ("spec", "why"),
    [
        ({"conditions": []}, "at least one condition"),
        ({"conditions": [{**CPU_OVER_50, "threshold": "50"}]}, "must be a number"),
        ({"conditions": [{**CPU_OVER_50, "threshold": True}]}, "must be a number"),
        ({"conditions": [{**CPU_OVER_50, "threshold": float("nan")}]}, "finite"),
        ({"conditions": [{**CPU_OVER_50, "metric": "disk"}]}, "unknown metric"),
        ({"conditions": [{**CPU_OVER_50, "op": "!="}]}, "unknown operator"),
        ({"conditions": [{"type": "log", "pattern": "("}]}, "invalid regex"),
        ({"conditions": [{"type": "trace"}]}, "unknown condition type"),
        ({"conditions": [CPU_OVER_50], "match": "most"}, "match must be"),
        ({"conditions": [CPU_OVER_50], "stream": "a b"}, "one data stream"),
        ({"conditions": [CPU_OVER_50], "name": " "}, "needs a name"),
    ],
)
async def test_an_event_the_engine_could_not_evaluate_is_refused(
    sump: Sump, spec: dict[str, Any], why: str
) -> None:
    with pytest.raises(InvalidEvent, match=why):
        await sump.event(**spec)
    assert await sump.store.all() == []


async def test_a_metric_event_fires_once_per_edge(sump: Sump) -> None:
    event = await sump.event(conditions=[CPU_OVER_50])
    await sump.metric("self/web", cpu_percent=80)
    assert len(await sump.engine.tick()) == 1
    # Still met: no second firing.
    assert await sump.engine.tick() == []
    await sump.metric("self/web", cpu_percent=10)
    assert await sump.engine.tick() == []
    assert (await sump.stored(event.id)).status == "armed"
    await sump.metric("self/web", cpu_percent=90)
    await sump.engine.tick()
    firings = await sump.firings()
    assert [f["count"] for f in firings] == ["1", "2"]
    assert firings[0]["detail"] == "web cpu 80.0 > 50"
    stored = await sump.stored(event.id)
    assert (stored.status, stored.trigger_count) == ("triggered", 2)


async def test_every_watched_series_is_checked_not_only_the_first(sump: Sump) -> None:
    await sump.event(conditions=[CPU_OVER_50])
    await sump.metric("self/api", cpu_percent=5)
    await sump.metric("self/web", cpu_percent=5)
    await sump.metric("self/zeta", cpu_percent=99)
    assert [f["detail"] for f in await sump.engine.tick()] == ["zeta cpu 99.0 > 50"]


async def test_a_stale_series_does_not_keep_an_event_met(sump: Sump) -> None:
    await sump.event(conditions=[CPU_OVER_50])
    await sump.metric("self/web", ago_ms=20_000, cpu_percent=99)
    assert await sump.engine.tick() == []
    await sump.metric("self/web", ago_ms=10_000, cpu_percent=99)
    assert len(await sump.engine.tick()) == 1


async def test_the_host_only_when_asked_and_named_containers_only(sump: Sump) -> None:
    await sump.metric("self/__host__", cpu_percent=99)
    await sump.metric("self/web", cpu_percent=99)
    await sump.metric("other/web", cpu_percent=99)
    plain = await sump.event(conditions=[CPU_OVER_50], containers=["api"])
    assert await sump.engine.tick() == []
    await sump.store.delete(plain.id, 1, "ann", None)
    await sump.event(conditions=[CPU_OVER_50], containers=["api"], host=True)
    assert [f["detail"] for f in await sump.engine.tick()] == ["__host__ cpu 99.0 > 50"]


async def test_memory_as_a_share_of_the_limit_and_network_as_a_rate(sump: Sump) -> None:
    await sump.event(
        conditions=[
            {"type": "metric", "metric": "mem", "op": ">=", "threshold": 75},
            {"type": "metric", "metric": "net", "op": ">", "threshold": 1000},
        ],
        match="all",
    )
    await sump.metric("self/web", ago_ms=2000, net_rx_bytes=1000, net_tx_bytes=0)
    await sump.metric(
        "self/web", mem_used_bytes=750, mem_limit_bytes=1000, net_rx_bytes=3000, net_tx_bytes=1000
    )
    assert [f["detail"] for f in await sump.engine.tick()] == [
        "web mem 75.0 >= 75; web net 1500.0 > 1000"
    ]


async def test_any_or_all_conditions(sump: Sump) -> None:
    both = [CPU_OVER_50, {"type": "metric", "metric": "cpu", "op": ">", "threshold": 90}]
    await sump.event(conditions=both, match="all")
    await sump.metric("self/web", cpu_percent=80)
    assert await sump.engine.tick() == []
    await sump.event(name="any", conditions=both, match="any")
    assert [f["name"] for f in await sump.engine.tick()] == ["any"]


async def test_a_log_event_starts_at_the_tail_and_reads_every_new_line(sump: Sump) -> None:
    # The backlog before the event is made never counts (cttc bug 24).
    await sump.log("self/web", "ERROR old")
    event = await sump.event(conditions=[{"type": "log", "pattern": "ERROR"}])
    assert await sump.engine.tick() == []
    # More than a page of new lines, the match last: read in one tick (bug 23).
    for i in range(LOG_PAGE * 2 + 10):
        await sump.log("self/web", f"line {i}")
    await sump.log("self/web", "ERROR disk full\nstack")
    assert [f["detail"] for f in await sump.engine.tick()] == ["web: ERROR disk full"]
    # Read once: the position moved past it.
    assert await sump.engine.tick() == []
    stored = await sump.stored(event.id)
    tail: Any = await sump.redis.xrevrange(stream_key("self/web", "log"), count=1)
    last = tail[0][0].decode()
    assert stored.positions == {"0": {"self/web": last}}


async def test_a_container_the_stream_gains_later_counts_from_the_events_creation(
    sump: Sump,
) -> None:
    await sump.event(conditions=[{"type": "log", "pattern": "panic"}])
    sump.now += 1000
    await sump.log("self/new", "panic: boom")
    assert [f["detail"] for f in await sump.engine.tick()] == ["new: panic: boom"]


async def test_disabled_events_wait_and_a_broken_one_does_not_stop_the_others(
    sump: Sump,
) -> None:
    off = await sump.event(name="off", conditions=[CPU_OVER_50])
    await sump.store.update(off.id, {"enabled": False, "version": 1}, "ann")
    await sump.event(name="on", conditions=[CPU_OVER_50])
    await sump.redis.set(event_key("evt-broken"), "{not json")
    await sump.redis.sadd("sump:events", "evt-broken")
    await sump.metric("self/web", cpu_percent=99)
    assert [f["name"] for f in await sump.engine.tick()] == ["on"]


async def test_events_and_their_latch_survive_a_restart(sump: Sump) -> None:
    await sump.event(conditions=[CPU_OVER_50])
    await sump.metric("self/web", cpu_percent=99)
    assert len(await sump.engine.tick()) == 1
    # A new engine on the same Redis: the event is still there, still latched.
    again = Engine(sump.redis, EventStore(sump.redis), now=lambda: sump.now)
    assert await again.tick() == []
    assert len(await again.store.all()) == 1


async def test_the_plugin_runs_the_engine_as_a_supervised_background_task(sump: Sump) -> None:
    class Manager:
        def __init__(self) -> None:
            self.tasks: dict[str, Any] = {}
            self.ingest_adapter = type("Adapter", (), {"redis": sump.redis})()

        def add_background_task(self, name: str, factory: Any) -> None:
            self.tasks[name] = factory

    manager = Manager()
    plugin.register_background_task(manager)
    assert list(manager.tasks) == ["evaluation"]
    assert plugin.sump_plugin_info()["name"] == "events"
    await sump.event(conditions=[CPU_OVER_50])
    await sump.metric("self/web", cpu_percent=99)
    await run(sump.engine, every=0, ticks=2)
    assert len(await sump.firings()) == 1
