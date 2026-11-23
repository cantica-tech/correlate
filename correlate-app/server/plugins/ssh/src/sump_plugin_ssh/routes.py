"""The SSH plugin's own stream routes, behind the Sump's session; the data
streams' routes are the core's (`correlate_sump.stream_routes`,
br-PLUGIN-000010-sJpO9KMY):

- `POST /streams/{id}/promote` (`owner_key`): promote an SSH stream to a
  secondary Sump on its host (br-FED-000001, REQ-000052-sJpO9KMY); the
  Sump's owner only.
- `GET /streams/{id}/secondary`: the secondary, and whether it answers the
  parent (br-FED-000002).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, Request
from pydantic import BaseModel

from correlate_sump.stream_routes import request_user, visible
from sump_plugin_ssh.promote import PromoteError

if TYPE_CHECKING:
    from sump_plugin_ssh.plugin import SumpPluginSSH

logger = logging.getLogger(__name__)


class Promote(BaseModel):
    #: The promoting user's public key (an OpenSSH line): the secondary's owner's.
    owner_key: str


def add_promote_routes(app: Any, plugin: SumpPluginSSH) -> None:
    """Add promotion's routes to the Sump's app."""

    @app.post("/streams/{stream_id}/promote")
    async def promote_stream(stream_id: str, body: Promote, request: Request) -> dict[str, Any]:
        """Promote an SSH stream to a secondary Sump on its host (br-FED-000001,
        REQ-000052-sJpO9KMY); this Sump's owner only, who owns the secondary."""
        user = request_user(request)
        visible(plugin.registry(), stream_id, user)
        if not user or user != plugin.sump_owner():
            raise HTTPException(status_code=403, detail="only the Sump's owner can promote")
        try:
            return {"secondary": await plugin.promote_stream(stream_id, user, body.owner_key)}
        except PromoteError as exc:
            status = 409 if exc.step == "check" else 502
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @app.get("/streams/{stream_id}/secondary")
    async def secondary_status(stream_id: str, request: Request) -> dict[str, Any]:
        """A promoted stream's secondary, and whether it answers the parent
        now through its forward (br-FED-000002, REQ-000052-sJpO9KMY)."""
        visible(plugin.registry(), stream_id, request_user(request))
        secondary = plugin.store().secondary(stream_id)
        client = plugin.secondary_client(stream_id)
        if secondary is None or client is None:
            raise HTTPException(status_code=404, detail=f"{stream_id} is not promoted")
        return {"secondary": secondary, **(await client.check())}
