"""A firing's artifacts on the Sump (REQ-000045-sJpO9KMY, br-EVENT-000005 and
br-EVENT-000006-sJpO9KMY): snapshots and recordings made where the data is,
named by the Sump, kept 24 h or longer when safe, swept; recordings pending
across restarts, complete or failed."""

from __future__ import annotations

import io
import json
import time
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from fastapi import FastAPI, Request
from sump_plugin_events.archive import manifest_hash
from sump_plugin_events.artifacts import MAX_KEEP_MS, TTL_MS, ArtifactRefused, Artifacts
from sump_plugin_events.engine import FIRINGS, Engine, EventStore
from sump_plugin_events.model import InvalidEvent
from sump_plugin_events.routes import add_event_routes

from correlate_sump.ingest import stream_key

CPU = {"type": "metric", "metric": "cpu", "op": ">", "threshold": 50}
MIN = 60_000


class Sump:
    """A fake Sump: Redis, a clock, an artifact folder, the engine and routes."""

    def __init__(self, folder: Path, maxlen: int | None = None) -> None:
        self.redis = fakeredis.aioredis.FakeRedis()
        self.now = float(int(time.time() * 1000))
        self.folder = folder
        self.store = EventStore(self.redis)
        self.artifacts = Artifacts(self.redis, folder, maxlen)
        self.engine = Engine(self.redis, self.store, lambda: self.now, self.artifacts)
        app = FastAPI()

        @app.middleware("http")
        async def session(request: Request, call_next: Any) -> Any:
            request.state.session = SimpleNamespace(user=request.headers.get("x-user", "ann"))
            return await call_next(request)

        add_event_routes(
            app,
            lambda: self.store,
            lambda: "owner",
            lambda: int(self.now),
            artifacts=lambda: self.artifacts,
        )
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://s")

    async def call(self, method: str, path: str, user: str = "ann", **kw: Any) -> httpx.Response:
        return await self.http.request(method, path, headers={"x-user": user}, **kw)

    async def metric(self, source: str, cpu: float, ago_ms: float = 0) -> None:
        ts = datetime.fromtimestamp((self.now - ago_ms) / 1000, UTC).isoformat()
        record = {"kind": "metric", "source": source, "ts": ts, "cpu_percent": cpu}
        await self.redis.xadd(stream_key(source, "metric"), {"json": json.dumps(record)})

    async def log(self, source: str, text: str, ago_ms: float = 0) -> None:
        ts = datetime.fromtimestamp((self.now - ago_ms) / 1000, UTC).isoformat()
        record = {"kind": "log", "source": source, "ts": ts, "text": text}
        await self.redis.xadd(stream_key(source, "log"), {"json": json.dumps(record)})

    async def event(self, action: dict[str, Any] | None, **spec: Any) -> Any:
        base = {"name": "busy", "stream": "self", "conditions": [CPU], "action": action}
        return await self.store.create({**base, **spec}, "ann", int(self.now))

    async def firings(self) -> list[dict[str, str]]:
        entries: Any = await self.redis.xrange(FIRINGS)
        return [{k.decode(): v.decode() for k, v in f.items()} for _, f in entries]


@pytest.fixture
def sump(tmp_path: Path) -> Sump:
    return Sump(tmp_path / "artifacts")


def read(path: Path) -> tuple[dict[str, Any], zipfile.ZipFile]:
    archive = zipfile.ZipFile(io.BytesIO(path.read_bytes()))
    return json.loads(archive.read("manifest.json")), archive


@pytest.mark.parametrize(
    ("action", "why"),
    [
        ({"kind": "email"}, "unknown action"),
        ({"kind": "snapshot", "minutes": 0}, "more than 0"),
        ({"kind": "snapshot", "minutes": 61}, "at most 60"),
        ({"kind": "recording", "minutes": 121}, "at most 120"),
        ({"kind": "recording", "minutes": "ten"}, "must be a number"),
    ],
)
async def test_an_action_the_sump_could_not_run_is_refused(
    sump: Sump, action: dict[str, Any], why: str
) -> None:
    with pytest.raises(InvalidEvent, match=why):
        await sump.event(action)


async def test_actions_default_to_cttcs_minutes(sump: Sump) -> None:
    snap = await sump.event({"kind": "snapshot"})
    rec = await sump.event({"kind": "recording"})
    assert (snap.action.minutes, rec.action.minutes) == (5.0, 10.0)
    assert (await sump.event(None)).action.kind == "none"


async def test_a_snapshot_holds_the_minutes_before_the_firing(sump: Sump) -> None:
    event = await sump.event({"kind": "snapshot", "minutes": 5}, host=True)
    await sump.metric("self/web", 10, ago_ms=10 * MIN)  # before the window
    await sump.metric("self/web", 20, ago_ms=2 * MIN)
    await sump.log("self/web", "slow request", ago_ms=1 * MIN)
    await sump.metric("self/__host__", 30, ago_ms=1 * MIN)
    await sump.metric("self/web", 99)
    [firing] = await sump.engine.tick()
    record = await sump.artifacts.get(firing["artifact"])
    assert record is not None
    assert (record["kind"], record["status"], record["event"]) == ("snapshot", "complete", event.id)
    assert (record["from"], record["to"]) == (int(sump.now) - 5 * MIN, int(sump.now))
    assert record["expires_at"] == int(sump.now) + TTL_MS
    manifest, archive = read(sump.folder / f"{record['id']}.recording")
    assert manifest["version"] == 3
    assert manifest["integrity_sha256"] == manifest_hash(manifest)
    files = {s["name"]: s["file"] for s in manifest["segments"][0]["sources"]}
    web = json.loads(archive.read(files["stats@self"]))["series"]["web"]
    assert [row[1] for row in web] == [20, 99]
    assert archive.read(files["web"]).decode().count("slow request") == 1
    assert "host@self" in files


async def test_a_recording_waits_survives_a_restart_and_completes(sump: Sump) -> None:
    await sump.event({"kind": "recording", "minutes": 10})
    await sump.metric("self/web", 99)
    [first] = await sump.engine.tick()
    record = await sump.artifacts.get(first["artifact"])
    assert record is not None and record["status"] == "pending"
    # Fired again while it records: noted, no second recording.
    await sump.metric("self/web", 10)
    await sump.engine.tick()
    await sump.metric("self/web", 99)
    [second] = await sump.engine.tick()
    assert (second["artifact"], second["note"]) == (
        "",
        "a recording of this event is still running",
    )
    # The Sump restarts: a new engine and store on the same Redis and folder.
    sump.artifacts = Artifacts(sump.redis, sump.folder)
    sump.engine = Engine(sump.redis, sump.store, lambda: sump.now, sump.artifacts)
    sump.now += 10 * MIN
    await sump.metric("self/web", 42, ago_ms=MIN)
    await sump.engine.tick()
    done = await sump.artifacts.get(first["artifact"])
    assert done is not None and done["status"] == "complete"
    manifest, _ = read(sump.folder / f"{done['id']}.recording")
    assert manifest["segments"][0]["to"] == done["to"]


async def test_a_recording_whose_start_the_streams_dropped_fails(tmp_path: Path) -> None:
    sump = Sump(tmp_path / "artifacts", maxlen=3)
    await sump.event({"kind": "recording", "minutes": 1})
    await sump.metric("self/web", 99)
    [firing] = await sump.engine.tick()
    # The stream fills its cap with later records: the start is gone.
    sump.now += 2 * MIN
    for _ in range(3):
        await sump.metric("self/web", 1)
    await sump.redis.xtrim(stream_key("self/web", "metric"), maxlen=3, approximate=False)
    await sump.engine.tick()
    record = await sump.artifacts.get(firing["artifact"])
    assert record is not None
    assert record["status"] == "failed"
    assert "no longer hold the start" in record["reason"]
    assert not (sump.folder / f"{record['id']}.recording").exists()


async def test_artifact_names_are_the_sumps_and_never_leave_its_folder(sump: Sump) -> None:
    for bad in ("../../etc/passwd", "x.recording", "0123456789ABCDEF", ""):
        with pytest.raises(ArtifactRefused):
            sump.artifacts.path(bad)
    assert await sump.artifacts.get("../x") is None
    assert (await sump.call("GET", "/artifacts/..%2F..%2Fsecret")).status_code == 404


async def test_kept_artifacts_last_longer_and_the_sweep_removes_the_expired(sump: Sump) -> None:
    await sump.event({"kind": "snapshot"})
    await sump.metric("self/web", 99)
    [firing] = await sump.engine.tick()
    artifact = firing["artifact"]
    with pytest.raises(ArtifactRefused, match="at most 30 days"):
        await sump.artifacts.keep(artifact, MAX_KEEP_MS + 1, "ann", int(sump.now))
    with pytest.raises(ArtifactRefused, match="owner"):
        await sump.artifacts.keep(artifact, MIN, "bob", int(sump.now))
    kept = await sump.artifacts.keep(artifact, 3 * TTL_MS, "ann", int(sump.now))
    assert kept["safe"] is True
    assert await sump.artifacts.sweep(int(sump.now) + 2 * TTL_MS) == []
    assert await sump.artifacts.sweep(int(sump.now) + 3 * TTL_MS) == [artifact]
    assert not (sump.folder / f"{artifact}.recording").exists()
    assert await sump.artifacts.get(artifact) is None


async def test_the_routes_list_download_only_complete_and_keep(sump: Sump) -> None:
    event = await sump.event({"kind": "recording", "minutes": 1})
    await sump.metric("self/web", 99)
    [firing] = await sump.engine.tick()
    artifact = firing["artifact"]
    listed = (await sump.call("GET", f"/events/{event.id}/artifacts")).json()["artifacts"]
    assert [(a["id"], a["status"]) for a in listed] == [(artifact, "pending")]
    pending = await sump.call("GET", f"/artifacts/{artifact}")
    assert pending.status_code == 409
    assert "still being made" in pending.json()["detail"]
    sump.now += 2 * MIN
    await sump.engine.tick()
    got = await sump.call("GET", f"/artifacts/{artifact}")
    assert got.status_code == 200
    assert zipfile.ZipFile(io.BytesIO(got.content)).read("manifest.json")
    assert f"event-{artifact}.recording" in got.headers["content-disposition"]
    assert (await sump.call("GET", f"/artifacts/{artifact}", "bob")).status_code == 404
    assert (await sump.call("GET", f"/artifacts/{artifact}", "owner")).status_code == 200
    kept = await sump.call("POST", f"/artifacts/{artifact}/keep", json={"days": 7})
    assert kept.json()["safe"] is True
    assert (
        await sump.call("POST", f"/artifacts/{artifact}/keep", json={"days": 31})
    ).status_code == 422
