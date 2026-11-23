"""The `sump.plugins` entry point (REQ-000043-sJpO9KMY).

Runs the event engine as the plugin's background task: one tick a second on
the Sump's own Redis (the ingest adapter's client). The Sump supervises the
task: a crash restarts it with backoff and never stops the Sump
(br-PLUGIN-000006-sJpO9KMY, roadmap Item 7's fault isolation). Contributes the
events' HTTP API (`routes.py`, REQ-000044-sJpO9KMY), its owner checks against
the Sump's owner.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from typing import Any

from correlate_sump.plugins import hookimpl
from correlate_sump.users import UserStore, data_dir_from_env
from sump_plugin_events import __version__
from sump_plugin_events.artifacts import Artifacts
from sump_plugin_events.engine import Engine, EventStore
from sump_plugin_events.routes import add_event_routes

logger = logging.getLogger(__name__)

PLUGIN_NAME = "events"
#: Seconds between two evaluations of every event.
TICK_SECONDS = 1.0


async def run(engine: Engine, every: float = TICK_SECONDS, ticks: int | None = None) -> None:
    """Tick `engine` every `every` seconds, forever (or `ticks` times, for tests)."""
    done = 0
    while ticks is None or done < ticks:
        fired = await engine.tick()
        for firing in fired:
            logger.info("event %s fired: %s", firing["event"], firing["detail"])
        done += 1
        await asyncio.sleep(every)


def hidden_for(manager: Any) -> Callable[[str, str], bool]:
    """Whether a source is hidden from a user, for events and their artifacts:
    the core's streams say (br-STREAM-000007, br-PLUGIN-000010), else
    whatever a plugin says; a failure hides nothing."""

    def hidden(source: str, user: str) -> bool:
        try:
            streams = getattr(manager, "streams", None)
            ruled = streams.source_hidden(source, user) if streams is not None else None
            if ruled is not None:
                return bool(ruled)
            return bool(manager.hook.source_hidden(source=source, user=user))
        except Exception:
            logger.exception("events: source_hidden(%s) failed", source)
            return False

    return hidden


class SumpPluginEvents:
    """The plugin: its hooks, and the Sump's Redis once it is given."""

    def __init__(self, env: dict[str, str] | None = None) -> None:
        self.env = env if env is not None else dict(os.environ)
        self.store: EventStore | None = None
        self.artifacts: Artifacts | None = None

    def sump_owner(self) -> str | None:
        """The Sump's owner, who sees every event."""
        return UserStore(data_dir_from_env(self.env)).owner()

    @hookimpl
    def sump_plugin_info(self) -> dict[str, Any]:
        return {"name": PLUGIN_NAME, "version": __version__}

    @hookimpl
    def register_background_task(self, manager: Any) -> None:
        adapter = manager.ingest_adapter

        hidden = hidden_for(manager)

        if adapter is not None:
            self.store = EventStore(adapter.redis)
            # Artifacts in the Sump's data folder, never named by a request.
            folder = data_dir_from_env(self.env) / "artifacts"
            self.artifacts = Artifacts(
                adapter.redis, folder, getattr(adapter, "maxlen", None), hidden=hidden
            )

        async def evaluate() -> None:
            if self.store is None:
                logger.warning("no ingest adapter: events are not evaluated")
                return
            await run(Engine(self.store.redis, self.store, artifacts=self.artifacts, hidden=hidden))

        manager.add_background_task("evaluation", evaluate)

    @hookimpl
    def contribute_routes(self, app: Any) -> None:
        add_event_routes(app, lambda: self.store, self.sump_owner, artifacts=lambda: self.artifacts)


plugin = SumpPluginEvents()
