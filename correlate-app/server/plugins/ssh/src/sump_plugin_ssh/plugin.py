"""The `sump.plugins` entry point (REQ-000024-sJpO9KMY).

Registers the `local` and `ssh` transports (`ssh` with the Sump's own key),
contributes `GET /plugins/ssh/public-key`, and at start detects whether the
Sump's host runs Docker: through the host's Docker socket, mounted into the
Sump's container by the app's provisioning (decided in
FEAT-000025-sJpO9KMY). If it does, a "self" data source is registered, the
Sump's own container left out of its list; if not, none, and the Sump
starts all the same (br-PLUGIN-000008-sJpO9KMY). Ported from correlator's
`sump-plugin-ssh`.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from correlate_sump.datasource import DataSource
from correlate_sump.plugins import hookimpl
from correlate_sump.transport import Transport
from correlate_sump.users import data_dir_from_env
from sump_plugin_ssh import __version__
from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.identity import SumpIdentity, ensure_identity
from sump_plugin_ssh.transport import LocalTransport, SSHTransport

logger = logging.getLogger(__name__)

PLUGIN_NAME = "ssh"
#: The data source of the Sump's own host.
SELF_SOURCE = "self"


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

    def identity(self) -> SumpIdentity:
        """The Sump's key pair, made on first use (`SUMP_DATA_DIR/ssh/`)."""
        if self._identity is None:
            env = self._env if self._env is not None else dict(os.environ)
            self._identity = ensure_identity(data_dir_from_env(env))
        return self._identity

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
            manager.add_data_source(source.name, source)
            logger.info("self-host detection: Docker found; data source %r registered", source.name)

    @hookimpl
    def contribute_routes(self, app: Any) -> None:
        identity = self.identity()

        @app.get("/plugins/ssh/public-key")
        async def public_key() -> dict[str, str]:
            """The Sump's SSH public key, to add to a data stream host's
            `authorized_keys`; the private key never leaves the Sump."""
            return {"public_key": identity.public_key()}


#: The instance the `sump.plugins` entry point names.
plugin = SumpPluginSSH()
