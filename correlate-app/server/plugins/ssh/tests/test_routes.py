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


#: Who the requests come from: the tests switch users (the Sump's owner is alice).
CALLER: dict[str, str] = {"user": "alice"}


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
    CALLER["user"] = "alice"
    monkeypatch.setattr(plugin, "sump_owner", lambda: "alice")
    app = FastAPI()

    @app.middleware("http")
    async def session(request, call_next):
        # The Sump's guard puts the caller's session on the request.
        request.state.session = type("S", (), {"user": CALLER["user"]})()
        return await call_next(request)

    plugin.contribute_routes(app)
    return plugin, docker, TestClient(app)


def test_lists_self_then_the_ssh_streams(setup) -> None:
    plugin, _docker, client = setup
    assert client.get("/streams").json() == {
        "streams": [
            {
                "paused": False,
                "following": 0,
                "followed": {"containers": [], "services": []},
                "created_by": "alice",
                "private": False,
                "may_change": True,
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


def test_removes_a_stream_after_stopping_it_and_refuses_self(setup) -> None:
    plugin, _docker, client = setup
    client.post("/streams", json={"target": "ops@lab", "port": 22})
    client.put("/streams/ssh:ops@lab:22/followed", json={"containers": ["web"]})
    assert client.delete("/streams/ssh:ops@lab:22").status_code == 204
    assert plugin.collection.applied[-1] == ("ssh:ops@lab:22", Followed())
    assert plugin.store().get("ssh:ops@lab:22") is None
    assert client.delete("/streams/ssh:ops@lab:22").status_code == 404
    refused = client.delete("/streams/self")
    assert refused.status_code == 409
    assert "close it" in refused.json()["detail"]


def test_pauses_and_a_submit_resumes(setup) -> None:
    plugin, _docker, client = setup
    client.put("/streams/self/followed", json={"containers": ["web", "db"]})
    assert client.put("/streams/self/paused", json={"paused": True}).json() == {"paused": True}
    assert plugin.collection.applied[-1] == ("self", Followed())
    assert plugin.store().followed("self") == Followed(["db", "web"], [])
    listed = client.get("/streams").json()["streams"][0]
    assert (listed["paused"], listed["following"]) == (True, 2)
    assert listed["followed"] == {"containers": ["db", "web"], "services": []}
    client.put("/streams/self/followed", json={"containers": ["web"]})
    assert not plugin.store().paused("self")
    assert plugin.collection.applied[-1] == ("self", Followed(["web"], []))


def test_promotes_an_ssh_stream_for_the_owner_only(setup, monkeypatch) -> None:
    """br-FED-000001-sJpO9KMY: the owner promotes; the stream stops being
    collected here and its secondary is kept."""
    plugin, _docker, client = setup
    client.post("/streams", json={"target": "ops@lab", "port": 2222})
    sid = "ssh:ops@lab:2222"
    client.put(f"/streams/{sid}/followed", json={"containers": ["web"], "services": []})
    provisioned: list[dict] = []

    async def provision(shell, **kwargs) -> None:
        provisioned.append(kwargs)

    monkeypatch.setattr("sump_plugin_ssh.plugin.provision_secondary", provision)
    monkeypatch.setenv("SUMP_IMAGE", "ghcr.io/cantica/correlate-sump:1.2.3")
    owner: list[str | None] = [None]
    monkeypatch.setattr(plugin, "sump_owner", lambda: owner[0])

    app = FastAPI()

    @app.middleware("http")
    async def session(request, call_next):
        request.state.session = type("S", (), {"user": "alice"})()
        return await call_next(request)

    plugin.contribute_routes(app)
    client = TestClient(app)

    body = {"owner_key": "ssh-ed25519 AAAAowner alice@laptop"}
    assert client.post(f"/streams/{sid}/promote", json=body).status_code == 403
    owner[0] = "alice"
    assert client.post("/streams/ssh:nobody@gone:22/promote", json=body).status_code == 404
    assert client.post("/streams/self/promote", json=body).status_code == 409
    done = client.post(f"/streams/{sid}/promote", json=body)
    assert done.status_code == 200, done.text
    secondary = done.json()["secondary"]
    assert secondary["host"] == "lab" and secondary["owner"] == "alice"
    assert secondary["sump_port"] == 8775 and secondary["promoted_at"] > 0
    assert provisioned[0]["owner"] == "alice"
    assert provisioned[0]["followed"] == {"containers": ["web"], "services": []}
    assert provisioned[0]["image"] == "ghcr.io/cantica/correlate-sump:1.2.3"
    assert provisioned[0]["parent_key"].startswith("ssh-ed25519 ")
    assert plugin.collection.applied[-1] == (sid, Followed())
    assert plugin.store().secondary(sid) == secondary
    assert sid not in plugin.store().all_followed()
    assert client.post(f"/streams/{sid}/promote", json=body).status_code == 409
    # br-FED-000002: collected by its secondary, which is said on the stream.
    put = client.put(f"/streams/{sid}/followed", json={"containers": ["web"], "services": []})
    assert put.status_code == 409
    listed = {s["id"]: s for s in client.get("/streams").json()["streams"]}
    assert listed[sid]["secondary"] == secondary and "secondary" not in listed["self"]
    assert client.get("/streams/self/secondary").status_code == 404

    class Client:
        async def check(self) -> dict:
            return {"reachable": False, "error": "the secondary is unreachable: refused"}

    monkeypatch.setattr(plugin, "secondary_client", lambda _sid: Client())
    status = client.get(f"/streams/{sid}/secondary").json()
    assert status == {
        "secondary": secondary,
        "reachable": False,
        "error": "the secondary is unreachable: refused",
    }


def test_a_stream_records_who_added_it_and_whether_it_is_private(setup) -> None:
    """br-STREAM-000006-sJpO9KMY: the caller is its creator; private if asked."""
    plugin, _docker, client = setup
    CALLER["user"] = "bob"
    added = client.post("/streams", json={"target": "ops@lab", "port": 22, "private": True})
    assert added.status_code == 201
    assert (added.json()["created_by"], added.json()["private"]) == ("bob", True)
    assert plugin.store().creator("ssh:ops@lab:22") == "bob"
    # "self" and streams from before are the owner's.
    listed = {s["id"]: s for s in client.get("/streams").json()["streams"]}
    assert listed["self"]["created_by"] == "alice"


def test_a_private_stream_is_hidden_from_other_users(setup) -> None:
    """br-STREAM-000007-sJpO9KMY: for carol, bob's private stream does not exist."""
    plugin, _docker, client = setup
    CALLER["user"] = "bob"
    client.post("/streams", json={"target": "ops@lab", "port": 22, "private": True})
    sid = "ssh:ops@lab:22"
    CALLER["user"] = "carol"
    assert [s["id"] for s in client.get("/streams").json()["streams"]] == ["self"]
    for method, path, body in [
        ("GET", f"/streams/{sid}/targets", None),
        ("PUT", f"/streams/{sid}/followed", {"containers": ["web"]}),
        ("PUT", f"/streams/{sid}/paused", {"paused": True}),
        ("PUT", f"/streams/{sid}/private", {"private": False}),
        ("DELETE", f"/streams/{sid}", None),
        ("GET", f"/streams/{sid}/secondary", None),
    ]:
        answer = client.request(method, path, json=body)
        assert answer.status_code == 404, (method, path)
        assert answer.json()["detail"] == f"no data stream {sid}" or "not promoted" in str(
            answer.json()
        )
    assert client.post("/streams", json={"target": "ops@lab", "port": 22}).status_code == 409
    assert plugin.source_hidden(f"{sid}/web", "carol") is True
    assert plugin.source_hidden(f"{sid}/web", "bob") is False
    assert plugin.source_hidden(f"{sid}/web", "alice") is False
    assert plugin.source_hidden("ssh:nobody@gone:22/web", "carol") is None
    # The owner sees it; shared again, carol does too.
    CALLER["user"] = "alice"
    assert sid in [s["id"] for s in client.get("/streams").json()["streams"]]
    assert client.put(f"/streams/{sid}/private", json={"private": False}).status_code == 200
    CALLER["user"] = "carol"
    assert sid in [s["id"] for s in client.get("/streams").json()["streams"]]
    assert plugin.source_hidden(f"{sid}/web", "carol") is False


def test_only_its_creator_and_the_owner_change_a_stream(setup) -> None:
    """br-STREAM-000008-sJpO9KMY: carol sees and lists bob's shared stream,
    and changes nothing."""
    plugin, _docker, client = setup
    CALLER["user"] = "bob"
    client.post("/streams", json={"target": "ops@lab", "port": 22})
    sid = "ssh:ops@lab:22"
    CALLER["user"] = "carol"
    assert client.get(f"/streams/{sid}/targets").status_code == 200
    listed = {x["id"]: x for x in client.get("/streams").json()["streams"]}
    assert (listed[sid]["may_change"], listed["self"]["may_change"]) == (False, False)
    for method, path, body in [
        ("PUT", f"/streams/{sid}/followed", {"containers": ["web"]}),
        ("PUT", f"/streams/{sid}/paused", {"paused": True}),
        ("PUT", f"/streams/{sid}/private", {"private": True}),
        ("DELETE", f"/streams/{sid}", None),
        ("POST", f"/streams/{sid}/promote", {"owner_key": "ssh-ed25519 AAAA"}),
        ("PUT", "/streams/self/followed", {"containers": ["web"]}),
    ]:
        assert client.request(method, path, json=body).status_code == 403, (method, path)
    assert plugin.store().followed(sid).containers == []
    assert not plugin.store().paused(sid) and not plugin.store().private(sid)
    CALLER["user"] = "bob"
    assert client.put(f"/streams/{sid}/followed", json={"containers": ["web"]}).status_code == 200
    CALLER["user"] = "alice"
    assert client.put(f"/streams/{sid}/paused", json={"paused": True}).status_code == 200
    assert client.delete(f"/streams/{sid}").status_code == 204
