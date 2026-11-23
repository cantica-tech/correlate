"""The SSH plugin's stream kind (br-PLUGIN-000010-sJpO9KMY, REQ-000056-sJpO9KMY):
"self" (the Sump's own Docker host, when detected) and Docker hosts reached
over SSH. The core keeps these streams and holds their rules; this kind
makes them (reaching Docker with the Sump's key), lists what runs there,
collects their followed sets and forgets their host keys (REQ-000025,
REQ-000027-sJpO9KMY).
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from correlate_sump.streams import SELF_ID, Followed, StreamDef, StreamRefused
from sump_plugin_ssh.containers import running_containers
from sump_plugin_ssh.streams import parse_target

if TYPE_CHECKING:
    from sump_plugin_ssh.plugin import SumpPluginSSH

#: How long adding a stream may take to reach Docker over SSH.
ADD_TIMEOUT_S = 20.0
#: How long listing a stream's targets may take.
LIST_TIMEOUT_S = 20.0


class SSHStreamKind:
    """ "self" and SSH streams: Docker hosts."""

    kinds: tuple[str, ...] = ("self", "ssh")

    def __init__(self, plugin: SumpPluginSSH) -> None:
        self._plugin = plugin

    def detected(self) -> list[StreamDef]:
        """ "self", when the Sump's host runs Docker."""
        return [StreamDef(SELF_ID, "self")] if self._plugin.self_source is not None else []

    async def create(self, body: dict[str, Any]) -> StreamDef:
        """A stream over SSH (`target` `user@host`, `port`), once Docker answers
        there with the Sump's key."""
        stream = parse_target(body.get("target"), body.get("port", 22))
        transport = self._plugin.ssh_transport(stream)
        try:
            async with asyncio.timeout(ADD_TIMEOUT_S):
                result = await transport.run(
                    ["docker", "version", "--format", "{{.Server.Version}}"]
                )
        except TimeoutError:
            raise StreamRefused(
                502, f"no answer from {stream.label} in {ADD_TIMEOUT_S:.0f} s"
            ) from None
        if result.returncode != 0:
            why = (result.stderr or result.stdout).strip()[:300] or f"exit {result.returncode}"
            raise StreamRefused(502, f"Docker on {stream.label}: {why}")
        return stream

    async def targets(self, stream: StreamDef) -> dict[str, Any]:
        """What runs there (`{id, name, image}`, the Sump's own container left
        out), and the Swarm services (`{name, replicas}`) on a Swarm manager."""
        transport = self._plugin.transport_for(stream.id)
        if transport is None:
            raise StreamRefused(503, f"data stream {stream.id} cannot be reached")
        try:
            async with asyncio.timeout(LIST_TIMEOUT_S):
                containers = await running_containers(transport)
                swarm = await transport.run(
                    ["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]
                )
                services: list[dict[str, str]] | None = None
                if swarm.returncode == 0 and swarm.stdout.strip() == "true":
                    listed = await transport.run(
                        ["docker", "service", "ls", "--format", "{{json .}}"]
                    )
                    listed.check()
                    rows = [json.loads(line) for line in listed.stdout.splitlines() if line.strip()]
                    services = sorted(
                        ({"name": r["Name"], "replicas": r.get("Replicas", "")} for r in rows),
                        key=lambda r: r["name"],
                    )
        except TimeoutError:
            raise StreamRefused(504, f"{stream.id} did not answer in time") from None
        except StreamRefused:
            raise
        except Exception as exc:  # noqa: BLE001 -- said to the caller
            raise StreamRefused(502, str(exc)[:300]) from exc
        return {"containers": containers, "services": services}

    def check_follow(self, stream: StreamDef) -> None:
        """A promoted stream's secondary collects it, not this Sump (br-FED-000002)."""
        if self._plugin.store().secondary(stream.id) is not None:
            raise StreamRefused(409, "its secondary Sump collects this stream")

    def apply(self, stream: StreamDef, followed: Followed) -> None:
        if self._plugin.collection is not None:
            self._plugin.collection.apply(stream.id, followed)

    def removed(self, stream: StreamDef) -> None:
        """ "self" is detected, not kept: closed, never removed; an SSH stream's
        transport and host key are forgotten (br-STREAM-000004-sJpO9KMY)."""
        if stream.kind == "self":
            raise StreamRefused(409, "the Sump's own host cannot be removed; close it")
        self._plugin.forget_stream(stream)

    def describe(self, stream: StreamDef) -> dict[str, Any]:
        """A promoted stream's secondary: the app shows "via <secondary>" (br-FED-000004)."""
        secondary = self._plugin.store().secondary(stream.id)
        return {"secondary": secondary} if secondary is not None else {}
