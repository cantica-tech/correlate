"""The data streams' routes, for every plugin's streams alike
(br-PLUGIN-000010-sJpO9KMY, REQ-000056-sJpO9KMY; moved from the SSH plugin,
REQ-000025-sJpO9KMY), each behind the Sump's session:

- `GET /streams`: the streams the caller may see (br-STREAM-000007), each
  with its kind, what it follows, who added it, whether it is private and
  whether the caller may change it.
- `POST /streams` (`kind`, `ssh` by default, its own fields, `private`):
  add a stream; its kind makes it once it answers (br-STREAM-000006).
- `GET /streams/{id}/targets`: what runs there, and what is followed.
- `PUT /streams/{id}/followed`: make the followed set exactly the given one
  (br-STREAM-000002), collection following; it resumes a paused stream.
- `PUT /streams/{id}/paused`, `PUT /streams/{id}/private`,
  `DELETE /streams/{id}` (br-STREAM-000004).

A stream hidden from the caller answers 404, as one that does not exist; a
change by someone who may only see it, 403 (br-STREAM-000008).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import Body, HTTPException, Request
from pydantic import BaseModel

from correlate_sump.streams import (
    Followed,
    StreamDef,
    StreamError,
    StreamRefused,
    StreamRegistry,
    check_names,
)

logger = logging.getLogger(__name__)


class Paused(BaseModel):
    paused: bool


class Private(BaseModel):
    private: bool


class FollowedSet(BaseModel):
    containers: list[str] = []
    services: list[str] = []


def request_user(request: Request) -> str | None:
    """The caller, from the session the Sump's guard put on the request."""
    session = getattr(request.state, "session", None)
    user = getattr(session, "user", None)
    return str(user) if user else None


def visible(registry: StreamRegistry, stream_id: str, user: str | None) -> StreamDef:
    """The stream, if the caller may see it; 404 otherwise, as for one that
    does not exist (br-STREAM-000007-sJpO9KMY)."""
    stream = registry.stream(stream_id)
    if stream is None or not registry.may_see(stream_id, user):
        raise HTTPException(status_code=404, detail=f"no data stream {stream_id}")
    return stream


def changeable(registry: StreamRegistry, stream_id: str, user: str | None) -> StreamDef:
    """The stream, if the caller may change it (br-STREAM-000008-sJpO9KMY); 403
    for one they only see."""
    stream = visible(registry, stream_id, user)
    if not registry.may_change(stream_id, user):
        logger.info("streams: %s may not change %s", user, stream_id)
        raise HTTPException(
            status_code=403,
            detail="only who added this data stream, or the Sump's owner, can change it",
        )
    return stream


def stream_dict(registry: StreamRegistry, stream: StreamDef, user: str | None) -> dict[str, Any]:
    """A stream as `GET /streams` lists it."""
    store = registry.store()
    followed = store.followed(stream.id)
    kind = registry.kind_of(stream)
    return {
        "paused": store.paused(stream.id),
        "following": len(followed.containers) + len(followed.services),
        # What the charts draw (REQ-000028-sJpO9KMY), without asking the source.
        "followed": {"containers": followed.containers, "services": followed.services},
        # br-STREAM-000006/-000009: who added it, and whether it is private.
        "created_by": registry.creator(stream.id),
        "private": store.private(stream.id),
        # Whether the caller may change it (br-STREAM-000008): the app's switch.
        "may_change": registry.may_change(stream.id, user),
        **(kind.describe(stream) if kind is not None else {}),
        "id": stream.id,
        "kind": stream.kind,
        "label": stream.label,
        "user": stream.user or None,
        "host": stream.host or None,
        "port": stream.port if stream.kind == "ssh" else None,
    }


def _refused(exc: StreamRefused) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.detail)


def add_stream_routes(app: Any, registry: StreamRegistry) -> None:
    """Add the stream routes to the Sump's app."""

    @app.get("/streams")
    async def streams(request: Request) -> dict[str, Any]:
        """The data streams the caller may see: every kind's (br-PLUGIN-000010)."""
        user = request_user(request)
        return {
            "streams": [
                stream_dict(registry, s, user)
                for s in registry.streams()
                if registry.may_see(s.id, user)
            ]
        }

    @app.post("/streams", status_code=201)
    async def add_stream(
        request: Request, body: Annotated[dict[str, Any], Body()]
    ) -> dict[str, Any]:
        """Add a stream of `kind` (`ssh` by default) once it answers; the caller
        its creator, private if asked (br-STREAM-000006-sJpO9KMY)."""
        user = request_user(request)
        name = str(body.get("kind", "ssh"))
        kind = registry.kind_named(name)
        if kind is None:
            raise HTTPException(status_code=422, detail=f"no data stream kind {name!r} here")
        try:
            stream = await kind.create(body)
        except StreamError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except StreamRefused as exc:
            raise _refused(exc) from exc
        if stream.kind not in kind.kinds:
            raise HTTPException(status_code=500, detail="the stream's kind made another kind")
        kept = registry.store().get(stream.id)
        if kept is not None and not registry.may_see(stream.id, user):
            # Someone else's private stream: not this caller's to add or see.
            raise HTTPException(status_code=409, detail=f"{stream.label} cannot be added")
        added = registry.store().add(stream, created_by=user, private=body.get("private") is True)
        return stream_dict(registry, added, user)

    @app.get("/streams/{stream_id}/targets")
    async def targets(stream_id: str, request: Request) -> dict[str, Any]:
        """What runs on a stream, and what is followed."""
        stream = visible(registry, stream_id, request_user(request))
        kind = registry.kind_of(stream)
        if kind is None:
            raise HTTPException(status_code=503, detail=f"data stream {stream_id} has no plugin")
        try:
            found = await kind.targets(stream)
        except StreamRefused as exc:
            raise _refused(exc) from exc
        followed = registry.store().followed(stream_id)
        return {
            "containers": found.get("containers", []),
            "services": found.get("services"),
            "followed": {"containers": followed.containers, "services": followed.services},
        }

    @app.put("/streams/{stream_id}/followed")
    async def set_followed(stream_id: str, body: FollowedSet, request: Request) -> dict[str, Any]:
        """Make the stream's followed set exactly `body`, saved, collection following."""
        stream = changeable(registry, stream_id, request_user(request))
        try:
            wanted = Followed(
                check_names(body.containers, "containers"), check_names(body.services, "services")
            )
            followed = registry.set_followed(stream, wanted)
        except StreamError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except StreamRefused as exc:
            raise _refused(exc) from exc
        return {"containers": followed.containers, "services": followed.services}

    @app.delete("/streams/{stream_id}", status_code=204)
    async def remove_stream(stream_id: str, request: Request) -> None:
        """Stop a stream's collection, then forget it (br-STREAM-000004-sJpO9KMY)."""
        stream = changeable(registry, stream_id, request_user(request))
        try:
            registry.remove(stream)
        except StreamRefused as exc:
            raise _refused(exc) from exc

    @app.put("/streams/{stream_id}/paused")
    async def pause_stream(stream_id: str, body: Paused, request: Request) -> dict[str, bool]:
        """Close Data Streams (`true`): collection stops, the followed set kept."""
        stream = changeable(registry, stream_id, request_user(request))
        registry.pause(stream, body.paused)
        return {"paused": body.paused}

    @app.put("/streams/{stream_id}/private")
    async def set_private(stream_id: str, body: Private, request: Request) -> dict[str, bool]:
        """Make a stream private (its creator and the owner only) or shared
        (br-STREAM-000007-sJpO9KMY); theirs to change (br-STREAM-000008)."""
        changeable(registry, stream_id, request_user(request))
        registry.store().set_private(stream_id, body.private)
        return {"private": body.private}
