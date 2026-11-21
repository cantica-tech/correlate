"""The `sump.plugins` entry point (REQ-000024-sJpO9KMY).

Registers the `local` and `ssh` transports (`ssh` with the Sump's own key),
contributes `GET /plugins/ssh/public-key` and the data streams' routes
(`/streams`, REQ-000025-sJpO9KMY), runs collection as its background task
(resuming every saved followed set), and at start detects whether the
Sump's host runs Docker: through the host's Docker socket, mounted into the
Sump's container by the app's provisioning (decided in
FEAT-000025-sJpO9KMY). If it does, a "self" data source is registered, the
Sump's own container left out of its list; if not, none, and the Sump
starts all the same (br-PLUGIN-000008-sJpO9KMY). Ported from correlator's
`sump-plugin-ssh`.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from correlate_sump.datasource import DataSource
from correlate_sump.plugins import hookimpl
from correlate_sump.transport import Transport
from correlate_sump.users import data_dir_from_env
from sump_plugin_ssh import __version__
from sump_plugin_ssh.collect import Collection
from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.identity import SumpIdentity, ensure_identity
from sump_plugin_ssh.routes import add_removal_routes, add_stream_routes
from sump_plugin_ssh.streams import SELF_ID, Followed, StreamDef, StreamStore
from sump_plugin_ssh.transport import LocalTransport, SSHTransport, forget_host_key

logger = logging.getLogger(__name__)

PLUGIN_NAME = "ssh"
#: The data source of the Sump's own host.
SELF_SOURCE = SELF_ID


async def detect_self_host_data_source(transport: Transport | None = None) -> DataSource | None:
    """A "self" data source if `docker info` answers on the Sump's host, else
    `None`; never raises (no Docker, no socket, no CLI)."""
    transport = transport or LocalTransport()
    try:
        result = await transport.run(["docker", "info", "--format", "{{.ID}}"])
    except OSError as exc:
        logger.info("self-host detection: no docker command (%s)", exc)
        return None
    if result.returncode != 0:
        logger.info("self-host detection: docker info failed: %s", result.stderr.strip()[:200])
        return None
    return DockerHostDataSource(SELF_SOURCE, transport, include_self=False)


class SumpPluginSSH:
    """The plugin: its hooks, and the Sump's SSH identity once made."""

    def __init__(self, env: dict[str, str] | None = None) -> None:
        self._env = env
        self._identity: SumpIdentity | None = None
        self._store: StreamStore | None = None
        #: The "self" data source, once detected.
        self.self_source: DataSource | None = None
        #: The running collection, once the background task has started.
        self.collection: Collection | None = None
        self._ssh: dict[str, SSHTransport] = {}

    def _data_dir(self):
        env = self._env if self._env is not None else dict(os.environ)
        return data_dir_from_env(env)

    def identity(self) -> SumpIdentity:
        """The Sump's key pair, made on first use (`SUMP_DATA_DIR/ssh/`)."""
        if self._identity is None:
            self._identity = ensure_identity(self._data_dir())
        return self._identity

    def store(self) -> StreamStore:
        """The data streams and followed sets (`SUMP_DATA_DIR/streams.json`)."""
        if self._store is None:
            self.identity()  # makes the data directory owner-only too
            self._store = StreamStore(self._data_dir() / "streams.json")
        return self._store

    def streams(self) -> list[StreamDef]:
        """Every stream: "self" first when detected, then the SSH ones."""
        found = [StreamDef(SELF_ID, "self")] if self.self_source is not None else []
        return found + self.store().streams()

    def stream(self, stream_id: str) -> StreamDef | None:
        return next((s for s in self.streams() if s.id == stream_id), None)

    def ssh_transport(self, stream: StreamDef) -> SSHTransport:
        return SSHTransport(stream.host, stream.user, port=stream.port, identity=self.identity())

    def remove_stream(self, stream_id: str) -> StreamDef | None:
        """Stop the stream's collection, then forget it and its host key
        (br-STREAM-000004-sJpO9KMY); its records stay."""
        if self.collection is not None:
            self.collection.apply(stream_id, Followed())
        stream = self.store().remove(stream_id)
        self._ssh.pop(stream_id, None)
        if stream is not None:
            forget_host_key(self.identity(), stream.host, stream.port)
            logger.info("streams: removed %s; its collection stopped", stream_id)
        return stream

    def pause_stream(self, stream_id: str, paused: bool) -> None:
        """Close Data Streams: stop collecting, the followed set kept; or resume."""
        self.store().set_paused(stream_id, paused)
        if self.collection is not None:
            followed = Followed() if paused else self.store().followed(stream_id)
            self.collection.apply(stream_id, followed)
        logger.info("streams: %s %s", stream_id, "paused" if paused else "resumed")

    def transport_for(self, stream_id: str) -> Any:
        """A stream's transport: "self"'s local one, or one SSH transport per stream."""
        if stream_id == SELF_ID:
            return self.self_source.transport if self.self_source is not None else None
        stream = self.store().get(stream_id)
        if stream is None:
            return None
        if stream_id not in self._ssh:
            self._ssh[stream_id] = self.ssh_transport(stream)
        return self._ssh[stream_id]

    @hookimpl
    def sump_plugin_info(self) -> dict[str, Any]:
        return {"name": PLUGIN_NAME, "version": __version__}

    @hookimpl
    def register_transport(self, manager: Any) -> None:
        identity = self.identity()
        manager.add_transport_type("local", LocalTransport)

        def ssh(host: str, user: str, port: int = 22) -> SSHTransport:
            return SSHTransport(host, user, port=port, identity=identity)

        manager.add_transport_type("ssh", ssh)

    @hookimpl
    async def register_data_source(self, manager: Any) -> None:
        source = await detect_self_host_data_source()
        if source is not None:
            self.self_source = source
            manager.add_data_source(source.name, source)
            logger.info("self-host detection: Docker found; data source %r registered", source.name)

    @hookimpl
    def register_background_task(self, manager: Any) -> None:
        async def collect() -> None:
            adapter = manager.ingest_adapter
            if adapter is None:
                logger.warning("collection: no record store; nothing will be collected")
                await asyncio.Event().wait()
            collection = Collection(adapter.ingest, self.transport_for)
            self.collection = collection
            try:
                # Resume what was followed before the Sump stopped.
                for stream_id, followed in self.store().all_followed().items():
                    collection.apply(stream_id, followed)
                await asyncio.Event().wait()
            finally:
                self.collection = None
                await collection.stop()

        manager.add_background_task("collection", collect)

    @hookimpl
    def contribute_routes(self, app: Any) -> None:
        identity = self.identity()

        @app.get("/plugins/ssh/public-key")
        async def public_key() -> dict[str, str]:
            """The Sump's SSH public key, to add to a data stream host's
            `authorized_keys`; the private key never leaves the Sump."""
            return {"public_key": identity.public_key()}

        add_stream_routes(app, self)
        add_removal_routes(app, self)


#: The instance the `sump.plugins` entry point names.
plugin = SumpPluginSSH()
