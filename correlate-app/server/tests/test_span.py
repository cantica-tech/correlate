"""REQ-000031-sJpO9KMY Requirement 3: the time range of some sources, for
the live view's navigator."""

import json
from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import httpx
import pytest

from correlate_sump.app import create_app
from correlate_sump.ingest import stream_key
from correlate_sump.records import QueryError
from correlate_sump.span import data_range

T0 = datetime(2026, 11, 21, 18, 0, tzinfo=UTC)


async def held() -> fakeredis.aioredis.FakeRedis:
    redis = fakeredis.aioredis.FakeRedis()
    rows = [("self/web", "log", 10), ("self/web", "metric", 5), ("self/db", "log", 30)]
    for source, kind, seconds in rows:
        for extra in (0, 2):
            ts = (T0 + timedelta(seconds=seconds + extra)).isoformat()
            record = {"kind": kind, "source": source, "ts": ts}
            await redis.xadd(stream_key(source, kind), {"json": json.dumps(record)})
    return redis


async def test_spans_every_kind_of_every_source_asked() -> None:
    redis = await held()
    assert await data_range(redis, ["self/web"]) == {
        "from": (T0 + timedelta(seconds=5)).isoformat(),
        "to": (T0 + timedelta(seconds=12)).isoformat(),
    }
    both = await data_range(redis, ["self/web", "self/db"])
    assert both["to"] == (T0 + timedelta(seconds=32)).isoformat()
    assert await data_range(redis, ["self/none"]) == {"from": None, "to": None}


@pytest.mark.parametrize("sources", [[], ["x"] * 201, [""], ["x" * 401]])
async def test_refuses_bad_sources(sources: list[str]) -> None:
    with pytest.raises(QueryError):
        await data_range(fakeredis.aioredis.FakeRedis(), sources)


async def test_the_route_answers_behind_the_session() -> None:
    app = create_app(redis_client=await held(), env={}, start_ingest=False)
    async with app.router.lifespan_context(app):
        token = await app.state.sessions.issue("alice")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
            query = {"sources": "self/web,self/db"}
            assert (await client.get("/records/range", params=query)).status_code == 401
            auth = {"Authorization": f"Bearer {token}"}
            answer = await client.get("/records/range", params=query, headers=auth)
            assert answer.json()["from"] == (T0 + timedelta(seconds=5)).isoformat()
            bad = await client.get("/records/range", params={"sources": ""}, headers=auth)
            assert bad.status_code == 422
