"""log-sump's HTTP API, as this plugin reads it (v0.4.2,
`log_sump/server/routers/{catalog,records}.py`): `GET /catalog` and
`GET /records`, behind the `X-API-Key` header. The key is sent only to the
server it was given for, and never logged.
"""

from __future__ import annotations

from typing import Any

import httpx

#: How long one request to log-sump may take.
TIMEOUT_S = 20.0
#: Records per page (log-sump's maximum).
PAGE = 1000


class LogSumpError(Exception):
    """log-sump refused or could not be reached; the message never holds the key."""


class LogSumpClient:
    """One log-sump server, with one API key."""

    def __init__(
        self, url: str, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self.url = url.rstrip("/")
        self._key = api_key
        self._transport = transport

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        try:
            async with httpx.AsyncClient(
                base_url=self.url,
                headers={"X-API-Key": self._key},
                transport=self._transport,
                timeout=TIMEOUT_S,
            ) as http:
                response = await http.get(path, params=params)
        except httpx.HTTPError as exc:
            raise LogSumpError(
                f"log-sump at {self.url} is unreachable: {type(exc).__name__}"
            ) from None
        if response.status_code in (401, 403):
            raise LogSumpError(f"log-sump at {self.url} refused the API key")
        if response.status_code != 200:
            raise LogSumpError(f"log-sump at {self.url} answered {response.status_code}")
        return response.json()

    async def catalog(self) -> list[dict[str, Any]]:
        """The Docker hosts this key may read: `{id, host, enabled, watched_containers}`."""
        found = await self._get("/catalog")
        return [d for d in found if isinstance(d, dict)] if isinstance(found, list) else []

    async def records(
        self,
        docker_host: str,
        *,
        start: str,
        end: str,
        log_cursor: str | None = None,
        metric_cursor: str | None = None,
    ) -> dict[str, Any]:
        """One page of both kinds in `[start, end]`, after the cursors."""
        params: dict[str, Any] = {
            "docker_host": docker_host,
            "kind": "both",
            "start": start,
            "end": end,
            "limit": PAGE,
        }
        if log_cursor:
            params["log_cursor"] = log_cursor
        if metric_cursor:
            params["metric_cursor"] = metric_cursor
        page = await self._get("/records", params)
        return page if isinstance(page, dict) else {}
