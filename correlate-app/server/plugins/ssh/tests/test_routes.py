"""REQ-000025-sJpO9KMY Requirements 1 and 2: the data streams' routes; and
that they need a session, as every Sump route but `/health` and the login."""

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sump_plugin_ssh.collect import Collection
from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.plugin import SumpPluginSSH
from sump_plugin_ssh.streams import Followed

from correlate_sump.transport import ExecResult, Transport


class Docker:
    def __init__(self, *, swarm: bool = False, fail: str = "") -> None:
        self.swarm = swarm
        self.fail = fail

    async def run(self, args: Sequence[str]) -> ExecResult:
        if self.fail:
            return ExecResult(255, "", self.fail)
        if args[:2] == ["docker", "ps"]:
            rows = [{"ID": "0123456789ab", "Names": "web", "Image": "nginx:alpine", "Labels": ""}]
            return ExecResult(0, "\n".join(json.dumps(r) for r in rows), "")
        if args[:2] == ["docker", "info"]:
            return ExecResult(0, "true\n" if self.swarm else "false\n", "")
        if args[:3] == ["docker", "service", "ls"]:
            return ExecResult(0, json.dumps({"Name": "api", "Replicas": "2/2"}) + "\n", "")
        return ExecResult(0, "29.0\n", "")


class FakeCollection:
    def __init__(self) -> None:
        self.applied: list[tuple[str, Followed]] = []

    def apply(self, stream_id: str, followed: Followed) -> None:
        self.applied.append((stream_id, followed))


@pytest.fixture
def setup(tmp_path: Path, monkeypatch):
    plugin = SumpPluginSSH({"SUMP_DATA_DIR": str(tmp_path)})
    docker: dict[str, Any] = {"self": Docker(), "ssh": Docker()}
    plugin.self_source = DockerHostDataSource("self", cast(Transport, docker["self"]))
    monkeypatch.setattr(plugin, "ssh_transport", lambda _stream: docker["ssh"])
    monkeypatch.setattr(
        plugin,
        "transport_for",
        lambda sid: (
            docker["self"] if sid == "self" else docker["ssh"] if plugin.store().get(sid) else None
        ),
    )
    plugin.collection = cast(Collection, FakeCollection())
    app = FastAPI()
    plugin.contribute_routes(app)
    return plugin, docker, TestClient(app)


def test_lists_self_then_the_ssh_streams(setup) -> None:
    plugin, _docker, client = setup
    assert client.get("/streams").json() == {
        "streams": [
            {
                "id": "self",
                "kind": "self",
                "label": "This Sump's host",
                "user": None,
                "host": None,
                "port": None,
            }
        ]
    }
    added = client.post("/streams", json={"target": "ops@lab", "port": 2222})
    assert added.status_code == 201
    assert added.json()["id"] == "ssh:ops@lab:2222"
    assert [s["id"] for s in client.get("/streams").json()["streams"]] == [
        "self",
        "ssh:ops@lab:2222",
    ]


def test_refuses_a_bad_target_and_a_host_docker_does_not_answer_on(setup) -> None:
    _plugin, docker, client = setup
    assert client.post("/streams", json={"target": "lab; reboot", "port": 22}).status_code == 422
    docker["ssh"].fail = "ssh connect failed: Authentication failed."
    refused = client.post("/streams", json={"target": "ops@lab", "port": 22})
    assert refused.status_code == 502
    assert "Authentication failed" in refused.json()["detail"]
    assert [s["id"] for s in client.get("/streams").json()["streams"]] == ["self"]


def test_lists_targets_with_services_only_on_a_swarm_manager(setup) -> None:
    plugin, docker, client = setup
    body = client.get("/streams/self/targets").json()
    assert body == {
        "containers": [{"id": "0123456789ab", "name": "web", "image": "nginx:alpine"}],
        "services": None,
        "followed": {"containers": [], "services": []},
    }
    docker["self"].swarm = True
    assert client.get("/streams/self/targets").json()["services"] == [
        {"name": "api", "replicas": "2/2"}
    ]
    assert client.get("/streams/ssh:nobody@gone:22/targets").status_code == 404


def test_sets_exactly_the_followed_set_and_collection_follows(setup) -> None:
    plugin, _docker, client = setup
    put = client.put("/streams/self/followed", json={"containers": ["web", "db"], "services": []})
    assert put.json() == {"containers": ["db", "web"], "services": []}
    client.put("/streams/self/followed", json={"containers": ["db"], "services": ["api"]})
    assert plugin.store().followed("self") == Followed(["db"], ["api"])
    assert plugin.collection.applied[-1] == ("self", Followed(["db"], ["api"]))
    assert client.put("/streams/self/followed", json={"containers": ["a; b"]}).status_code == 422
    assert client.put("/streams/ssh:nobody@gone:22/followed", json={}).status_code == 404


async def test_the_sump_keeps_the_routes_behind_its_session(tmp_path: Path, monkeypatch) -> None:
    from importlib.metadata import entry_points

    import fakeredis.aioredis
    from sump_plugin_ssh import plugin as module

    from correlate_sump.app import create_app

    monkeypatch.setenv("SUMP_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(module.plugin, "_identity", None)
    monkeypatch.setattr(module.plugin, "_store", None)
    eps = [ep for ep in entry_points(group="sump.plugins") if ep.name == "ssh"]
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": eps
    )
    app = create_app(
        redis_client=fakeredis.aioredis.FakeRedis(),
        env={"SUMP_DATA_DIR": str(tmp_path)},
        start_ingest=False,
    )
    with TestClient(app) as client:
        for method, path in [
            ("GET", "/streams"),
            ("POST", "/streams"),
            ("PUT", "/streams/self/followed"),
        ]:
            assert client.request(method, path).status_code == 401, path
