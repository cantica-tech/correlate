"""br-PLUGIN-000010-sJpO9KMY (REQ-000056-sJpO9KMY, the Kibana/Elasticsearch
design spike): a plugin whose data stream is not a Docker host (an
Elasticsearch-backed system, its targets index patterns) registers a stream
kind and gets every stream rule from the core, in the real Sump: added and
listed, its targets, its followed set collected, paused, private, its
records queried and hidden, an event's view of it, and its removal. No
change to the core is made for it.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from sump_plugin_events.plugin import hidden_for

from correlate_sump.app import create_app
from correlate_sump.ingest import stream_key
from correlate_sump.plugins import PluginManager, hookimpl
from correlate_sump.sshsig import LOGIN_NAMESPACE, sign
from correlate_sump.streams import Followed, StreamDef, StreamError, StreamRegistry

T0 = datetime(2026, 11, 23, 9, 0, tzinfo=UTC)


class ElasticKind:
    """A stub Elasticsearch stream kind: a cluster named by the app, its
    index patterns as its targets. Collection is recorded, not run."""

    kinds: tuple[str, ...] = ("elasticsearch",)

    def __init__(self) -> None:
        self.applied: dict[str, Followed] = {}
        self.forgotten: list[str] = []

    def detected(self) -> list[StreamDef]:
        return []

    async def create(self, body: dict[str, Any]) -> StreamDef:
        url, name = str(body.get("url", "")), str(body.get("name", ""))
        if not url.startswith(("http://", "https://")) or not name.isidentifier():
            raise StreamError("an Elasticsearch stream needs a URL and a name")
        host = url.split("://", 1)[1].split("/", 1)[0]
        return StreamDef(f"es:{name}", "elasticsearch", host=host, name=f"Elasticsearch {name}")

    async def targets(self, stream: StreamDef) -> dict[str, Any]:
        patterns = ["logs-app", "metrics-app"]
        return {
            "containers": [{"id": p, "name": p, "image": "index pattern"} for p in patterns],
            "services": None,
        }

    def check_follow(self, stream: StreamDef) -> None:
        return None

    def apply(self, stream: StreamDef, followed: Followed) -> None:
        self.applied[stream.id] = followed

    def removed(self, stream: StreamDef) -> None:
        self.forgotten.append(stream.id)

    def describe(self, stream: StreamDef) -> dict[str, Any]:
        return {"cluster": stream.host}


class ElasticPlugin:
    def __init__(self) -> None:
        self.kind = ElasticKind()

    @hookimpl
    def sump_plugin_info(self) -> dict[str, Any]:
        return {"name": "elastic-stub", "version": "0.0.0"}

    @hookimpl
    def register_stream_kind(self, manager: Any) -> None:
        manager.streams.add_kind(self.kind)


def _line(key: ed25519.Ed25519PrivateKey) -> str:
    return (
        key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )


@pytest.fixture
async def sump(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": []
    )
    stub = ElasticPlugin()
    manager = PluginManager(disable_autoload=True)
    manager.register(stub, name="elastic-stub")
    redis = fakeredis.aioredis.FakeRedis()
    app = create_app(
        redis_client=redis,
        plugin_manager=manager,
        env={"SUMP_DATA_DIR": str(tmp_path)},
        start_ingest=False,
    )
    keys = {u: ed25519.Ed25519PrivateKey.generate() for u in ("alice", "carol")}
    app.state.users.set_owner("alice", _line(keys["alice"]))
    app.state.users.add_key("carol", _line(keys["carol"]))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as http:

            async def as_user(user: str) -> dict[str, str]:
                got = await http.post("/session/challenge", json={"user": user})
                challenge = got.json()["challenge"]
                signature = sign(keys[user], challenge.encode(), LOGIN_NAMESPACE)
                done = await http.post(
                    "/session/login",
                    json={"user": user, "challenge": challenge, "signature": signature},
                )
                return {"Authorization": f"Bearer {done.json()['token']}"}

            yield http, as_user, stub.kind, redis, manager


async def test_a_non_container_stream_gets_every_stream_rule_from_the_core(sump) -> None:
    http, as_user, kind, redis, manager = sump
    alice, carol = await as_user("alice"), await as_user("carol")
    # Added by its kind, listed with its kind and its own fields.
    bad = await http.post("/streams", json={"kind": "elasticsearch", "url": "x"}, headers=alice)
    assert bad.status_code == 422
    made = await http.post(
        "/streams",
        json={"kind": "elasticsearch", "url": "https://es.lab:9200", "name": "prod"},
        headers=alice,
    )
    assert made.status_code == 201, made.text
    listed = (await http.get("/streams", headers=alice)).json()["streams"]
    assert [(s["id"], s["kind"], s["label"], s["cluster"], s["created_by"]) for s in listed] == [
        ("es:prod", "elasticsearch", "Elasticsearch prod", "es.lab:9200", "alice")
    ]
    # Its targets are index patterns, followed and collected by its kind.
    targets = (await http.get("/streams/es:prod/targets", headers=alice)).json()
    assert [t["name"] for t in targets["containers"]] == ["logs-app", "metrics-app"]
    put = await http.put(
        "/streams/es:prod/followed", json={"containers": ["logs-app"]}, headers=alice
    )
    assert put.json() == {"containers": ["logs-app"], "services": []}
    assert kind.applied["es:prod"] == Followed(["logs-app"], [])
    await http.put("/streams/es:prod/paused", json={"paused": True}, headers=alice)
    assert kind.applied["es:prod"] == Followed()
    # Its records are queried like any other, and hidden when private.
    record = {"ts": (T0 + timedelta(minutes=1)).isoformat(), "kind": "log"}
    record |= {"source": "es:prod/logs-app", "text": "GET /search 200"}
    await redis.xadd(stream_key("es:prod/logs-app", "log"), {"json": json.dumps(record)})
    params = {
        "source": "es:prod/logs-app",
        "from": T0.isoformat(),
        "to": (T0 + timedelta(hours=1)).isoformat(),
    }
    page = await http.get("/records/logs", params=params, headers=carol)
    assert page.json()["total"] == 1
    # Carol may see it, not change it (br-STREAM-000008).
    refused = await http.put("/streams/es:prod/followed", json={"containers": []}, headers=carol)
    assert refused.status_code == 403
    await http.put("/streams/es:prod/private", json={"private": True}, headers=alice)
    assert (await http.get("/streams", headers=carol)).json()["streams"] == []
    assert (await http.get("/records/logs", params=params, headers=carol)).json()["total"] == 0
    assert (await http.get("/records/logs", params=params, headers=alice)).json()["total"] == 1
    gone = await http.get("/streams/es:prod/targets", headers=carol)
    assert gone.status_code == 404
    # An event of carol's sees nothing of it; alice's does.
    hidden = hidden_for(manager)
    assert (hidden("es:prod/logs-app", "carol"), hidden("es:prod/logs-app", "alice")) == (
        True,
        False,
    )
    # Removed by the core, its kind told.
    assert (await http.delete("/streams/es:prod", headers=alice)).status_code == 204
    assert kind.forgotten == ["es:prod"]
    assert (await http.get("/streams", headers=alice)).json()["streams"] == []


async def test_an_unknown_kind_and_a_taken_kind_are_refused(sump, tmp_path) -> None:
    http, as_user, kind, _redis, _manager = sump
    alice = await as_user("alice")
    made = await http.post("/streams", json={"kind": "kibana", "url": "x"}, headers=alice)
    assert made.status_code == 422
    assert "no data stream kind 'kibana'" in made.json()["detail"]
    registry = StreamRegistry(tmp_path / "other.json", lambda: None)
    registry.add_kind(kind)
    with pytest.raises(ValueError, match="already registered"):
        registry.add_kind(kind)
