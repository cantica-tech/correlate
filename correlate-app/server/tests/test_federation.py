"""br-FED-000002-sJpO9KMY (REQ-000052-sJpO9KMY step 3): a promoted stream's
queries, answered from this Sump's history before the promotion time and
the secondary's after, through the query functions unchanged."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis.aioredis
import pytest

from correlate_sump.federation import Federated, FederatedRedis, parse_key
from correlate_sump.ingest import stream_key
from correlate_sump.logs import log_density, log_page
from correlate_sump.plugins import PluginManager, hookimpl
from correlate_sump.records import query_records
from correlate_sump.span import data_range

SOURCE = "ssh:ops@lab:22/web"
T0 = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)
CUT = T0 + timedelta(minutes=10)
END = T0 + timedelta(hours=1)


def _log(minute: int, text: str) -> dict[str, Any]:
    ts = (T0 + timedelta(minutes=minute)).isoformat()
    return {"ts": ts, "kind": "log", "source": SOURCE, "message": text, "level": "INFO"}


async def _redis() -> Any:
    redis = fakeredis.aioredis.FakeRedis()
    # Collected here: before the promotion, and one stray line after it.
    for record in [_log(1, "here 1"), _log(5, "here 5"), _log(12, "stray")]:
        await redis.xadd(stream_key(SOURCE, "log"), {"json": json.dumps(record)})
    await redis.xadd(stream_key("self/db", "log"), {"json": json.dumps(_log(3, "db"))})
    return redis


def _secondary(records: list[dict[str, Any]], fail: bool = False) -> Any:
    asked: list[str] = []

    async def fetch(kind: str) -> list[dict[str, Any]]:
        asked.append(kind)
        if fail:
            raise OSError("the secondary is unreachable")
        return [r for r in records if r["kind"] == kind]

    def lookup(source: str) -> Federated | None:
        return Federated(cut=CUT, fetch=fetch) if source == SOURCE else None

    return lookup, asked


async def test_a_range_across_the_promotion_returns_both_parts_in_order_once() -> None:
    remote = [_log(9, "before the cut"), _log(10, "there 10"), _log(15, "there 15")]
    lookup, asked = _secondary(remote)
    redis = FederatedRedis(await _redis(), lookup)
    page = await log_page(redis, SOURCE, start=T0, end=END, order="oldest", offset=0, limit=100)
    assert [r["message"] for r in page["rows"]] == ["here 1", "here 5", "there 10", "there 15"]
    assert page["total"] == 4 and asked == ["log"]
    newest = await log_page(redis, SOURCE, start=T0, end=END, offset=0, limit=100)
    assert newest["rows"][0]["message"] == "there 15"
    density = await log_density(redis, SOURCE, start=T0, end=T0 + timedelta(minutes=20), buckets=2)
    assert density["counts"] == [2, 2]
    span = await data_range(redis, [SOURCE])
    assert span["from"].startswith("2026-11-22T12:01")
    assert span["to"].startswith("2026-11-22T12:15")


async def test_cursors_page_through_the_join() -> None:
    lookup, _asked = _secondary([_log(m, f"there {m}") for m in range(10, 20)])
    redis = FederatedRedis(await _redis(), lookup)
    seen: list[str] = []
    cursor = None
    while True:
        got = await query_records(
            redis, SOURCE, kind="log", start=T0, end=END, log_cursor=cursor, limit=4
        )
        seen += [r["message"] for r in got["records"]]
        cursor = got["next_log_cursor"]
        if cursor is None:
            break
    assert seen == ["here 1", "here 5"] + [f"there {m}" for m in range(10, 20)]


async def test_an_unreachable_secondary_leaves_this_sumps_history() -> None:
    lookup, _asked = _secondary([], fail=True)
    redis = FederatedRedis(await _redis(), lookup)
    page = await log_page(redis, SOURCE, start=T0, end=END, order="oldest", offset=0, limit=100)
    assert [r["message"] for r in page["rows"]] == ["here 1", "here 5"]


async def test_other_sources_and_keys_are_redis_s_own() -> None:
    lookup, asked = _secondary([_log(11, "there")])
    redis = FederatedRedis(await _redis(), lookup)
    page = await log_page(redis, "self/db", start=T0, end=END, offset=0, limit=100)
    assert [r["message"] for r in page["rows"]] == ["db"] and asked == []
    assert parse_key("sump:records:ssh:ops@lab:22/web:log") == (SOURCE, "log")
    assert parse_key("sump:sessions:abc") is None
    assert await redis.xlen(stream_key("self/db", "log")) == 1


def test_the_first_plugin_that_knows_the_source_answers() -> None:
    class Promoting:
        @hookimpl
        def federated_source(self, source: str) -> Federated | None:
            return Federated(cut=CUT, fetch=_never) if source == SOURCE else None

    async def _never(kind: str) -> list[dict[str, Any]]:
        raise AssertionError(kind)

    manager = PluginManager(disable_autoload=True)
    manager.register(Promoting(), name="promoting")
    found = manager.hook.federated_source(source=SOURCE)
    assert isinstance(found, Federated) and found.cut == CUT
    assert manager.hook.federated_source(source="self/db") is None


@pytest.fixture(autouse=True)
def _no_entry_points(monkeypatch) -> None:
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": []
    )
