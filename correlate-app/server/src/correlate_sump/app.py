"""The Sump's FastAPI app (REQ-000004-sJpO9KMY Requirement 4).

Serves `GET /health`, `GET /records` (br-RECORD-000003-sJpO9KMY) and
`GET /plugins` (br-PLUGIN-000003-sJpO9KMY), runs the ingest adapter Fluent Bit
forwards records to (br-RECORD-000001-sJpO9KMY), and loads `sump.plugins`
entry points, letting them add routes; `SUMP_DISABLED_PLUGINS` and
`SUMP_DISABLE_PLUGIN_AUTOLOAD` turn plugins off (br-PLUGIN-000002-sJpO9KMY).
Every route but `GET /health` and the login needs a session token
(`SessionGuard`, br-CONN-000004-sJpO9KMY): a user logs in by signing a
challenge with an SSH key (`POST /session/challenge`, `POST /session/login`,
br-CONN-000007-sJpO9KMY), and `POST /session/logout` revokes the token. The
owner manages users' keys under `/users`. The Sump
also listens on 127.0.0.1 only (br-SUMP-000009-sJpO9KMY).

Written fresh rather than ported: correlator's `app.py` also carried
federation, mesh, promotion, exports and a static-token auth. One fix over it:
correlator collected plugin routes when the app was built but discovered
plugins only at startup, so an installed plugin's routes never appeared; here
discovery comes first.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Any

import redis.asyncio as redis
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from pydantic import BaseModel
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from correlate_sump import __version__
from correlate_sump.buckets import query_buckets
from correlate_sump.ingest import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    IngestAdapter,
    maxlen_from_env,
    run_ingest_server,
)
from correlate_sump.logs import find_row, log_density, log_page
from correlate_sump.otel import SumpMetrics
from correlate_sump.plugins import PluginManager
from correlate_sump.records import DEFAULT_LIMIT, QueryError, query_records
from correlate_sump.runtime import PluginRuntime, health_interval_from_env
from correlate_sump.sessions import (
    CHALLENGE_SECONDS,
    CorruptSessionStore,
    Session,
    SessionStore,
    session_limits_from_env,
)
from correlate_sump.sshsig import LOGIN_NAMESPACE, SignatureError, verify
from correlate_sump.users import (
    CorruptKeyStore,
    UserError,
    UserStore,
    check_user_name,
    data_dir_from_env,
)

logger = logging.getLogger(__name__)

#: Where Redis is, inside the Sump's container by default.
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"

#: Values of `SUMP_DISABLE_PLUGIN_AUTOLOAD` that turn autoloading off.
TRUE_VALUES = frozenset({"1", "true", "yes", "on"})


def plugin_settings(env: Mapping[str, str]) -> tuple[list[str], bool]:
    """The plugins to turn off (`SUMP_DISABLED_PLUGINS`, comma-separated) and
    whether to load none (`SUMP_DISABLE_PLUGIN_AUTOLOAD`)."""
    disabled = [name.strip() for name in env.get("SUMP_DISABLED_PLUGINS", "").split(",")]
    autoload_off = env.get("SUMP_DISABLE_PLUGIN_AUTOLOAD", "").strip().lower() in TRUE_VALUES
    return [name for name in disabled if name], autoload_off


#: Requests answered without a session token: the Sump's status, and the login.
OPEN_ROUTES = frozenset(
    {
        ("GET", "/health"),
        ("HEAD", "/health"),
        ("POST", "/session/challenge"),
        ("POST", "/session/login"),
    }
)

#: The one answer to every failed login, whatever the reason (logged instead).
LOGIN_REFUSED = HTTPException(status_code=401, detail="login refused")


class ChallengeRequest(BaseModel):
    """Who wants to log in."""

    user: str


class LoginRequest(BaseModel):
    """A challenge and its `SSHSIG` signature."""

    user: str
    challenge: str
    signature: str


class KeyRequest(BaseModel):
    """A public key, as an `authorized_keys` line."""

    public_key: str


def bearer_token(scope: Scope) -> str | None:
    """The token of the request's `Authorization: Bearer` header, if any."""
    for name, value in scope.get("headers", []):
        if name == b"authorization":
            scheme, _, token = value.decode("latin-1").partition(" ")
            if scheme.lower() == "bearer" and token.strip():
                return token.strip()
    return None


class SessionGuard:
    """Refuses every request but `OPEN_ROUTES` without a valid session token
    (br-CONN-000004-sJpO9KMY): 401 when missing or not valid, 503 when the
    session store is corrupt (the record is left as it is). The session goes
    to the request's state for the route. Plain ASGI, so streams are untouched.
    """

    def __init__(self, app: ASGIApp, sessions: SessionStore) -> None:
        self.app = app
        self.sessions = sessions

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or (scope["method"], scope["path"]) in OPEN_ROUTES:
            await self.app(scope, receive, send)
            return
        token = bearer_token(scope)
        session = None
        if token is not None:
            try:
                session = await self.sessions.check(token)
            except CorruptSessionStore as exc:
                logger.error("request refused: corrupt session store: %s", exc)
                response = JSONResponse({"detail": "the session store is corrupt"}, 503)
                await response(scope, receive, send)
                return
        if session is None:
            logger.info(
                "request refused: %s token for %s %s",
                "missing" if token is None else "invalid",
                scope["method"],
                scope["path"],
            )
            response = JSONResponse(
                {"detail": "a valid session token is needed"},
                401,
                headers={"WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return
        scope.setdefault("state", {})["session"] = session
        await self.app(scope, receive, send)


def create_app(
    redis_client: redis.Redis | None = None,
    plugin_manager: PluginManager | None = None,
    env: Mapping[str, str] | None = None,
    start_ingest: bool = True,
) -> FastAPI:
    """Build the Sump app.

    Settings come from `env` (default: the process environment): `REDIS_URL`,
    `SUMP_RECORD_MAXLEN`, `SUMP_INGEST_HOST`/`SUMP_INGEST_PORT` for the ingest
    adapter, `SUMP_PLUGIN_HEALTH_INTERVAL` for plugin health checks, and
    `SUMP_DISABLED_PLUGINS`/`SUMP_DISABLE_PLUGIN_AUTOLOAD` when no
    `plugin_manager` is given, `SUMP_SESSION_IDLE_SECONDS` and
    `SUMP_SESSION_MAX_SECONDS` for session tokens, and `SUMP_DATA_DIR` for
    users and their keys.

    An invalid interval (br-PLUGIN-000008-sJpO9KMY), `SUMP_RECORD_MAXLEN`
    (br-RECORD-000004-sJpO9KMY) or session limit raises `ValueError` here, so
    the Sump refuses to start. Tests pass their own Redis client and
    `start_ingest=False`.
    """
    env = os.environ if env is None else env
    maxlen = maxlen_from_env(env)
    health_interval = health_interval_from_env(env)
    idle_seconds, max_seconds = session_limits_from_env(env)
    redis_client = redis_client or redis.Redis.from_url(env.get("REDIS_URL", DEFAULT_REDIS_URL))
    if plugin_manager is None:
        disabled, autoload_off = plugin_settings(env)
        plugin_manager = PluginManager(disabled=disabled, disable_autoload=autoload_off)
    adapter = IngestAdapter(redis_client, maxlen=maxlen, metrics=SumpMetrics())
    plugin_manager.ingest_adapter = adapter
    ingest_host = env.get("SUMP_INGEST_HOST", DEFAULT_HOST)
    ingest_port = int(env.get("SUMP_INGEST_PORT", DEFAULT_PORT))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        # Discover plugins first, then let each add its routes; a clash with a
        # core route or another plugin's stops startup (br-PLUGIN-000004).
        loaded = await plugin_manager.discover()
        plugin_manager.contribute_routes(app)
        logger.info("plugins loaded: %s", ", ".join(loaded) or "none")
        # Each background task in its own supervisor, plus the health loop
        # (br-PLUGIN-000006 to 000008); stopped before ingestion stops.
        runtime = PluginRuntime(plugin_manager, interval=health_interval)
        plugin_manager.runtime = runtime
        runtime.start()
        try:
            if not start_ingest:
                yield
                return
            server = await run_ingest_server(adapter, host=ingest_host, port=ingest_port)
            async with server:
                try:
                    yield
                finally:
                    await runtime.stop()
            server.close()
            await server.wait_closed()
        finally:
            await runtime.stop()

    sessions = SessionStore(redis_client, idle_seconds, max_seconds)
    users = UserStore(data_dir_from_env(env))
    app = FastAPI(title="correlate-sump", version=__version__, lifespan=lifespan)
    app.state.plugin_manager = plugin_manager
    app.state.adapter = adapter
    app.state.sessions = sessions
    app.state.users = users
    app.add_middleware(SessionGuard, sessions=sessions)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        """The Sump's version and whether Redis answers."""
        try:
            redis_up = bool(await redis_client.ping())
        except Exception:  # any failure to reach Redis means "down", not an error page
            redis_up = False
        return {"status": "ok", "version": __version__, "redis": redis_up}

    @app.post("/session/challenge")
    async def challenge(body: ChallengeRequest) -> dict[str, Any]:
        """A single-use challenge to sign (br-CONN-000007); given to any name,
        so it says nothing about which users exist."""
        try:
            check_user_name(body.user)
        except UserError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "challenge": await sessions.new_challenge(body.user),
            "namespace": LOGIN_NAMESPACE,
            "expires_in": CHALLENGE_SECONDS,
        }

    @app.post("/session/login")
    async def login(body: LoginRequest) -> dict[str, Any]:
        """A session token for a challenge signed with one of the user's keys."""
        issued_to = await sessions.take_challenge(body.challenge)
        if issued_to is None or issued_to != body.user:
            logger.info("login refused for %s: unknown, used or expired challenge", body.user)
            raise LOGIN_REFUSED
        try:
            keys = users.keys(body.user)
        except CorruptKeyStore as exc:
            logger.error("login refused for %s: corrupt key store: %s", body.user, exc)
            raise HTTPException(status_code=503, detail="the key store is corrupt") from exc
        try:
            key = verify(body.signature, body.challenge.encode(), LOGIN_NAMESPACE, keys)
        except SignatureError as exc:
            logger.info("login refused for %s: %s", body.user, exc)
            raise LOGIN_REFUSED from exc
        token = await sessions.issue(body.user)
        logger.info("login: %s with %s", body.user, key.fingerprint)
        return {"token": token, "user": body.user, "owner": body.user == _owner()}

    def _owner() -> str | None:
        try:
            return users.owner()
        except CorruptKeyStore as exc:
            logger.error("corrupt key store: %s", exc)
            raise HTTPException(status_code=503, detail="the key store is corrupt") from exc

    def owner_only(request: Request) -> Session:
        """The caller's session, if the caller owns this Sump; 403 otherwise."""
        session: Session = request.state.session
        if session.user != _owner():
            raise HTTPException(status_code=403, detail="only the Sump's owner can do this")
        return session

    def _key_info(key) -> dict[str, str]:
        return {"type": key.type, "fingerprint": key.fingerprint, "comment": key.comment}

    @app.get("/users")
    async def list_users(owner: Session = Depends(owner_only)) -> dict[str, Any]:
        """Every user and their keys' fingerprints (owner only)."""
        try:
            return {
                "owner": users.owner(),
                "users": [
                    {"user": u, "keys": [_key_info(k) for k in users.keys(u)]}
                    for u in users.users()
                ],
            }
        except CorruptKeyStore as exc:
            raise HTTPException(status_code=503, detail="the key store is corrupt") from exc

    @app.post("/users/{user}/keys", status_code=201)
    async def add_user_key(
        user: str, body: KeyRequest, owner: Session = Depends(owner_only)
    ) -> dict[str, str]:
        """Authorize a public key for `user` (owner only)."""
        try:
            key = users.add_key(user, body.public_key)
        except UserError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except CorruptKeyStore as exc:
            raise HTTPException(status_code=503, detail="the key store is corrupt") from exc
        logger.info("%s authorized %s for %s", owner.user, key.fingerprint, user)
        return _key_info(key)

    @app.delete("/users/{user}/keys/{fingerprint:path}", status_code=204)
    async def remove_user_key(
        user: str, fingerprint: str, owner: Session = Depends(owner_only)
    ) -> Response:
        """Remove one of `user`'s keys (owner only); the owner's last key stays."""
        try:
            users.remove_key(user, fingerprint)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except UserError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except CorruptKeyStore as exc:
            raise HTTPException(status_code=503, detail="the key store is corrupt") from exc
        logger.info("%s removed %s from %s", owner.user, fingerprint, user)
        return Response(status_code=204)

    @app.post("/session/logout", status_code=204)
    async def logout(request: Request) -> Response:
        """Revoke the caller's session token (br-CONN-000004-sJpO9KMY)."""
        token = bearer_token(request.scope)
        if token is not None:
            await sessions.revoke(token)
        return Response(status_code=204)

    @app.get("/plugins")
    async def plugins() -> dict[str, Any]:
        """Every discovered plugin, what became of it (br-PLUGIN-000003) and its
        runtime state, and the data sources of sleeping plugins (br-PLUGIN-000009)."""
        runtime = plugin_manager.runtime
        return {
            "plugins": plugin_manager.report(),
            "unavailable_data_sources": runtime.unavailable_data_sources() if runtime else [],
        }

    @app.get("/records")
    async def records(
        source: str,
        kind: str = "both",
        start: Annotated[datetime | None, Query(alias="from")] = None,
        end: Annotated[datetime | None, Query(alias="to")] = None,
        container_id: str | None = None,
        level: str | None = None,
        q: str | None = None,
        log_cursor: str | None = None,
        metric_cursor: str | None = None,
        limit: int = DEFAULT_LIMIT,
    ) -> dict[str, Any]:
        """`source`'s records between `from` and `to` (br-RECORD-000003-sJpO9KMY)."""
        try:
            return await query_records(
                redis_client,
                source,
                kind=kind,
                start=start,
                end=end,
                container_id=container_id,
                level=level,
                q=q,
                log_cursor=log_cursor,
                metric_cursor=metric_cursor,
                limit=limit,
            )
        except QueryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/records/buckets")
    async def record_buckets(
        source: str,
        start: Annotated[datetime, Query(alias="from")],
        end: Annotated[datetime, Query(alias="to")],
        field: Annotated[list[str], Query()],
        buckets: int = 500,
        over: str | None = None,
        mode: str = "max",
    ) -> dict[str, Any]:
        """`source`'s metric values as at most `buckets` maxima, for a chart
        (REQ-000028-sJpO9KMY): `field`s summed, as a percentage of `over`, or
        a counter's rate in `rate` mode."""
        try:
            # `field` repeated, or comma-separated (the app's bridge sends one value).
            fields = [name for item in field for name in item.split(",") if name]
            return await query_buckets(
                redis_client,
                source,
                fields=fields,
                start=start,
                end=end,
                buckets=buckets,
                over=over,
                mode=mode,
            )
        except QueryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/records/logs")
    async def record_logs(
        source: str,
        start: Annotated[datetime, Query(alias="from")],
        end: Annotated[datetime, Query(alias="to")],
        offset: int = 0,
        limit: int = 200,
        order: str = "newest",
    ) -> dict[str, Any]:
        """`source`'s log rows by index, newest or oldest first, and their total
        (REQ-000029-sJpO9KMY), for a log panel's pages."""
        try:
            return await log_page(
                redis_client, source, start=start, end=end, offset=offset, limit=limit, order=order
            )
        except QueryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/records/logs/find")
    async def record_logs_find(
        source: str,
        start: Annotated[datetime, Query(alias="from")],
        end: Annotated[datetime, Query(alias="to")],
        q: str,
        from_index: int = -1,
        direction: str = "next",
        order: str = "newest",
    ) -> dict[str, Any]:
        """The next or previous row whose text contains `q` (REQ-000029-sJpO9KMY)."""
        try:
            return await find_row(
                redis_client,
                source,
                start=start,
                end=end,
                q=q,
                from_index=from_index,
                direction=direction,
                order=order,
            )
        except QueryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/records/density")
    async def record_density(
        source: str,
        start: Annotated[datetime, Query(alias="from")],
        end: Annotated[datetime, Query(alias="to")],
        buckets: int = 500,
    ) -> dict[str, Any]:
        """How many log rows of `source` fall in each bucket (REQ-000029-sJpO9KMY)."""
        try:
            return await log_density(redis_client, source, start=start, end=end, buckets=buckets)
        except QueryError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    return app
