"""Session tokens (br-CONN-000004-sJpO9KMY, REQ-000010-sJpO9KMY Requirements 1
to 3): the store, the guard on every route but `/health`, and logout."""

import hashlib

import fakeredis.aioredis
import httpx
import pytest

from correlate_sump.app import create_app
from correlate_sump.plugins import PluginManager, hookimpl
from correlate_sump.sessions import (
    DEFAULT_IDLE_SECONDS,
    DEFAULT_MAX_SECONDS,
    KEY_PREFIX,
    CorruptSessionStore,
    SessionStore,
    session_limits_from_env,
    token_key,
)
from correlate_sump.sse import ServerSentEvent, event_stream


class Clock:
    """A clock the test moves by hand."""

    def __init__(self, now: float = 1_800_000_000) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def redis_client():
    return fakeredis.aioredis.FakeRedis()


# -- the store ---------------------------------------------------------------


def test_defaults_are_12_hours_and_7_days() -> None:
    assert (DEFAULT_IDLE_SECONDS, DEFAULT_MAX_SECONDS) == (12 * 3600, 7 * 24 * 3600)


async def test_issue_stores_only_a_hash(redis_client) -> None:
    store = SessionStore(redis_client)
    token = await store.issue("alice")
    keys = [k.decode() for k in await redis_client.keys("*")]
    assert keys == [KEY_PREFIX + hashlib.sha256(token.encode()).hexdigest()]
    dump = b"".join(v for v in (await redis_client.hgetall(keys[0])).values())
    assert token.encode() not in dump
    assert len(token) >= 43  # 256 bits, base64url
    assert 0 < await redis_client.ttl(keys[0]) <= DEFAULT_IDLE_SECONDS


async def test_check_returns_the_session_and_renews_it(redis_client) -> None:
    clock = Clock()
    store = SessionStore(redis_client, idle_seconds=100, max_seconds=1000, clock=clock)
    token = await store.issue("alice")
    await redis_client.expire(token_key(token), 5)
    session = await store.check(token)
    assert session is not None and session.user == "alice"
    assert await redis_client.ttl(token_key(token)) == 100


async def test_renewal_never_passes_the_end(redis_client) -> None:
    clock = Clock()
    store = SessionStore(redis_client, idle_seconds=100, max_seconds=1000, clock=clock)
    token = await store.issue("alice")
    clock.now += 950
    assert await store.check(token) is not None
    assert await redis_client.ttl(token_key(token)) == 50
    clock.now += 50
    assert await store.check(token) is None
    assert await redis_client.exists(token_key(token)) == 0


async def test_unknown_and_revoked_tokens_are_refused(redis_client) -> None:
    store = SessionStore(redis_client)
    token = await store.issue("alice")
    assert await store.check("not-a-token") is None
    await store.revoke(token)
    assert await store.check(token) is None


@pytest.mark.parametrize(
    "record",
    [
        {"user": "alice", "issued_at": "1"},
        {"user": "alice", "issued_at": "soon", "ends_at": "later"},
        {"user": "", "issued_at": "1", "ends_at": "2"},
        {"user": "alice", "issued_at": "5", "ends_at": "1"},
    ],
)
async def test_a_corrupt_record_is_refused_and_left_alone(redis_client, record) -> None:
    store = SessionStore(redis_client)
    await redis_client.hset(token_key("t"), mapping=record)
    with pytest.raises(CorruptSessionStore):
        await store.check("t")
    assert await redis_client.hgetall(token_key("t")) == {
        k.encode(): v.encode() for k, v in record.items()
    }


async def test_a_record_of_the_wrong_type_is_refused(redis_client) -> None:
    await redis_client.set(token_key("t"), "garbage")
    with pytest.raises(CorruptSessionStore):
        await SessionStore(redis_client).check("t")
    assert await redis_client.get(token_key("t")) == b"garbage"


@pytest.mark.parametrize("name", ["SUMP_SESSION_IDLE_SECONDS", "SUMP_SESSION_MAX_SECONDS"])
@pytest.mark.parametrize("value", ["0", "-5", "soon", "1.5"])
def test_invalid_limits_stop_the_sump(name, value) -> None:
    with pytest.raises(ValueError, match=name):
        session_limits_from_env({name: value})
    with pytest.raises(ValueError, match=name):
        create_app(redis_client=fakeredis.aioredis.FakeRedis(), env={name: value})


def test_limits_from_env() -> None:
    env = {"SUMP_SESSION_IDLE_SECONDS": "60", "SUMP_SESSION_MAX_SECONDS": "600"}
    assert session_limits_from_env(env) == (60, 600)


# -- the guard ---------------------------------------------------------------


class RoutePlugin:
    @hookimpl
    def contribute_routes(self, app) -> None:
        @app.get("/plugin/hello")
        async def hello() -> dict[str, str]:
            return {"hello": "plugin"}


async def _one_event():
    yield ServerSentEvent({"n": 1})


def make_app(redis_client):
    manager = PluginManager()
    manager.register(RoutePlugin(), name="route-plugin")
    app = create_app(redis_client=redis_client, plugin_manager=manager, env={}, start_ingest=False)
    app.get("/live")(lambda: event_stream(_one_event()))
    return app


async def call(app, method: str, path: str, token: str | None = None) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
        return await client.request(method, path, headers=headers)


PROTECTED = [
    ("GET", "/records?source=x"),
    ("GET", "/plugins"),
    ("GET", "/plugin/hello"),
    ("GET", "/live"),
    ("GET", "/openapi.json"),
    ("POST", "/session/logout"),
]


async def test_health_needs_no_token(redis_client) -> None:
    app = make_app(redis_client)
    async with app.router.lifespan_context(app):
        assert (await call(app, "GET", "/health")).status_code == 200


@pytest.mark.parametrize(("method", "path"), PROTECTED)
async def test_every_other_route_needs_a_token(redis_client, method, path) -> None:
    app = make_app(redis_client)
    async with app.router.lifespan_context(app):
        for token in (None, "made-up"):
            response = await call(app, method, path, token)
            assert response.status_code == 401, (path, token)
            assert response.headers["www-authenticate"] == "Bearer"
        good = await app.state.sessions.issue("alice")
        assert (await call(app, method, path, good)).status_code in (200, 204)


async def test_a_stream_works_with_a_token(redis_client) -> None:
    app = make_app(redis_client)
    async with app.router.lifespan_context(app):
        token = await app.state.sessions.issue("alice")
        response = await call(app, "GET", "/live", token)
    assert response.content == b'data: {"n": 1}\n\n'


async def test_logout_revokes_the_token(redis_client) -> None:
    app = make_app(redis_client)
    async with app.router.lifespan_context(app):
        token = await app.state.sessions.issue("alice")
        other = await app.state.sessions.issue("bob")
        assert (await call(app, "POST", "/session/logout", token)).status_code == 204
        assert (await call(app, "GET", "/plugins", token)).status_code == 401
        assert (await call(app, "GET", "/plugins", other)).status_code == 200


async def test_a_corrupt_store_is_answered_503(redis_client) -> None:
    app = make_app(redis_client)
    async with app.router.lifespan_context(app):
        await redis_client.set(token_key("broken"), "garbage")
        response = await call(app, "GET", "/plugins", "broken")
    assert response.status_code == 503
    assert response.json() == {"detail": "the session store is corrupt"}
    assert await redis_client.get(token_key("broken")) == b"garbage"
