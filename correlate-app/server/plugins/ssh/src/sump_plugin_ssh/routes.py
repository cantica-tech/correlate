"""The data streams' routes (REQ-000025-sJpO9KMY Requirements 1 and 2),
each behind the Sump's session like every route but `/health` and the login
(br-CONN-000004-sJpO9KMY):

- `GET /streams`: the data streams.
- `POST /streams` (`target`, `port`): add a stream over SSH, once Docker
  answers there with the Sump's key.
- `GET /streams/{id}/targets`: what runs there, and what is followed.
- `PUT /streams/{id}/followed`: make the followed set exactly the given one
  (br-STREAM-000002-sJpO9KMY), collection following; it resumes a paused
  stream.
- `DELETE /streams/{id}`: stop a stream's collection and forget it
  (br-STREAM-000004-sJpO9KMY); `PUT /streams/{id}/paused`: Close Data
  Streams (REQ-000027-sJpO9KMY).
- `POST /streams/{id}/promote` (`owner_key`): promote an SSH stream to a
  secondary Sump on its host (br-FED-000001, REQ-000052-sJpO9KMY); the
  Sump's owner only. `GET /streams/{id}/secondary`: the secondary, and
  whether it answers the parent (br-FED-000002).
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, Request
from pydantic import BaseModel

from sump_plugin_ssh.containers import running_containers
from sump_plugin_ssh.promote import PromoteError
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


class Promote(BaseModel):
    #: The promoting user's public key (an OpenSSH line): the secondary's owner's.
    owner_key: str


class Paused(BaseModel):
    paused: bool


class FollowedSet(BaseModel):
    containers: list[str] = []
    services: list[str] = []


def _stream_dict(stream: Any, plugin: Any = None) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    if plugin is not None:
        followed = plugin.store().followed(stream.id)
        extra = {
            "paused": plugin.store().paused(stream.id),
            "following": len(followed.containers) + len(followed.services),
            # What the charts draw (REQ-000028-sJpO9KMY), without asking Docker.
            "followed": {"containers": followed.containers, "services": followed.services},
        }
        secondary = plugin.store().secondary(stream.id)
        if secondary is not None:
            # br-FED-000004: the app shows "via <secondary>".
            extra["secondary"] = secondary
    return {
        **extra,
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
        return {"streams": [_stream_dict(s, plugin) for s in plugin.streams()]}

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
        """What runs on a stream (`{id, name, image}`, the Sump's own container
        left out), the Swarm services (`{name, replicas}`) when it is a Swarm
        manager, and what is followed."""
        if plugin.stream(stream_id) is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        transport = plugin.transport_for(stream_id)
        if transport is None:
            raise HTTPException(
                status_code=503, detail=f"data stream {stream_id} cannot be reached"
            )
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
            raise HTTPException(
                status_code=504, detail=f"{stream_id} did not answer in time"
            ) from None
        except Exception as exc:  # noqa: BLE001 -- said to the caller
            raise HTTPException(status_code=502, detail=str(exc)[:300]) from exc
        followed = plugin.store().followed(stream_id)
        return {
            "containers": containers,
            "services": services,
            "followed": {"containers": followed.containers, "services": followed.services},
        }

    @app.put("/streams/{stream_id}/followed")
    async def set_followed(stream_id: str, body: FollowedSet) -> dict[str, Any]:
        """Make the stream's followed set exactly `body`, saved, collection following."""
        if plugin.stream(stream_id) is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        if plugin.store().secondary(stream_id) is not None:
            # br-FED-000002: its secondary collects it, not this Sump.
            raise HTTPException(status_code=409, detail="its secondary Sump collects this stream")
        try:
            wanted = Followed(
                check_names(body.containers, "containers"), check_names(body.services, "services")
            )
        except StreamError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        followed = plugin.store().set_followed(stream_id, wanted)
        # A submit resumes a paused stream (FEAT-000028-sJpO9KMY).
        plugin.store().set_paused(stream_id, False)
        if plugin.collection is not None:
            plugin.collection.apply(stream_id, followed)
        return {"containers": followed.containers, "services": followed.services}


def add_removal_routes(app: Any, plugin: SumpPluginSSH) -> None:
    """Remove and pause (REQ-000027-sJpO9KMY Requirements 1 and 2)."""

    @app.delete("/streams/{stream_id}", status_code=204)
    async def remove_stream(stream_id: str) -> None:
        """Stop a stream's collection, then forget it (br-STREAM-000004-sJpO9KMY);
        "self" is detected, not kept, so it cannot be removed."""
        stream = plugin.stream(stream_id)
        if stream is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        if stream.kind == "self":
            raise HTTPException(
                status_code=409, detail="the Sump's own host cannot be removed; close it"
            )
        plugin.remove_stream(stream_id)

    @app.post("/streams/{stream_id}/promote")
    async def promote_stream(stream_id: str, body: Promote, request: Request) -> dict[str, Any]:
        """Promote an SSH stream to a secondary Sump on its host (br-FED-000001,
        REQ-000052-sJpO9KMY); this Sump's owner only, who owns the secondary."""
        session = getattr(request.state, "session", None)
        user = str(getattr(session, "user", ""))
        if not user or user != plugin.sump_owner():
            raise HTTPException(status_code=403, detail="only the Sump's owner can promote")
        if plugin.stream(stream_id) is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        try:
            return {"secondary": await plugin.promote_stream(stream_id, user, body.owner_key)}
        except PromoteError as exc:
            status = 409 if exc.step == "check" else 502
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.get("/streams/{stream_id}/secondary")
    async def secondary_status(stream_id: str) -> dict[str, Any]:
        """A promoted stream's secondary, and whether it answers the parent
        now through its forward (br-FED-000002, REQ-000052-sJpO9KMY)."""
        secondary = plugin.store().secondary(stream_id)
        client = plugin.secondary_client(stream_id)
        if secondary is None or client is None:
            raise HTTPException(status_code=404, detail=f"{stream_id} is not promoted")
        return {"secondary": secondary, **(await client.check())}

    @app.put("/streams/{stream_id}/paused")
    async def pause_stream(stream_id: str, body: Paused) -> dict[str, bool]:
        """Close Data Streams (`true`): collection stops, the followed set kept."""
        if plugin.stream(stream_id) is None:
            raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
        plugin.pause_stream(stream_id, body.paused)
        return {"paused": body.paused}
