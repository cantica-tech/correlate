"""The `sump.plugins` entry point of the log-sump plugin (REQ-000057-sJpO9KMY).

Registers the `logsump` stream kind (`kind.py`, br-PLUGIN-000010), the relay
as its background task (every 5 s, each followed and unpaused stream polled,
br-STREAM-000011), and `POST /plugins/logsump/catalog`, which lists a
log-sump's Docker hosts for the Streams dialog before a stream is added.
URLs and keys are kept in the Sump's data folder (`logsump/`), owner-only
(br-STREAM-000010).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel

from correlate_sump.plugins import hookimpl
from correlate_sump.streams import StreamError
from correlate_sump.users import data_dir_from_env
from sump_plugin_logsump import __version__
from sump_plugin_logsump.client import LogSumpClient, LogSumpError
from sump_plugin_logsump.kind import KIND, LogSumpStreamKind, check_server
from sump_plugin_logsump.relay import poll_once
from sump_plugin_logsump.secrets import LogSumpStore

logger = logging.getLogger(__name__)

PLUGIN_NAME = "logsump"
#: How often each followed stream is polled.
POLL_S = 5.0


class Server(BaseModel):
    url: str
    api_key: str


class SumpPluginLogSump:
    """The plugin: its stream kind, its relay and its catalog route."""

    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = env
        self._store: LogSumpStore | None = None
        self.kind = LogSumpStreamKind(self.store)
        self.registry: Any = None

    def _folder(self) -> Path:
        env = self._env if self._env is not None else dict(os.environ)
        return data_dir_from_env(env) / "logsump"

    def store(self) -> LogSumpStore:
        if self._store is None:
            self._store = LogSumpStore(self._folder())
        return self._store

    async def poll(self, ingest: Any, now: datetime | None = None) -> None:
        """One round: each followed, unpaused log-sump stream read once."""
        if self.registry is None:
            return
        streams = self.registry.store()
        for stream in self.registry.streams():
            if stream.kind != KIND or streams.paused(stream.id):
                continue
            followed = set(streams.followed(stream.id).containers)
            entry, client = self.store().get(stream.id), self.kind.client_for(stream.id)
            if not followed or entry is None or client is None:
                continue
            try:
                place = await poll_once(
                    client,
                    stream.id,
                    entry,
                    followed,
                    lambda record: ingest(json.dumps(record).encode("utf-8")),
                    now or datetime.now(UTC),
                )
            except LogSumpError as exc:
                logger.warning("logsump: %s not read: %s", stream.id, exc)
                continue
            self.store().update(stream.id, **place)

    @hookimpl
    def sump_plugin_info(self) -> dict[str, Any]:
        return {"name": PLUGIN_NAME, "version": __version__}

    @hookimpl
    def register_stream_kind(self, manager: Any) -> None:
        registry = getattr(manager, "streams", None)
        if registry is not None:
            registry.add_kind(self.kind)
            self.registry = registry

    @hookimpl
    def register_background_task(self, manager: Any) -> None:
        async def relay() -> None:
            adapter = manager.ingest_adapter
            if adapter is None:
                logger.warning("logsump: no record store; nothing will be collected")
                await asyncio.Event().wait()
            while True:
                await self.poll(adapter.ingest)
                await asyncio.sleep(POLL_S)

        manager.add_background_task("relay", relay)

    @hookimpl
    def contribute_routes(self, app: Any) -> None:
        @app.post("/plugins/logsump/catalog")
        async def catalog(body: Server) -> dict[str, Any]:
            """A log-sump's Docker hosts this key may read, to add one as a
            stream; the key is used for this call only and kept nowhere."""
            try:
                url, key = check_server(body.url, body.api_key)
                hosts = await LogSumpClient(url, key).catalog()
            except StreamError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            except LogSumpError as exc:
                raise HTTPException(status_code=502, detail=str(exc)) from None
            return {
                "hosts": [
                    {
                        "id": str(h.get("id")),
                        "host": str(h.get("host", "")),
                        "enabled": bool(h.get("enabled", True)),
                    }
                    for h in hosts
                ]
            }


#: The instance the `sump.plugins` entry point names.
plugin = SumpPluginLogSump()
