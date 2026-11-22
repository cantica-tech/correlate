"""The events plugin in a real Sump app (REQ-000044-sJpO9KMY): discovered
through `sump.plugins`, its routes behind the session guard, an event owned
by the logged-in user."""

from __future__ import annotations

import fakeredis.aioredis
import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from sump_plugin_events.plugin import plugin

from correlate_sump.app import create_app
from correlate_sump.sshsig import LOGIN_NAMESPACE, public_key_of, sign

SPEC = {
    "name": "busy",
    "stream": "self",
    "conditions": [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 50}],
}


async def test_events_are_made_through_the_sump_by_a_logged_in_user(tmp_path, monkeypatch) -> None:
    monkeypatch.setitem(plugin.env, "SUMP_DATA_DIR", str(tmp_path))
    app = create_app(
        redis_client=fakeredis.aioredis.FakeRedis(),
        env={"SUMP_DATA_DIR": str(tmp_path)},
        start_ingest=False,
    )
    key = ed25519.Ed25519PrivateKey.generate()
    app.state.users.set_owner("alice", public_key_of(key).line())
    transport = httpx.ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://sump") as http,
    ):
        # No session, no events.
        assert (await http.get("/events")).status_code == 401
        challenge = (await http.post("/session/challenge", json={"user": "alice"})).json()
        signature = sign(key, challenge["challenge"].encode(), LOGIN_NAMESPACE)
        login = await http.post(
            "/session/login",
            json={"user": "alice", "challenge": challenge["challenge"], "signature": signature},
        )
        token = login.json()["token"]
        auth = {"Authorization": f"Bearer {token}"}
        made = await http.post("/events", json=SPEC, headers=auth)
        assert made.status_code == 201, made.text
        assert made.json()["owner"] == "alice"
        listed = (await http.get("/events", headers=auth)).json()["events"]
        assert [e["id"] for e in listed] == [made.json()["id"]]
        plugins = (await http.get("/plugins", headers=auth)).json()
        assert "events" in str(plugins)


@pytest.fixture(autouse=True)
def _fresh_plugin_store():
    """The plugin is one object for the process: its store is put back after."""
    before = plugin.store
    yield
    plugin.store = before
