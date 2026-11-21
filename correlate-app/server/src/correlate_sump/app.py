"""The Sump's FastAPI app (REQ-000004-sJpO9KMY Requirement 4).

Serves `GET /health` and `GET /records` (br-RECORD-000003-sJpO9KMY), runs the
ingest adapter Fluent Bit forwards records to (br-RECORD-000001-sJpO9KMY), and
loads `sump.plugins` entry points, letting them add routes. No authentication
yet: per-user session tokens come with roadmap Items 11 and 12, and until then
the Sump listens on 127.0.0.1 only (br-SUMP-000009-sJpO9KMY).

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
from fastapi import FastAPI, HTTPException, Query

from correlate_sump import __version__
from correlate_sump.ingest import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    IngestAdapter,
    maxlen_from_env,
    run_ingest_server,
)
from correlate_sump.otel import SumpMetrics
from correlate_sump.plugins import PluginManager, validate_plugin_routes
from correlate_sump.records import DEFAULT_LIMIT, QueryError, query_records

logger = logging.getLogger(__name__)

#: Where Redis is, inside the Sump's container by default.
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"


def create_app(
    redis_client: redis.Redis | None = None,
    plugin_manager: PluginManager | None = None,
    env: Mapping[str, str] | None = None,
    start_ingest: bool = True,
) -> FastAPI:
    """Build the Sump app.

    Settings come from `env` (default: the process environment): `REDIS_URL`,
    `SUMP_RECORD_MAXLEN`, and `SUMP_INGEST_HOST`/`SUMP_INGEST_PORT` for the
    ingest adapter. An invalid `SUMP_RECORD_MAXLEN` raises `ValueError` here,
    so the Sump refuses to start (br-RECORD-000004-sJpO9KMY). Tests pass their
    own Redis client and `start_ingest=False`.
    """
    env = os.environ if env is None else env
    maxlen = maxlen_from_env(env)
    redis_client = redis_client or redis.Redis.from_url(env.get("REDIS_URL", DEFAULT_REDIS_URL))
    plugin_manager = plugin_manager or PluginManager()
    adapter = IngestAdapter(redis_client, maxlen=maxlen, metrics=SumpMetrics())
    plugin_manager.ingest_adapter = adapter
    ingest_host = env.get("SUMP_INGEST_HOST", DEFAULT_HOST)
    ingest_port = int(env.get("SUMP_INGEST_PORT", DEFAULT_PORT))

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        # Discover plugins first, then let them add routes, then refuse conflicts.
        loaded = await plugin_manager.discover()
        plugin_manager.hook.contribute_routes(app=app)
        validate_plugin_routes(app)
        logger.info("plugins loaded: %s", ", ".join(loaded) or "none")
        if plugin_manager.background_task_factories:
            # Running them safely needs per-plugin fault isolation (roadmap Item 7).
            logger.warning(
                "plugin background tasks not started yet: %s",
                ", ".join(plugin_manager.background_task_factories),
            )
        if not start_ingest:
            yield
            return
        server = await run_ingest_server(adapter, host=ingest_host, port=ingest_port)
        async with server:
            yield
        server.close()
        await server.wait_closed()

    app = FastAPI(title="correlate-sump", version=__version__, lifespan=lifespan)
    app.state.plugin_manager = plugin_manager
    app.state.adapter = adapter

    @app.get("/health")
    async def health() -> dict[str, Any]:
        """The Sump's version and whether Redis answers."""
        try:
            redis_up = bool(await redis_client.ping())
        except Exception:  # any failure to reach Redis means "down", not an error page
            redis_up = False
        return {"status": "ok", "version": __version__, "redis": redis_up}

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

    return app
