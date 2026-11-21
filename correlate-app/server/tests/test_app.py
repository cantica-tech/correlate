"""The Sump app (REQ-000004-sJpO9KMY Requirement 4): `/health`, `/records`
(br-RECORD-000003-sJpO9KMY), the ingest adapter's lifecycle, plugin routes,
and the startup refusal of an invalid stream cap (br-RECORD-000004-sJpO9KMY)."""

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import httpx
import pytest

from correlate_sump import __version__
from correlate_sump.app import create_app
from correlate_sump.plugins import PluginManager, hookimpl

T0 = datetime(2026, 11, 21, 10, 0, tzinfo=UTC)


@asynccontextmanager
async def running(app):
    """The app with its lifespan started, and an HTTP client for it."""
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
            yield client


@pytest.fixture
def redis_client():
    return fakeredis.aioredis.FakeRedis()


def make_app(redis_client, **kwargs):
    kwargs.setdefault("env", {})
    kwargs.setdefault("start_ingest", False)
    return create_app(redis_client=redis_client, **kwargs)


async def test_health_reports_version_and_redis(redis_client) -> None:
    async with running(make_app(redis_client)) as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__, "redis": True}


async def test_health_reports_redis_down() -> None:
    class DownRedis(fakeredis.aioredis.FakeRedis):
        async def ping(self, **kwargs):
            raise ConnectionError("no redis")

    async with running(make_app(DownRedis())) as client:
        response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["redis"] is False


async def test_records_endpoint_returns_a_range(redis_client) -> None:
    app = make_app(redis_client)
    for s, msg in ((1, "a"), (2, "b"), (30, "late")):
        ts = (T0 + timedelta(seconds=s)).isoformat()
        raw = {"kind": "log", "source": "h1", "ts": ts, "message": msg}
        await app.state.adapter.ingest(json.dumps(raw).encode())
    params = {
        "source": "h1",
        "kind": "log",
        "from": T0.isoformat(),
        "to": (T0 + timedelta(seconds=9)).isoformat(),
    }
    async with running(app) as client:
        response = await client.get("/records", params=params)
    assert response.status_code == 200
    body = response.json()
    assert [r["message"] for r in body["records"]] == ["a", "b"]
    assert body["next_log_cursor"] is None


@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({"kind": "container"}, "kind must be one of"),
        (
            {"from": "2026-11-21T10:00:05+00:00", "to": "2026-11-21T10:00:00+00:00"},
            "from must not be after to",
        ),
        ({"limit": "5000"}, "limit must be between"),
        ({"log_cursor": "x"}, "invalid cursor"),
    ],
)
async def test_invalid_queries_get_422_with_the_reason(redis_client, params, detail) -> None:
    async with running(make_app(redis_client)) as client:
        response = await client.get("/records", params={"source": "h1", **params})
    assert response.status_code == 422
    assert detail in response.json()["detail"]


async def test_records_needs_a_source(redis_client) -> None:
    async with running(make_app(redis_client)) as client:
        response = await client.get("/records")
    assert response.status_code == 422


def test_invalid_stream_cap_stops_startup(redis_client) -> None:
    with pytest.raises(ValueError, match="SUMP_RECORD_MAXLEN"):
        create_app(redis_client=redis_client, env={"SUMP_RECORD_MAXLEN": "zero"})


def test_stream_cap_reaches_the_adapter(redis_client) -> None:
    app = create_app(redis_client=redis_client, env={"SUMP_RECORD_MAXLEN": "42"})
    assert app.state.adapter.maxlen == 42


class RoutePlugin:
    @hookimpl
    def contribute_routes(self, app) -> None:
        @app.get("/plugin/hello")
        async def hello() -> dict[str, str]:
            return {"hello": "plugin"}


async def test_plugin_routes_are_added_at_startup(redis_client) -> None:
    manager = PluginManager()
    manager.register(RoutePlugin(), name="route-plugin")
    async with running(make_app(redis_client, plugin_manager=manager)) as client:
        response = await client.get("/plugin/hello")
    assert response.json() == {"hello": "plugin"}


class ConflictingPlugin:
    @hookimpl
    def contribute_routes(self, app) -> None:
        @app.get("/health")
        async def mine() -> dict[str, str]:
            return {}


async def test_conflicting_plugin_route_stops_startup(redis_client) -> None:
    manager = PluginManager()
    manager.register(ConflictingPlugin(), name="conflicting")
    app = make_app(redis_client, plugin_manager=manager)
    with pytest.raises(
        ValueError, match="route GET /health registered by both 'sump' and 'conflicting'"
    ):
        async with app.router.lifespan_context(app):
            pass


async def test_ingest_adapter_runs_with_the_app(redis_client) -> None:
    probe = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = probe.sockets[0].getsockname()[1]
    probe.close()
    await probe.wait_closed()
    app = create_app(redis_client=redis_client, env={"SUMP_INGEST_PORT": str(port)})
    ts = T0.isoformat()
    async with running(app) as client:
        _, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(
            json.dumps({"kind": "log", "source": "h9", "ts": ts, "message": "tcp"}).encode() + b"\n"
        )
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        for _ in range(50):
            body = (
                await client.get("/records", params={"source": "h9", "from": ts, "to": ts})
            ).json()
            if body["records"]:
                break
            await asyncio.sleep(0.02)
    assert [r["message"] for r in body["records"]] == ["tcp"]
    with pytest.raises(OSError):  # the adapter stopped with the app
        await asyncio.open_connection("127.0.0.1", port)


# --- br-PLUGIN-000002 and br-PLUGIN-000003 through the app ---------------------------


class InfoPlugin:
    @hookimpl
    def sump_plugin_info(self) -> dict:
        return {"name": "info", "version": "2.0"}


async def test_plugins_endpoint_lists_plugins(redis_client) -> None:
    manager = PluginManager()
    manager.register(InfoPlugin(), name="info")
    async with running(make_app(redis_client, plugin_manager=manager)) as client:
        response = await client.get("/plugins")
    assert response.status_code == 200
    assert response.json() == {
        "plugins": [
            {
                "name": "info",
                "state": "loaded",
                "info": {"name": "info", "version": "2.0"},
                "error": None,
            }
        ]
    }


class _EP:
    def __init__(self, name: str) -> None:
        self.name = name
        self.loaded = False

    def load(self) -> object:
        self.loaded = True
        return InfoPlugin()


@pytest.mark.parametrize(
    ("env", "states"),
    [
        ({}, {"a": "loaded", "b": "loaded"}),
        ({"SUMP_DISABLED_PLUGINS": " a , ,"}, {"a": "disabled", "b": "loaded"}),
        ({"SUMP_DISABLE_PLUGIN_AUTOLOAD": "true"}, {"a": "disabled", "b": "disabled"}),
        ({"SUMP_DISABLE_PLUGIN_AUTOLOAD": "0"}, {"a": "loaded", "b": "loaded"}),
    ],
)
async def test_plugin_settings_reach_discovery(monkeypatch, redis_client, env, states) -> None:
    eps = [_EP("a"), _EP("b")]
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": eps
    )
    app = create_app(redis_client=redis_client, env=env, start_ingest=False)
    async with running(app) as client:
        body = (await client.get("/plugins")).json()
    assert {p["name"]: p["state"] for p in body["plugins"]} == states
    assert {ep.name: ep.loaded for ep in eps} == {
        name: state == "loaded" for name, state in states.items()
    }
