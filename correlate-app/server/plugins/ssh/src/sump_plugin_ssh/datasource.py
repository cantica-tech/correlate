"""`DockerHostDataSource` (REQ-000024-sJpO9KMY Requirement 3): a Docker host
reached through a `Transport` (local or SSH), listing its running containers.
Ported from correlator's `sump-plugin-ssh`.
"""

from __future__ import annotations

from correlate_sump.datasource import ContainerRef
from correlate_sump.transport import Transport
from sump_plugin_ssh.containers import list_containers


class DockerHostDataSource:
    """A `correlate_sump.datasource.DataSource` for one Docker host."""

    def __init__(self, name: str, transport: Transport, *, include_self: bool = False) -> None:
        self._name = name
        self._transport = transport
        self._include_self = include_self

    @property
    def name(self) -> str:
        return self._name

    @property
    def transport(self) -> Transport:
        return self._transport

    async def list_targets(self) -> list[ContainerRef]:
        return await list_containers(self._transport, include_self=self._include_self)
