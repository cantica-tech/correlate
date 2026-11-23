"""The log-sump plugin (REQ-000057-sJpO9KMY): br-STREAM-000010 (the key stays
on the Sump), br-STREAM-000011 (each record once, translated), and the
stream kind through the real Sump (br-PLUGIN-000010), against a fake
log-sump answering as v0.4.2 does (`log_sump/server/queries.py`): pages by
arrival id, no cursor once a page is short.
"""

from __future__ import annotations

import json
import stat
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from sump_plugin_logsump import client as client_module
from sump_plugin_logsump.client import LogSumpClient, LogSumpError
from sump_plugin_logsump.kind import LogSumpStreamKind
from sump_plugin_logsump.plugin import SumpPluginLogSump
from sump_plugin_logsump.relay import poll_once
from sump_plugin_logsump.secrets import LogSumpStore
from sump_plugin_logsump.translate import translate

from correlate_sump.app import create_app
from correlate_sump.plugins import PluginManager
from correlate_sump.sshsig import LOGIN_NAMESPACE, sign
from correlate_sump.streams import StreamDef, StreamError, StreamRefused

T0 = datetime(2026, 11, 23, 9, 0, tzinfo=UTC)
KEY = "secret-key-1"
URL = "http://logs.lab:8080"


def log(name: str, at: datetime, seq: int, message: str) -> dict[str, Any]:
    return {
        "kind": "log",
        "docker_host": "prod",
        "container_name": name,
        "container_id": f"id-{name}",
        "ts": at.isoformat(),
        "seq": seq,
        "stream": "stdout",
        "level": "info",
        "message": message,
        "fields": {},
        "raw": message,
    }


def metric(name: str | None, at: datetime, seq: int, cpu: float) -> dict[str, Any]:
    system = name is None
    return {
        "kind": "metric",
        "docker_host": "prod",
        "container_name": name or "prod",
        "container_id": "__system__" if system else f"id-{name}",
        "ts": at.isoformat(),
        "seq": seq,
        "metric_scope": "system" if system else "container",
        "cpu_pct": cpu,
        "mem_used_bytes": 100,
        "mem_limit_bytes": 1000,
        "net_rx_bytes": 1,
        "net_tx_bytes": 2,
        "blk_read_bytes": 3,
        "blk_write_bytes": 4,
        "pids": 5,
        "source": "docker stats",
        "raw": None,
    }


class FakeLogSump:
    """log-sump v0.4.2's `/catalog` and `/records`, its records by arrival."""

    def __init__(self) -> None:
        #: (arrival ms, seq, kind, record): an arrival id is `<ms>-<seq>`.
        self.entries: list[tuple[int, int, str, dict[str, Any]]] = []
        self.keys = {KEY: ["prod"]}
        self.asked: list[dict[str, str]] = []
        self.down = False

    def arrive(self, at: datetime, record: dict[str, Any]) -> None:
        ms = int(at.timestamp() * 1000)
        self.entries.append((ms, len(self.entries), record["kind"], record))

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("down")
        permitted = self.keys.get(request.headers.get("X-API-Key", ""))
        if permitted is None:
            return httpx.Response(401, json={"detail": "bad key"})
        if request.url.path == "/catalog":
            return httpx.Response(
                200,
                json=[
                    {"id": h, "host": f"ssh://{h}", "enabled": True, "watched_containers": ["db"]}
                    for h in permitted
                ],
            )
        params = dict(request.url.params)
        self.asked.append(params)
        if params["docker_host"] not in permitted:
            return httpx.Response(403, json={"detail": "not permitted"})
        start = int(datetime.fromisoformat(params["start"]).timestamp() * 1000)
        end = int(datetime.fromisoformat(params["end"]).timestamp() * 1000)
        limit = int(params.get("limit", 200))
        page: list[dict[str, Any]] = []
        cursors: dict[str, str | None] = {}
        for kind in ("log", "metric"):
            after = params.get(f"{kind}_cursor")
            rows = [
                (f"{ms}-{seq}", r)
                for ms, seq, k, r in self.entries
                if k == kind and start <= ms <= end
            ]
            if after:
                rows = [row for row in rows if _id(row[0]) > _id(after)]
            taken = rows[:limit]
            page.extend(r for _i, r in taken)
            cursors[f"next_{kind}_cursor"] = taken[-1][0] if len(taken) == limit else None
        page.sort(key=lambda r: r["ts"])
        return httpx.Response(200, json={"records": page, **cursors})


def _id(entry_id: str) -> tuple[int, int]:
    ms, seq = entry_id.split("-")
    return int(ms), int(seq)


@pytest.fixture
def fake(monkeypatch) -> FakeLogSump:
    monkeypatch.setattr(client_module, "PAGE", 2)
    return FakeLogSump()


def client_for(fake: FakeLogSump):
    transport = httpx.MockTransport(fake.handler)
    return lambda url, key: LogSumpClient(url, key, transport=transport)


# -- br-STREAM-000011: translation ------------------------------------------


def test_translates_logs_container_and_host_metrics_and_drops_the_rest() -> None:
    sid = "logsump:prod@logs.lab:8080"
    assert translate(sid, log("web", T0, 1, "GET / 200")) == {
        "kind": "log",
        "source": f"{sid}/web",
        "ts": T0.isoformat(),
        "container": "web",
        "stream": "stdout",
        "level": "info",
        "text": "GET / 200",
    }
    container = translate(sid, metric("web", T0, 2, 12.5))
    assert container is not None
    assert (container["source"], container["cpu_percent"], container["block_read_bytes"]) == (
        f"{sid}/web",
        12.5,
        3,
    )
    host = translate(sid, metric(None, T0, 3, 40.0))
    assert host is not None
    assert (host["source"], host["host"], host["cpu_percent"]) == (f"{sid}/__host__", "prod", 40.0)
    assert translate(sid, {"kind": "service", "ts": T0.isoformat()}) is None
    assert translate(sid, {**log("web", T0, 1, "x"), "ts": None}) is None


# -- br-STREAM-000011: each record once --------------------------------------


async def test_the_relay_brings_each_followed_record_once_across_pages_polls_and_restarts(
    fake: FakeLogSump, tmp_path: Path
) -> None:
    sid = "logsump:prod@logs.lab:8080"
    client = client_for(fake)(URL, KEY)
    store = LogSumpStore(tmp_path / "logsump")
    added = T0
    store.put(
        sid,
        {
            "url": URL,
            "api_key": KEY,
            "docker_host": "prod",
            "start_at": added.isoformat(),
            "since": added.isoformat(),
            "seen": [],
        },
    )
    # Before the stream was added: never brought.
    fake.arrive(T0 - timedelta(minutes=5), log("web", T0 - timedelta(minutes=5), 1, "before"))
    for i in range(5):  # more than a page (2) of each kind
        at = T0 + timedelta(seconds=i)
        fake.arrive(at, log("web", at, 10 + i, f"web {i}"))
        fake.arrive(at, log("other", at, 20 + i, f"other {i}"))
    fake.arrive(T0 + timedelta(seconds=1), metric(None, T0 + timedelta(seconds=1), 30, 50.0))
    got: list[dict[str, Any]] = []

    async def ingest(record: dict[str, Any]) -> None:
        got.append(record)

    entry = store.get(sid)
    assert entry is not None
    store.update(
        sid, **await poll_once(client, sid, entry, {"web"}, ingest, T0 + timedelta(seconds=10))
    )
    texts = [r["text"] for r in got if r["kind"] == "log"]
    assert texts == [f"web {i}" for i in range(5)]
    assert [r["source"] for r in got if r["kind"] == "metric"] == [f"{sid}/__host__"]
    # A record arriving late, inside the overlap, comes once; nothing else again.
    late = T0 + timedelta(seconds=9)
    fake.arrive(late, log("web", late, 99, "late"))
    fake.arrive(T0 + timedelta(seconds=12), log("web", T0 + timedelta(seconds=12), 100, "new"))
    got.clear()
    entry = store.get(sid)
    assert entry is not None
    store.update(
        sid, **await poll_once(client, sid, entry, {"web"}, ingest, T0 + timedelta(seconds=15))
    )
    assert [r["text"] for r in got] == ["late", "new"]
    # After a restart, from what was kept on disk: nothing again.
    got.clear()
    again = LogSumpStore(tmp_path / "logsump").get(sid)
    assert again is not None
    await poll_once(client, sid, again, {"web"}, ingest, T0 + timedelta(seconds=16))
    assert got == []


async def test_nothing_followed_brings_nothing_and_a_down_log_sump_raises(
    fake: FakeLogSump,
) -> None:
    sid = "logsump:prod@logs.lab:8080"
    fake.arrive(T0, metric(None, T0, 1, 50.0))
    fake.arrive(T0, log("web", T0, 2, "x"))
    entry = {"docker_host": "prod", "since": T0.isoformat(), "seen": []}
    got: list[Any] = []

    async def ingest(record: dict[str, Any]) -> None:
        got.append(record)

    client = client_for(fake)(URL, KEY)
    await poll_once(client, sid, entry, set(), ingest, T0 + timedelta(seconds=5))
    assert got == []
    fake.down = True
    with pytest.raises(LogSumpError, match="unreachable"):
        await poll_once(client, sid, entry, {"web"}, ingest, T0 + timedelta(seconds=5))


# -- br-STREAM-000010: the key stays on the Sump -----------------------------


async def test_a_stream_is_made_from_its_catalog_and_its_key_kept_owner_only(
    fake: FakeLogSump, tmp_path: Path
) -> None:
    store = LogSumpStore(tmp_path / "logsump")
    kind = LogSumpStreamKind(lambda: store, client_for(fake), now=lambda: T0)
    for body, why in [
        ({"url": "ftp://x", "api_key": KEY, "docker_host": "prod"}, "http"),
        ({"url": URL, "api_key": " ", "docker_host": "prod"}, "API key"),
        ({"url": URL, "api_key": KEY, "docker_host": "a/b"}, "Docker host"),
    ]:
        with pytest.raises(StreamError, match=why):
            await kind.create(body)
    with pytest.raises(StreamRefused, match="refused the API key") as refused:
        await kind.create({"url": URL, "api_key": "wrong", "docker_host": "prod"})
    assert refused.value.status == 502 and "wrong" not in str(refused.value)
    with pytest.raises(StreamRefused, match="may not read staging"):
        await kind.create({"url": URL, "api_key": KEY, "docker_host": "staging"})
    stream = await kind.create({"url": URL + "/", "api_key": KEY, "docker_host": "prod"})
    assert stream == StreamDef(
        "logsump:prod@logs.lab:8080", "logsump", host="prod", name="prod (log-sump logs.lab:8080)"
    )
    assert kind.describe(stream) == {"server": URL}
    # Kept owner-only, in an owner-only folder; a second add never replaces it.
    if sys.platform != "win32":  # POSIX file modes; the Sump runs on Linux
        assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
        assert stat.S_IMODE(store.path.parent.stat().st_mode) == 0o700
    fake.keys["other"] = ["prod"]
    await kind.create({"url": URL, "api_key": "other", "docker_host": "prod"})
    assert (store.get(stream.id) or {})["api_key"] == KEY
    targets = await kind.targets(stream)
    assert [t["name"] for t in targets["containers"]] == ["db"]
    kind.removed(stream)
    assert store.get(stream.id) is None


# -- through the real Sump ---------------------------------------------------


def _line(key: ed25519.Ed25519PrivateKey) -> str:
    return (
        key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )


async def test_a_log_sump_stream_in_the_sump_never_shows_its_key(
    fake: FakeLogSump, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": []
    )
    monkeypatch.setattr("sump_plugin_logsump.plugin.LogSumpClient", client_for(fake))
    plugin = SumpPluginLogSump({"SUMP_DATA_DIR": str(tmp_path)})
    plugin.kind = LogSumpStreamKind(plugin.store, client_for(fake), now=lambda: T0)
    manager = PluginManager(disable_autoload=True)
    manager.register(plugin, name="logsump")
    redis = fakeredis.aioredis.FakeRedis()
    app = create_app(
        redis_client=redis,
        plugin_manager=manager,
        env={"SUMP_DATA_DIR": str(tmp_path)},
        start_ingest=False,
    )
    key = ed25519.Ed25519PrivateKey.generate()
    app.state.users.set_owner("alice", _line(key))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as http:
            got = await http.post("/session/challenge", json={"user": "alice"})
            challenge = got.json()["challenge"]
            done = await http.post(
                "/session/login",
                json={
                    "user": "alice",
                    "challenge": challenge,
                    "signature": sign(key, challenge.encode(), LOGIN_NAMESPACE),
                },
            )
            auth = {"Authorization": f"Bearer {done.json()['token']}"}
            hosts = await http.post(
                "/plugins/logsump/catalog", json={"url": URL, "api_key": KEY}, headers=auth
            )
            assert hosts.json() == {
                "hosts": [{"id": "prod", "host": "ssh://prod", "enabled": True}]
            }
            made = await http.post(
                "/streams",
                json={"kind": "logsump", "url": URL, "api_key": KEY, "docker_host": "prod"},
                headers=auth,
            )
            assert made.status_code == 201, made.text
            sid = made.json()["id"]
            listed = await http.get("/streams", headers=auth)
            assert KEY not in listed.text and KEY not in made.text
            assert listed.json()["streams"][0]["server"] == URL
            await http.put(f"/streams/{sid}/followed", json={"containers": ["web"]}, headers=auth)
            at = T0 + timedelta(seconds=2)
            fake.arrive(at, log("web", at, 1, "GET /api 200"))
            await plugin.poll(app.state.adapter.ingest, now=T0 + timedelta(seconds=5))
            params = {
                "source": f"{sid}/web",
                "from": T0.isoformat(),
                "to": (T0 + timedelta(minutes=1)).isoformat(),
            }
            rows = (await http.get("/records/logs", params=params, headers=auth)).json()["rows"]
            assert [r["text"] for r in rows] == ["GET /api 200"]
    assert KEY not in json.dumps([dict(a) for a in fake.asked])
