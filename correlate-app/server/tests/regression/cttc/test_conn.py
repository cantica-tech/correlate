"""Regression corpus of cttc's bugs: connection, startup and identity (CONN).

One test per cttc bug whose behavior the Sump owns (br-BUILD-000006-sJpO9KMY).
Each is a skipped placeholder until its roadmap item builds the code; then a
strict expected failure (`xfail(strict=True)`) until the code exists; then a
passing test. See README.md in this folder for the whole corpus.
"""

import fakeredis.aioredis
import httpx

from correlate_sump.app import create_app
from correlate_sump.sessions import token_key


async def test_cttc_bug_000011_corrupt_token_file_silently_regenerates_tokens() -> None:
    """cttc BUG-000011-uKKrzikI (Critical): Corrupt token file silently regenerates tokens.

    Breaks br-CONN-000004-sJpO9KMY (roadmap Item 11, RM-000012-sJpO9KMY). cttc
    read a corrupt token file as empty and minted new tokens over it, dropping
    every other gateway's token. Now a corrupt session record is refused with
    503, left exactly as it was, and every other user's session keeps working.
    """
    redis_client = fakeredis.aioredis.FakeRedis()
    app = create_app(redis_client=redis_client, env={}, start_ingest=False)
    async with app.router.lifespan_context(app):
        alice = await app.state.sessions.issue("alice")
        await redis_client.hset(token_key("corrupt"), mapping={"user": "bob"})
        before = await redis_client.hgetall(token_key("corrupt"))
        keys_before = sorted(await redis_client.keys("*"))
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
            corrupt = await client.get("/plugins", headers={"Authorization": "Bearer corrupt"})
            healthy = await client.get("/plugins", headers={"Authorization": f"Bearer {alice}"})
        assert corrupt.status_code == 503
        assert healthy.status_code == 200
        assert await redis_client.hgetall(token_key("corrupt")) == before
        assert sorted(await redis_client.keys("*")) == keys_before
