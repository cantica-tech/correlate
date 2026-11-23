"""The `sump.plugins` entry point (REQ-000024-sJpO9KMY).

Registers the `local` and `ssh` transports (`ssh` with the Sump's own key),
its data streams' kind (`kind.py`; the streams, their store and routes are
the core's, br-PLUGIN-000010-sJpO9KMY), `GET /plugins/ssh/public-key` and
promotion's routes, runs collection as its background task (resuming every
saved followed set), and at start detects whether the
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
from datetime import UTC, datetime
from typing import Any

from correlate_sump.datasource import DataSource
from correlate_sump.federation import Federated
from correlate_sump.plugins import hookimpl
from correlate_sump.streams import StreamRegistry
from correlate_sump.transport import Transport
from correlate_sump.users import UserStore, data_dir_from_env
from sump_plugin_ssh import __version__
from sump_plugin_ssh.collect import Collection
from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.host import SCRIPT, helper_name, self_reader_args
from sump_plugin_ssh.identity import SumpIdentity, ensure_identity
from sump_plugin_ssh.kind import SSHStreamKind
from sump_plugin_ssh.promote import SECONDARY_PORT, PromoteError, Secondary, provision_secondary
from sump_plugin_ssh.routes import add_promote_routes
from sump_plugin_ssh.secondary import Forward, SecondaryClient, ssh_channel_opener
from sump_plugin_ssh.streams import SELF_ID, Followed, StreamDef, StreamStore
from sump_plugin_ssh.transport import LocalTransport, SSHTransport, forget_host_key

#: How long fetched secondary records are reused.
FETCH_CACHE_S = 2.0
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
        #: The Sump's stream registry (the core's, from `register_stream_kind`;
        #: else its own, when the plugin runs alone, as in its tests).
        self._registry: StreamRegistry | None = None
        self.kind = SSHStreamKind(self)
        #: The "self" data source, once detected.
        self.self_source: DataSource | None = None
        #: The running collection, once the background task has started.
        self.collection: Collection | None = None
        self._ssh: dict[str, SSHTransport] = {}
        #: The Sump's own image, for the "self" host reader (REQ-000032-sJpO9KMY).
        self._image: str | None = None
        #: Promoted streams' forwards and clients, made on first use.
        self._secondaries: dict[str, tuple[Forward, SecondaryClient]] = {}
        #: The secondaries' records lately fetched, by (source, kind): one
        #: chart's queries in a row ask the secondary once.
        self._fetched: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
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

    def registry(self) -> StreamRegistry:
        """The Sump's streams: the core's registry, or one of its own (alone)."""
        if self._registry is None:
            self.identity()  # makes the data directory owner-only too
            self._registry = StreamRegistry(self._data_dir() / "streams.json", self.sump_owner)
            self._registry.add_kind(self.kind)
        return self._registry

    def store(self) -> StreamStore:
        """The data streams and followed sets (`SUMP_DATA_DIR/streams.json`)."""
        return self.registry().store()

    def streams(self) -> list[StreamDef]:
        """Every stream the Sump has: "self" first when detected, then the kept ones."""
        return self.registry().streams()

    def stream(self, stream_id: str) -> StreamDef | None:
        return self.registry().stream(stream_id)

    def ssh_transport(self, stream: StreamDef) -> SSHTransport:
        return SSHTransport(stream.host, stream.user, port=stream.port, identity=self.identity())

    def remove_stream(self, stream_id: str) -> StreamDef | None:
        """Stop the stream's collection, then forget it and its host key
        (br-STREAM-000004-sJpO9KMY); its records stay."""
        stream = self.stream(stream_id)
        if stream is not None:
            self.registry().remove(stream)
        return stream

    def forget_stream(self, stream: StreamDef) -> None:
        """A removed SSH stream's transport and host key, forgotten."""
        self._ssh.pop(stream.id, None)
        forget_host_key(self.identity(), stream.host, stream.port)

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
            followed=asdict(self.store().followed(stream_id)),
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

    def creator(self, stream_id: str) -> str | None:
        """Who added the stream (br-STREAM-000006-sJpO9KMY), as the core says."""
        return self.registry().creator(stream_id)

    def may_see(self, stream_id: str, user: str | None) -> bool:
        return self.registry().may_see(stream_id, user)

    def may_change(self, stream_id: str, user: str | None) -> bool:
        return self.registry().may_change(stream_id, user)

    def secondary_client(self, stream_id: str) -> SecondaryClient | None:
        """The parent's client of a promoted stream's secondary (br-FED-000002,
        REQ-000052-sJpO9KMY): through its own SSH forward, as `parent_user`."""
        secondary = self.store().secondary(stream_id)
        stream = self.store().get(stream_id)
        if secondary is None or stream is None:
            return None
        if stream_id not in self._secondaries:
            transport = self.ssh_transport(stream)
            forward = Forward(
                ssh_channel_opener(transport.connect, int(secondary["sump_port"])),
                label=stream_id,
            )

            async def base_url() -> str:
                return f"http://127.0.0.1:{await forward.port()}"

            client = SecondaryClient(
                str(secondary["parent_user"]), self.identity().private_key, base_url
            )
            self._secondaries[stream_id] = (forward, client)
        return self._secondaries[stream_id][1]

    def pause_stream(self, stream_id: str, paused: bool) -> None:
        """Close Data Streams: stop collecting, the followed set kept; or resume."""
        stream = self.stream(stream_id)
        if stream is not None:
            self.registry().pause(stream, paused)

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
                self.registry().resume(self.kind)
                await asyncio.Event().wait()
            finally:
                self.collection = None
                await collection.stop()

        manager.add_background_task("collection", collect)

    @hookimpl
    def register_stream_kind(self, manager: Any) -> None:
        """Its streams' kind, in the core's registry (br-PLUGIN-000010-sJpO9KMY)."""
        registry = getattr(manager, "streams", None)
        if registry is not None:
            registry.add_kind(self.kind)
            self._registry = registry

    def source_hidden(self, source: str, user: str | None) -> bool | None:
        """A source of a stream hidden from `user` (br-STREAM-000007-sJpO9KMY),
        as the core rules it; None for a source that is no stream's."""
        return self.registry().source_hidden(source, user)

    @hookimpl
    def federated_source(self, source: str) -> Federated | None:
        """A promoted stream's source, joined at its promotion time
        (br-FED-000002, REQ-000052-sJpO9KMY): on its secondary the host is
        "self", so `<stream>/<name>` is asked there as `self/<name>`."""
        stream_id, sep, name = source.partition("/")
        if not sep or not name:
            return None
        secondary = self.store().secondary(stream_id)
        client = self.secondary_client(stream_id) if secondary else None
        if secondary is None or client is None:
            return None
        cut = datetime.fromtimestamp(int(secondary["promoted_at"]) / 1000, UTC)

        async def fetch(kind: str) -> list[dict[str, Any]]:
            key = (source, kind)
            cached = self._fetched.get(key)
            if cached is not None and time.monotonic() - cached[0] < FETCH_CACHE_S:
                return cached[1]
            records = await client.records(f"{SELF_ID}/{name}", kind, cut)
            renamed = [{**r, "source": source} for r in records]
            self._fetched[key] = (time.monotonic(), renamed)
            return renamed

        return Federated(cut=cut, fetch=fetch)

    @hookimpl
    def contribute_routes(self, app: Any) -> None:
        identity = self.identity()

        @app.get("/plugins/ssh/public-key")
        async def public_key() -> dict[str, str]:
            """The Sump's SSH public key, to add to a data stream host's
            `authorized_keys`; the private key never leaves the Sump."""
            return {"public_key": identity.public_key()}

        add_promote_routes(app, self)


#: The instance the `sump.plugins` entry point names.
plugin = SumpPluginSSH()
