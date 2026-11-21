"""SSE streams with a heartbeat (br-CONN-000009-sJpO9KMY, REQ-000007-sJpO9KMY
Requirement 1)."""

import asyncio

import httpx
import pytest
from fastapi import FastAPI

from correlate_sump.sse import (
    HEARTBEAT,
    STREAM_HEADERS,
    ServerSentEvent,
    event_stream,
    sse_frames,
)

TICK = 0.02


class Source:
    """An event source fed by the test, which records whether it was closed."""

    def __init__(self):
        self.queue: asyncio.Queue[ServerSentEvent | None] = asyncio.Queue()
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def aclose(self):
        self.closed = True


async def collect(frames, count):
    """The next `count` frames."""
    return [await anext(frames) for _ in range(count)]


def test_event_encoding():
    assert ServerSentEvent({"a": 1}).encode() == b'data: {"a": 1}\n\n'
    assert ServerSentEvent("x\ny", event="log", id="7").encode() == (
        b"event: log\nid: 7\ndata: x\ndata: y\n\n"
    )


async def test_quiet_stream_sends_heartbeats():
    source = Source()
    frames = sse_frames(source, heartbeat=TICK)
    assert await collect(frames, 3) == [HEARTBEAT] * 3
    await frames.aclose()


async def test_busy_stream_sends_no_heartbeat():
    source = Source()
    for n in range(5):
        source.queue.put_nowait(ServerSentEvent(n))
    source.queue.put_nowait(None)
    frames = sse_frames(source, heartbeat=10)
    out = [frame async for frame in frames]
    assert out == [ServerSentEvent(n).encode() for n in range(5)]


async def test_slow_event_survives_a_heartbeat():
    source = Source()
    frames = sse_frames(source, heartbeat=TICK)
    assert await anext(frames) == HEARTBEAT
    source.queue.put_nowait(ServerSentEvent("late"))
    frame = await anext(frames)
    while frame == HEARTBEAT:
        frame = await anext(frames)
    assert frame == ServerSentEvent("late").encode()
    await frames.aclose()


async def test_client_going_away_closes_the_source():
    source = Source()
    frames = sse_frames(source, heartbeat=TICK)
    await anext(frames)
    await frames.aclose()
    assert source.closed


async def test_invalid_heartbeat_refused():
    with pytest.raises(ValueError, match="heartbeat"):
        await anext(sse_frames(Source(), heartbeat=0))


async def test_event_stream_response():
    async def two():
        yield ServerSentEvent(1)
        yield ServerSentEvent(2)

    app = FastAPI()
    app.get("/stream")(lambda: event_stream(two()))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
        response = await client.get("/stream")
    assert response.headers["content-type"].startswith("text/event-stream")
    for name, value in STREAM_HEADERS.items():
        assert response.headers[name] == value
    assert response.content == b"data: 1\n\ndata: 2\n\n"
