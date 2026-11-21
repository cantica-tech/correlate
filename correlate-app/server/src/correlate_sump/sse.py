"""Server-sent event streams with a heartbeat (br-CONN-000009-sJpO9KMY).

Every SSE endpoint of the Sump answers with `event_stream(source)`. While the
source has nothing to send, the stream writes a comment line (`: keep-alive`)
every `HEARTBEAT_SECONDS`, so the app can tell a quiet but healthy stream
from a dead one: it closes a stream that sends no bytes for 45 seconds
(br-CONN-000005-sJpO9KMY). When the client goes away, the source is closed.

The heartbeat interval is a parameter, so tests run in milliseconds.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi.responses import StreamingResponse

#: Longest quiet time between two writes on a stream (br-CONN-000009).
HEARTBEAT_SECONDS = 15.0

#: The comment line written when a stream has been quiet for the interval.
HEARTBEAT = b": keep-alive\n\n"

#: Headers that stop caches and proxies from holding events back.
STREAM_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@dataclass(frozen=True)
class ServerSentEvent:
    """One event: `data` is sent as is when a string, as JSON otherwise.

    `event` names the event type and `id` its position, both optional.
    """

    data: Any
    event: str | None = None
    id: str | None = None

    def encode(self) -> bytes:
        """The event in SSE wire format, ending with its blank line."""
        text = self.data if isinstance(self.data, str) else json.dumps(self.data)
        lines = []
        if self.event is not None:
            lines.append(f"event: {self.event}")
        if self.id is not None:
            lines.append(f"id: {self.id}")
        lines.extend(f"data: {line}" for line in text.split("\n"))
        return ("\n".join(lines) + "\n\n").encode()


async def sse_frames(
    source: AsyncIterator[ServerSentEvent],
    heartbeat: float = HEARTBEAT_SECONDS,
) -> AsyncGenerator[bytes]:
    """Encode the source's events, adding a heartbeat whenever it is quiet.

    The source's pending `__anext__` survives a heartbeat (it is not
    cancelled), so an event that takes longer than the interval is not lost.
    Closing this iterator cancels that pending read and closes the source.
    """
    if heartbeat <= 0:
        raise ValueError(f"heartbeat must be a positive number of seconds, got {heartbeat!r}")
    pending: asyncio.Task[ServerSentEvent] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(source))
            done, _ = await asyncio.wait({pending}, timeout=heartbeat)
            if not done:
                yield HEARTBEAT
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                return
            finally:
                pending = None
            yield event.encode()
    finally:
        if pending is not None:
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                await pending
        aclose = getattr(source, "aclose", None)
        if aclose is not None:
            await aclose()


def event_stream(
    source: AsyncIterator[ServerSentEvent],
    heartbeat: float = HEARTBEAT_SECONDS,
) -> StreamingResponse:
    """The response every Sump SSE endpoint returns (br-CONN-000009)."""
    return StreamingResponse(
        sse_frames(source, heartbeat),
        media_type="text/event-stream",
        headers=STREAM_HEADERS,
    )
