"""The data streams' routes (REQ-000025-sJpO9KMY Requirements 1 and 2),
each behind the Sump's session like every route but `/health` and the login
(br-CONN-000004-sJpO9KMY):

- `GET /streams`: the data streams.
- `POST /streams` (`target`, `port`): add a stream over SSH, once Docker
  answers there with the Sump's key.
- `GET /streams/{id}/targets`: what runs there, and what is followed.
- `PUT /streams/{id}/followed`: make the followed set exactly the given one
  (br-STREAM-000002-sJpO9KMY), collection following.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException
from pydantic import BaseModel

from sump_plugin_ssh.containers import list_containers
from sump_plugin_ssh.streams import Followed, StreamError, check_names, parse_target

if TYPE_CHECKING:
    from sump_plugin_ssh.plugin import SumpPluginSSH

#: How long adding a stream may take to reach Docker over SSH.
ADD_TIMEOUT_S = 20.0
#: How long listing a stream's targets may take.
LIST_TIMEOUT_S = 20.0


class NewStream(BaseModel):
    target: str
    port: int = 22


class FollowedSet(BaseModel):
    containers: list[str] = []
    services: list[str] = []


def _stream_dict(stream: Any) -> dict[str, Any]:
    return {
        "id": stream.id,
        "kind": stream.kind,
        "label": stream.label,
        "user": stream.user or None,
        "host": stream.host or None,
        "port": stream.port if stream.kind == "ssh" else None,
    }


def add_stream_routes(app: Any, plugin: SumpPluginSSH) -> None:
    """Add the routes to the Sump's app."""

    @app.get("/streams")
    async def streams() -> dict[str, Any]:
        """The data streams: "self" when detected, then those over SSH."""
        return {"streams": [_stream_dict(s) for s in plugin.streams()]}

    @app.post("/streams", status_code=201)
    async def add_stream(body: NewStream) -> dict[str, Any]:
        """Add a stream over SSH once Docker answers there with the Sump's key."""
        try:
            stream = parse_target(body.target, body.port)
        except StreamError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        transport = plugin.ssh_transport(stream)
        try:
            async with asyncio.timeout(ADD_TIMEOUT_S):
                result = await transport.run(
                    ["docker", "version", "--format", "{{.Server.Version}}"]
                )
        except TimeoutError:
            raise HTTPException(
                status_code=502, detail=f"no answer from {stream.label} in {ADD_TIMEOUT_S:.0f} s"
            ) from None
        if result.returncode != 0:
            why = (result.stderr or result.stdout).strip()[:300] or f"exit {result.returncode}"
            raise HTTPException(status_code=502, detail=f"Docker on {stream.label}: {why}")
        return _stream_dict(plugin.store().add(stream))

    @app.get("/streams/{stream_id}/targets")
    async def targets(stream_id: str) -> dict[str, Any]:
        """What runs on a stream (the Sump's own container left out), the
        Swarm services when it is a Swarm manager, and what is followed."""
        if plugin.stream(stream_id) is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        transport = plugin.transport_for(stream_id)
        if transport is None:
            raise HTTPException(
                status_code=503, detail=f"data stream {stream_id} cannot be reached"
            )
        try:
            async with asyncio.timeout(LIST_TIMEOUT_S):
                containers = await list_containers(transport)
                swarm = await transport.run(
                    ["docker", "info", "--format", "{{.Swarm.ControlAvailable}}"]
                )
                services: list[str] | None = None
                if swarm.returncode == 0 and swarm.stdout.strip() == "true":
                    listed = await transport.run(
                        ["docker", "service", "ls", "--format", "{{json .}}"]
                    )
                    listed.check()
                    services = sorted(
                        json.loads(line)["Name"]
                        for line in listed.stdout.splitlines()
                        if line.strip()
                    )
        except TimeoutError:
            raise HTTPException(
                status_code=504, detail=f"{stream_id} did not answer in time"
            ) from None
        except Exception as exc:  # noqa: BLE001 -- said to the caller
            raise HTTPException(status_code=502, detail=str(exc)[:300]) from exc
        followed = plugin.store().followed(stream_id)
        return {
            "containers": [{"id": c.container_id, "name": c.container_name} for c in containers],
            "services": services,
            "followed": {"containers": followed.containers, "services": followed.services},
        }

    @app.put("/streams/{stream_id}/followed")
    async def set_followed(stream_id: str, body: FollowedSet) -> dict[str, Any]:
        """Make the stream's followed set exactly `body`, saved, collection following."""
        if plugin.stream(stream_id) is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        try:
            wanted = Followed(
                check_names(body.containers, "containers"), check_names(body.services, "services")
            )
        except StreamError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        followed = plugin.store().set_followed(stream_id, wanted)
        if plugin.collection is not None:
            plugin.collection.apply(stream_id, followed)
        return {"containers": followed.containers, "services": followed.services}
