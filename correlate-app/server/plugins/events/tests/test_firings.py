"""The firings stream and an event's keep days (REQ-000046-sJpO9KMY): only the
caller's firings (the Sump's owner sees all), from now or after an id; an
event's artifacts kept as long as it says."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import fakeredis.aioredis
import pytest
from sump_plugin_events.artifacts import TTL_MS, Artifacts
from sump_plugin_events.engine import FIRINGS, Engine, EventStore
from sump_plugin_events.model import InvalidEvent
from sump_plugin_events.routes import firings_after, start_position


def metric_record(at_ms: float, cpu: float, source: str = "self/web") -> dict[str, Any]:
    """A metric record as the SSH plugin writes it, its CPU at `cpu` %."""
    ts = datetime.fromtimestamp(at_ms / 1000, UTC).isoformat()
    return {"kind": "metric", "source": source, "ts": ts, "cpu_percent": cpu}


async def fire(redis: Any, owner: str, name: str) -> str:
    entry = await redis.xadd(FIRINGS, {"event": f"evt-{name}", "name": name, "owner": owner})
    return entry.decode()


async def take(stream: Any, n: int) -> list[Any]:
    return [await anext(stream) for _ in range(n)]


async def test_a_user_gets_only_their_firings_and_the_owner_all() -> None:
    redis = fakeredis.aioredis.FakeRedis()
    old = await fire(redis, "ann", "before")
    ann = firings_after(redis, await start_position(redis, None), "ann", "owner", block_ms=10)
    owner = firings_after(redis, old, "owner", "owner", block_ms=10)
    await fire(redis, "bob", "bobs")
    await fire(redis, "ann", "anns")
    [mine] = await take(ann, 1)
    assert (mine.event, mine.data["name"]) == ("firing", "anns")
    # From after `old`: both of the new ones, not `old` itself.
    seen = await take(owner, 2)
    assert [e.data["name"] for e in seen] == ["bobs", "anns"]
    assert seen[0].id is not None and seen[0].id > old


async def test_a_reconnect_resumes_after_the_last_firing_it_got() -> None:
    redis = fakeredis.aioredis.FakeRedis()
    first = await fire(redis, "ann", "one")
    await fire(redis, "ann", "two")
    resumed = firings_after(redis, first, "ann", None, block_ms=10)
    [next_one] = await take(resumed, 1)
    assert next_one.data["name"] == "two"


@pytest.mark.parametrize("keep", [-1, 31, "long", True])
async def test_an_events_keep_days_are_0_to_30(keep: Any) -> None:
    store = EventStore(fakeredis.aioredis.FakeRedis())
    spec = {
        "name": "x",
        "stream": "self",
        "conditions": [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 1}],
        "action": {"kind": "snapshot", "keep_days": keep},
    }
    with pytest.raises(InvalidEvent, match="0 \\(24 h\\) to 30 days"):
        await store.create(spec, "ann", 0)


async def test_an_events_artifacts_are_kept_as_long_as_it_says(tmp_path: Path) -> None:
    redis = fakeredis.aioredis.FakeRedis()
    now = 1_763_812_800_000
    store = EventStore(redis)
    artifacts = Artifacts(redis, tmp_path)
    engine = Engine(redis, store, lambda: now, artifacts)
    condition = {"type": "metric", "metric": "cpu", "op": ">", "threshold": 50}
    for days in (0, 7):
        await store.create(
            {
                "name": f"keep {days}",
                "stream": "self",
                "conditions": [condition],
                "action": {"kind": "snapshot", "keep_days": days},
            },
            "ann",
            now,
        )
    await redis.xadd("sump:records:self/web:metric", {"json": json.dumps(metric_record(now, 99))})
    fired = await engine.tick()
    kept: dict[str, Any] = {f["name"]: await artifacts.get(f["artifact"]) for f in fired}
    assert kept["keep 0"]["expires_at"] == now + TTL_MS
    assert kept["keep 0"]["safe"] is False
    assert kept["keep 7"]["expires_at"] == now + 7 * 24 * 3600 * 1000
    assert kept["keep 7"]["safe"] is True
