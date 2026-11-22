"""The events' HTTP API (REQ-000044-sJpO9KMY, br-EVENT-000007-sJpO9KMY).

Behind the Sump's session guard: every call has a user, the D3 identity.

- `GET /events`: the caller's events (all of them for the Sump's owner).
- `POST /events`: a new event, the caller's; refused (422) if the engine
  could not evaluate it. Its answer (and an edit's) carries `warnings`: the
  watched streams whose cap holds less than a snapshot's window (Item 49).
- `GET /events/{id}`: one event the caller sees.
- `PUT /events/{id}`: an edit, based on `version`; the event's owner only
  (403); a stale version refused (409), never overwritten.
- `DELETE /events/{id}?version=N`: the event's owner, or the Sump's owner;
  its firings stay.
- `POST /events/{id}/reset`: re-arm it; the event's owner only.
- `GET /events/{id}/artifacts`: its firings' artifacts, newest first
  (REQ-000045-sJpO9KMY).
- `GET /artifacts/{id}`: an artifact's `.recording`, only once complete
  (409 while pending, or failed); its event's owner or the Sump's owner.
- `POST /artifacts/{id}/keep` (`{ "days": n }`): kept n days from now, at
  most 30; its event's owner only.
- `GET /events/firings/stream`: the firings of the caller's events (all of
  them for the Sump's owner) as they happen, as server-sent events with the
  Sump's heartbeat; `Last-Event-ID` (or `?after=`) resumes after a firing
  (REQ-000046).

An event another user owns is answered as not found (404), unless the caller
is the Sump's owner.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any

from fastapi import Body, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from correlate_sump.sse import ServerSentEvent, event_stream
from sump_plugin_events.artifacts import ArtifactRefused, Artifacts, window_warnings
from sump_plugin_events.engine import FIRINGS, EventRefused, EventStore, visible
from sump_plugin_events.model import InvalidEvent


def _caller(request: Request) -> str:
    """The session's user (the Sump's session guard set it)."""
    session = getattr(request.state, "session", None)
    if session is None:
        raise HTTPException(status_code=401, detail="no session")
    return str(session.user)


def add_event_routes(
    app: Any,
    store: Callable[[], EventStore | None],
    sump_owner: Callable[[], str | None],
    now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
    artifacts: Callable[[], Artifacts | None] = lambda: None,
) -> None:
    """Add the events' routes to `app`; `store` (and `artifacts`) None until the plugin runs."""

    def the_artifacts() -> Artifacts:
        found = artifacts()
        if found is None:
            raise HTTPException(status_code=503, detail="the event engine is not running")
        return found

    async def seen_artifact(artifact_id: str, caller: str) -> dict[str, Any]:
        record = await the_artifacts().get(artifact_id)
        owner = sump_owner()
        if record is None or not (record["owner"] == caller or caller == owner):
            raise HTTPException(status_code=404, detail=f"no artifact {artifact_id}")
        return record

    def the_store() -> EventStore:
        found = store()
        if found is None:
            raise HTTPException(status_code=503, detail="the event engine is not running")
        return found

    async def with_warnings(event: Any) -> dict[str, Any]:
        """The event, and whether its streams keep its snapshot's window (Item 49)."""
        found = artifacts()
        maxlen = found.maxlen if found is not None else None
        warnings = await window_warnings(the_store().redis, event, maxlen)
        return {**event.to_json(), "warnings": warnings}

    def refused(error: EventRefused | InvalidEvent) -> HTTPException:
        status = 422 if isinstance(error, InvalidEvent) else error.status
        return HTTPException(status_code=status, detail=str(error))

    @app.get("/events")
    async def list_events(request: Request) -> dict[str, Any]:
        caller, owner = _caller(request), sump_owner()
        events = await the_store().all()
        return {"events": [e.to_json() for e in events if visible(e, caller, owner)]}

    @app.post("/events", status_code=201)
    async def create_event(
        request: Request, spec: Annotated[dict[str, Any], Body()]
    ) -> dict[str, Any]:
        caller = _caller(request)
        try:
            event = await the_store().create(spec, caller, now_ms())
        except InvalidEvent as error:
            raise refused(error) from error
        return await with_warnings(event)

    @app.get("/events/{event_id}")
    async def get_event(event_id: str, request: Request) -> dict[str, Any]:
        caller = _caller(request)
        event = await the_store().get(event_id)
        if event is None or not visible(event, caller, sump_owner()):
            raise HTTPException(status_code=404, detail=f"no event {event_id}")
        return event.to_json()

    @app.put("/events/{event_id}")
    async def edit_event(
        event_id: str, request: Request, spec: Annotated[dict[str, Any], Body()]
    ) -> dict[str, Any]:
        caller = _caller(request)
        store = the_store()
        existing = await store.get(event_id)
        if existing is None or not visible(existing, caller, sump_owner()):
            raise HTTPException(status_code=404, detail=f"no event {event_id}")
        try:
            event = await store.update(event_id, spec, caller)
        except (EventRefused, InvalidEvent) as error:
            raise refused(error) from error
        return await with_warnings(event)

    @app.delete("/events/{event_id}")
    async def delete_event(
        event_id: str, request: Request, version: Annotated[int, Query()]
    ) -> dict[str, Any]:
        try:
            await the_store().delete(event_id, version, _caller(request), sump_owner())
        except EventRefused as error:
            raise refused(error) from error
        return {"ok": True}

    @app.post("/events/{event_id}/reset")
    async def reset_event(event_id: str, request: Request) -> dict[str, Any]:
        caller = _caller(request)
        store = the_store()
        existing = await store.get(event_id)
        if existing is None or not visible(existing, caller, sump_owner()):
            raise HTTPException(status_code=404, detail=f"no event {event_id}")
        try:
            event = await store.reset(event_id, caller)
        except EventRefused as error:
            raise refused(error) from error
        return event.to_json()

    @app.get("/events/{event_id}/artifacts")
    async def event_artifacts(event_id: str, request: Request) -> dict[str, Any]:
        caller = _caller(request)
        event = await the_store().get(event_id)
        if event is None or not visible(event, caller, sump_owner()):
            raise HTTPException(status_code=404, detail=f"no event {event_id}")
        return {"artifacts": await the_artifacts().of_event(event_id)}

    @app.get("/artifacts/{artifact_id}")
    async def download_artifact(artifact_id: str, request: Request) -> FileResponse:
        record = await seen_artifact(artifact_id, _caller(request))
        if record["status"] != "complete":
            why = record["reason"] if record["status"] == "failed" else "it is still being made"
            raise HTTPException(
                status_code=409, detail=f"the artifact is {record['status']}: {why}"
            )
        try:
            path = the_artifacts().path(artifact_id)
        except ArtifactRefused as error:
            raise HTTPException(status_code=error.status, detail=str(error)) from error
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"artifact {artifact_id} has no file")
        return FileResponse(
            path, media_type="application/zip", filename=f"event-{artifact_id}.recording"
        )

    @app.post("/artifacts/{artifact_id}/keep")
    async def keep_artifact(
        artifact_id: str, request: Request, body: Annotated[dict[str, Any], Body()]
    ) -> dict[str, Any]:
        caller = _caller(request)
        await seen_artifact(artifact_id, caller)
        days = body.get("days")
        if isinstance(days, bool) or not isinstance(days, int | float):
            raise HTTPException(status_code=422, detail="days must be a number")
        try:
            return await the_artifacts().keep(
                artifact_id, int(days * 24 * 3600 * 1000), caller, now_ms()
            )
        except ArtifactRefused as error:
            raise HTTPException(status_code=error.status, detail=str(error)) from error

    @app.get("/events/firings/stream")
    async def firings_stream(request: Request) -> StreamingResponse:
        caller, owner = _caller(request), sump_owner()
        redis = the_store().redis
        # "From now" is fixed when the request arrives, not at the first read.
        # `after` for clients that cannot set the header (the app's stream client).
        resume = request.headers.get("last-event-id") or request.query_params.get("after")
        after = await start_position(redis, resume)
        return event_stream(firings_after(redis, after, caller, owner))


#: How long one blocking read of the firings waits before reading again (ms).
FIRINGS_BLOCK_MS = 1000


async def start_position(redis: Any, last_event_id: str | None) -> str:
    """Where a stream starts: after `Last-Event-ID`, or after the latest firing now."""
    if last_event_id:
        return last_event_id
    last = await redis.xrevrange(FIRINGS, count=1)
    return _id(last[0][0]) if last else "0-0"


async def firings_after(
    redis: Any, after: str, caller: str, owner: str | None, block_ms: int = FIRINGS_BLOCK_MS
) -> AsyncIterator[ServerSentEvent]:
    """The firings after stream id `after` that `caller` may see."""
    position = after
    while True:
        replies = await redis.xread({FIRINGS: position}, block=block_ms, count=100)
        for _stream, entries in replies or []:
            for entry_id, fields in entries:
                position = _id(entry_id)
                firing = {_id(k): _id(v) for k, v in fields.items()}
                if firing.get("owner") == caller or (owner is not None and caller == owner):
                    yield ServerSentEvent(data=firing, event="firing", id=position)


def _id(value: Any) -> str:
    return value.decode() if isinstance(value, bytes) else str(value)
