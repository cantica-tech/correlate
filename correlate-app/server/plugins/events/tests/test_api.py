"""The events' API (REQ-000044-sJpO9KMY, br-EVENT-000007-sJpO9KMY): each
event its creator's, the Sump's owner seeing all; checks as 422; every edit
based on a version, a stale one refused (409), never overwritten; the engine
never overwriting an edit either."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from fastapi import FastAPI, Request
from sump_plugin_events.engine import FIRINGS, Engine, EventStore, state_key
from sump_plugin_events.routes import add_event_routes

from correlate_sump.ingest import stream_key

CPU = {"type": "metric", "metric": "cpu", "op": ">", "threshold": 50}
SPEC = {"name": "busy", "stream": "self", "conditions": [CPU]}


class Sump:
    """The events' routes on a fake Sump: users by header, `owner` its owner."""

    def __init__(self) -> None:
        self.redis = fakeredis.aioredis.FakeRedis()
        self.store = EventStore(self.redis)
        self.now = time.time() * 1000
        app = FastAPI()

        @app.middleware("http")
        async def session(request: Request, call_next: Any) -> Any:
            request.state.session = SimpleNamespace(user=request.headers.get("x-user", "ann"))
            return await call_next(request)

        add_event_routes(app, lambda: self.store, lambda: "owner", lambda: int(self.now))
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://s")

    async def call(self, method: str, path: str, user: str = "ann", **kw: Any) -> httpx.Response:
        return await self.http.request(method, path, headers={"x-user": user}, **kw)

    async def made(self, user: str = "ann", **spec: Any) -> dict[str, Any]:
        reply = await self.call("POST", "/events", user, json={**SPEC, **spec})
        assert reply.status_code == 201, reply.text
        return reply.json()

    async def metric(self, source: str, cpu: float) -> None:
        ts = datetime.fromtimestamp(self.now / 1000, UTC).isoformat()
        record = {"kind": "metric", "source": source, "ts": ts, "cpu_percent": cpu}
        await self.redis.xadd(stream_key(source, "metric"), {"json": json.dumps(record)})

    def engine(self) -> Engine:
        return Engine(self.redis, self.store, now=lambda: self.now)


@pytest.fixture
def sump() -> Sump:
    return Sump()


async def test_an_event_is_its_creators_and_answered_whole(sump: Sump) -> None:
    event = await sump.made()
    assert (event["owner"], event["version"], event["status"]) == ("ann", 1, "armed")
    assert event["conditions"] == [{**CPU, "threshold": 50.0}]
    listed = (await sump.call("GET", "/events")).json()["events"]
    assert [e["id"] for e in listed] == [event["id"]]
    assert (await sump.call("GET", f"/events/{event['id']}")).json() == event


async def test_an_event_the_engine_could_not_evaluate_is_refused_as_422(sump: Sump) -> None:
    for bad in (
        {**SPEC, "conditions": [{**CPU, "threshold": "high"}]},
        {**SPEC, "conditions": [{"type": "log", "pattern": "[unclosed"}]},
    ):
        reply = await sump.call("POST", "/events", json=bad)
        assert reply.status_code == 422
    assert (
        "must be a number"
        in (
            await sump.call(
                "POST", "/events", json={**SPEC, "conditions": [{**CPU, "threshold": "high"}]}
            )
        ).json()["detail"]
    )
    assert (await sump.call("GET", "/events")).json() == {"events": []}


async def test_a_user_sees_only_their_own_and_the_owner_sees_all(sump: Sump) -> None:
    ann = await sump.made("ann")
    bob = await sump.made("bob", name="bob's")
    assert [e["id"] for e in (await sump.call("GET", "/events", "bob")).json()["events"]] == [
        bob["id"]
    ]
    assert (await sump.call("GET", f"/events/{ann['id']}", "bob")).status_code == 404
    seen = (await sump.call("GET", "/events", "owner")).json()["events"]
    assert sorted(e["id"] for e in seen) == sorted([ann["id"], bob["id"]])


async def test_the_owner_may_delete_anyones_but_edit_only_their_own(sump: Sump) -> None:
    ann = await sump.made("ann")
    edit = await sump.call("PUT", f"/events/{ann['id']}", "owner", json={"name": "x", "version": 1})
    assert edit.status_code == 403
    gone = await sump.call("DELETE", f"/events/{ann['id']}", "owner", params={"version": 1})
    assert gone.json() == {"ok": True}
    assert (await sump.call("GET", "/events", "ann")).json() == {"events": []}


async def test_another_users_event_cannot_be_edited_reset_or_deleted(sump: Sump) -> None:
    ann = await sump.made("ann")
    path = f"/events/{ann['id']}"
    assert (await sump.call("PUT", path, "bob", json={"version": 1})).status_code == 404
    assert (await sump.call("POST", f"{path}/reset", "bob")).status_code == 404
    assert (await sump.call("DELETE", path, "bob", params={"version": 1})).status_code == 404


async def test_a_stale_edit_is_refused_never_overwriting_a_newer_one(sump: Sump) -> None:
    event = await sump.made()
    path = f"/events/{event['id']}"
    first = await sump.call("PUT", path, json={"name": "first", "version": 1})
    assert first.json()["version"] == 2
    stale = await sump.call("PUT", path, json={"name": "second", "version": 1})
    assert stale.status_code == 409
    assert "version 2" in stale.json()["detail"]
    assert (await sump.call("GET", path)).json()["name"] == "first"
    assert (await sump.call("DELETE", path, params={"version": 1})).status_code == 409
    assert (await sump.call("DELETE", path, params={"version": 2})).json() == {"ok": True}


async def test_an_edit_resets_only_when_the_conditions_or_stream_change(sump: Sump) -> None:
    event = await sump.made()
    path = f"/events/{event['id']}"
    await sump.metric("self/web", 99)
    await sump.engine().tick()
    assert (await sump.call("GET", path)).json()["status"] == "triggered"
    renamed = (await sump.call("PUT", path, json={"name": "renamed", "version": 1})).json()
    assert (renamed["status"], renamed["trigger_count"]) == ("triggered", 1)
    changed = await sump.call(
        "PUT", path, json={"conditions": [{**CPU, "threshold": 90}], "version": 2}
    )
    assert (changed.json()["status"], changed.json()["armed"]) == ("armed", True)
    assert changed.json()["trigger_count"] == 1


async def test_the_engine_never_overwrites_an_edit_made_while_it_evaluated(sump: Sump) -> None:
    event = await sump.made()
    await sump.metric("self/web", 99)
    engine = sump.engine()
    seen = await sump.store.get(event["id"])
    assert seen is not None
    # An edit lands between the engine's read and its write.
    await sump.call("PUT", f"/events/{event['id']}", json={"name": "edited", "version": 1})
    assert await engine.evaluate(seen) is None
    assert await sump.redis.xrange(FIRINGS) == []
    after = (await sump.call("GET", f"/events/{event['id']}")).json()
    assert (after["name"], after["version"], after["status"]) == ("edited", 2, "armed")
    # The next tick sees the edit.
    assert len(await engine.tick()) == 1


async def test_a_reset_re_arms_and_a_deleted_events_firings_stay(sump: Sump) -> None:
    event = await sump.made()
    path = f"/events/{event['id']}"
    await sump.metric("self/web", 99)
    engine = sump.engine()
    await engine.tick()
    reset = (await sump.call("POST", f"{path}/reset")).json()
    assert (reset["status"], reset["armed"]) == ("armed", True)
    assert len(await engine.tick()) == 1
    await sump.call("DELETE", path, params={"version": 1})
    firings: Any = await sump.redis.xrange(FIRINGS)
    assert len(firings) == 2
    assert await sump.redis.get(state_key(event["id"])) is None


async def test_no_engine_yet_is_said(sump: Sump) -> None:
    app = FastAPI()
    add_event_routes(app, lambda: None, lambda: None)
    http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://s")

    @app.middleware("http")
    async def session(request: Request, call_next: Any) -> Any:
        request.state.session = SimpleNamespace(user="ann")
        return await call_next(request)

    assert (await http.get("/events")).status_code == 503
