"""The events' HTTP API (REQ-000044-sJpO9KMY, br-EVENT-000007-sJpO9KMY).

Behind the Sump's session guard: every call has a user, the D3 identity.

- `GET /events`: the caller's events (all of them for the Sump's owner).
- `POST /events`: a new event, the caller's; refused (422) if the engine
  could not evaluate it.
- `GET /events/{id}`: one event the caller sees.
- `PUT /events/{id}`: an edit, based on `version`; the event's owner only
  (403); a stale version refused (409), never overwritten.
- `DELETE /events/{id}?version=N`: the event's owner, or the Sump's owner;
  its firings stay.
- `POST /events/{id}/reset`: re-arm it; the event's owner only.

An event another user owns is answered as not found (404), unless the caller
is the Sump's owner.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Annotated, Any

from fastapi import Body, HTTPException, Query, Request

from sump_plugin_events.engine import EventRefused, EventStore, visible
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
) -> None:
    """Add the events' routes to `app`; `store` is None until the plugin runs."""

    def the_store() -> EventStore:
        found = store()
        if found is None:
            raise HTTPException(status_code=503, detail="the event engine is not running")
        return found

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
        return event.to_json()

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
        return event.to_json()

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
