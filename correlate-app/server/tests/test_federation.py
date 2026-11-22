"""br-FED-000002-sJpO9KMY (REQ-000052-sJpO9KMY step 3): a promoted stream's
queries, answered from this Sump's history before the promotion time and
the secondary's after, through the query functions unchanged."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

from correlate_sump.app import create_app
from correlate_sump.federation import CURRENT_USER, Federated, FederatedRedis, parse_key
from correlate_sump.ingest import stream_key
from correlate_sump.logs import log_density, log_page
from correlate_sump.plugins import PluginManager, hookimpl
from correlate_sump.records import query_records
from correlate_sump.span import data_range
from correlate_sump.sshsig import LOGIN_NAMESPACE, sign


def _line(key: ed25519.Ed25519PrivateKey) -> str:
    """An `authorized_keys` line for `key`."""
    return (
        key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )


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


async def test_a_source_hidden_from_the_caller_answers_as_one_with_no_records() -> None:
    """br-STREAM-000007-sJpO9KMY: every query of carol's sees nothing of it."""
    lookup, _asked = _secondary([_log(11, "there")])
    redis = FederatedRedis(await _redis(), lookup, lambda source, user: user == "carol")
    token = CURRENT_USER.set("carol")
    try:
        page = await log_page(redis, SOURCE, start=T0, end=END, offset=0, limit=100)
        assert (page["total"], page["rows"]) == (0, [])
        assert await data_range(redis, [SOURCE]) == {"from": None, "to": None}
        got = await query_records(redis, SOURCE, kind="both", start=T0, end=END)
        assert got["records"] == []
    finally:
        CURRENT_USER.reset(token)
    page = await log_page(redis, SOURCE, start=T0, end=END, offset=0, limit=100)
    assert page["total"] == 3  # bob still sees his own, joined


async def test_the_session_guard_tells_the_queries_who_asks(tmp_path) -> None:
    """The record routes ask the plugins whether a source is hidden from the
    logged-in user, and answer it as empty (br-STREAM-000007-sJpO9KMY)."""
    asked: list[tuple[str, str | None]] = []

    class Private:
        @hookimpl
        def source_hidden(self, source: str, user: str | None) -> bool | None:
            asked.append((source, user))
            return user == "carol" if source == SOURCE else None

    manager = PluginManager(disable_autoload=True)
    manager.register(Private(), name="private")
    redis = await _redis()
    app = create_app(
        redis_client=redis,
        plugin_manager=manager,
        env={"SUMP_DATA_DIR": str(tmp_path)},
        start_ingest=False,
    )
    users = app.state.users
    keys = {name: ed25519.Ed25519PrivateKey.generate() for name in ("alice", "carol")}
    users.set_owner("alice", _line(keys["alice"]))
    users.add_key("carol", _line(keys["carol"]))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sump") as http:

        async def rows(user: str) -> int:
            got = await http.post("/session/challenge", json={"user": user})
            challenge = got.json()["challenge"]
            signature = sign(keys[user], challenge.encode(), LOGIN_NAMESPACE)
            done = await http.post(
                "/session/login",
                json={"user": user, "challenge": challenge, "signature": signature},
            )
            headers = {"Authorization": f"Bearer {done.json()['token']}"}
            params = {"source": SOURCE, "from": T0.isoformat(), "to": END.isoformat()}
            page = await http.get("/records/logs", params=params, headers=headers)
            assert page.status_code == 200, page.text
            return int(page.json()["total"])

        assert await rows("alice") == 3
        assert await rows("carol") == 0
    assert (SOURCE, "carol") in asked and (SOURCE, "alice") in asked
