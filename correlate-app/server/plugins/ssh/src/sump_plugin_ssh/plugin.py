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
import re
import socket
import time
from dataclasses import asdict
from typing import Any

from correlate_sump.datasource import DataSource
from correlate_sump.plugins import hookimpl
from correlate_sump.transport import Transport
from correlate_sump.users import UserStore, data_dir_from_env
from sump_plugin_ssh import __version__
from sump_plugin_ssh.collect import Collection
from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.host import SCRIPT, helper_name, self_reader_args
from sump_plugin_ssh.identity import SumpIdentity, ensure_identity
from sump_plugin_ssh.promote import SECONDARY_PORT, PromoteError, Secondary, provision_secondary
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
        #: The Sump's own image, for the "self" host reader (REQ-000032-sJpO9KMY).
        self._image: str | None = None
        self._image_warned = False

    def _data_dir(self):
        env = self._env if self._env is not None else dict(os.environ)
        return data_dir_from_env(env)

    def sump_owner(self) -> str | None:
        """This Sump's owner, or `None` before one is set (or when unreadable)."""
        try:
            return UserStore(self._data_dir()).owner()
        except Exception:  # noqa: BLE001 - a corrupt store owns nothing
            return None

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

    async def promote_stream(self, stream_id: str, owner: str, owner_key: str) -> dict[str, Any]:
        """Promote an SSH stream to a secondary Sump on its host (br-FED-000001,
        REQ-000052-sJpO9KMY): provisioned through this Sump's SSH access, owned
        by `owner`, this Sump a user on it; then collected there, not here.
        Raises `PromoteError` (nothing left running, still collected here)."""
        stream = self.store().get(stream_id)
        if stream is None or stream.kind != "ssh":
            raise PromoteError("check", "only a data stream over SSH can be promoted")
        if self.store().secondary(stream_id) is not None:
            raise PromoteError("check", "this data stream is already promoted")
        image = os.environ.get("SUMP_IMAGE")
        local = self.self_source.transport if self.self_source is not None else None
        if not image and local is not None:
            image = await self._own_image(local)
        if not image:
            raise PromoteError("check", "this Sump cannot tell its own image (no Docker socket)")
        name = re.sub(r"[^A-Za-z0-9._-]", "-", self._own_container())[:40] or "sump"
        parent_user = f"parent-{name}"
        parent_key = self.identity().public_key_file.read_text(encoding="utf-8").strip()
        transport = self.transport_for(stream_id)
        await provision_secondary(
            transport,
            image=image,
            owner=owner,
            owner_key=owner_key,
            parent_user=parent_user,
            parent_key=parent_key,
        )
        secondary = asdict(
            Secondary(
                host=stream.host,
                ssh_port=stream.port,
                ssh_user=stream.user,
                sump_port=SECONDARY_PORT,
                owner=owner,
                parent_user=parent_user,
                promoted_at=int(time.time() * 1000),
            )
        )
        self.store().set_secondary(stream_id, secondary)
        if self.collection is not None:
            self.collection.apply(stream_id, Followed())
        logger.info("streams: %s promoted; its secondary collects it", stream_id)
        return secondary

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

    async def host_reader(self, stream_id: str) -> tuple[Transport, list[str], str] | None:
        """How to read a stream's host (REQ-000032-sJpO9KMY): over SSH, the loop
        as a shell command; for "self", in a container of the Sump's own image
        on the host's network. None when it cannot be read now."""
        transport = self.transport_for(stream_id)
        if transport is None:
            return None
        if stream_id != SELF_ID:
            stream = self.store().get(stream_id)
            return transport, transport.shell_args(SCRIPT), stream.host if stream else stream_id
        image = await self._own_image(transport)
        if image is None:
            return None
        return transport, self_reader_args(image, helper_name(self._own_container())), "localhost"

    @staticmethod
    def _own_container() -> str:
        """The Sump's own container: Docker names its host after it."""
        return os.environ.get("HOSTNAME") or socket.gethostname()

    async def _own_image(self, transport: Transport) -> str | None:
        """The Sump's own image, found once by inspecting its container."""
        if self._image is not None:
            return self._image
        result = await transport.run(
            ["docker", "inspect", "--format", "{{.Config.Image}}", self._own_container()]
        )
        image = result.stdout.strip()
        if result.returncode != 0 or not image:
            if not self._image_warned:
                self._image_warned = True
                logger.warning(
                    "host telemetry: the Sump's own image is not known (%s); no host figures"
                    " for self",
                    (result.stderr or result.stdout).strip()[:200],
                )
            return None
        self._image = image
        return image

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
            collection = Collection(
                adapter.ingest, self.transport_for, host_reader=self.host_reader
            )
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
