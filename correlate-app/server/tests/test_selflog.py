"""The Sump's own log for Ship Logs (REQ-000049-sJpO9KMY, br-DIAG-000002):
its container log through Docker, else its own recent lines; its owner only."""

from __future__ import annotations

import logging
from pathlib import Path

import fakeredis.aioredis
import httpx
from cryptography.hazmat.primitives.asymmetric import ed25519

from correlate_sump.app import create_app
from correlate_sump.selflog import RECENT_LINES, RecentLines, install, own_log
from correlate_sump.sshsig import LOGIN_NAMESPACE, public_key_of, sign


def test_recent_lines_keep_the_last_ones_formatted() -> None:
    logger = logging.getLogger("selflog-test")
    logger.propagate = False
    handler = RecentLines(size=3)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    for i in range(5):
        logger.info("line %d", i)
    assert [line.split(" INFO selflog-test: ")[1] for line in handler.lines] == [
        "line 2",
        "line 3",
        "line 4",
    ]
    assert install(logger) is handler  # once per logger


async def test_the_container_log_through_docker_when_its_socket_is_there(tmp_path: Path) -> None:
    sock = tmp_path / "docker.sock"
    sock.touch()
    asked: list[list[str]] = []

    async def run(args: list[str]) -> tuple[int, str]:
        asked.append(args)
        return 0, "INFO:correlate_sump.app:ready\n"

    out = await own_log(RecentLines(), run, socket_path=sock, container="abc123")
    assert out == "INFO:correlate_sump.app:ready\n"
    assert asked == [["docker", "logs", "--tail", str(RECENT_LINES), "abc123"]]


async def test_its_own_lines_without_a_socket_or_when_docker_refuses(tmp_path: Path) -> None:
    recent = RecentLines()
    recent.lines.extend(["one", "two"])

    async def refuses(args: list[str]) -> tuple[int, str]:
        return 1, "permission denied"

    without = await own_log(recent, refuses, socket_path=tmp_path / "none")
    assert without.endswith("one\ntwo\n")
    assert without.startswith("# The Sump's own recent lines")
    sock = tmp_path / "docker.sock"
    sock.touch()
    assert (await own_log(recent, refuses, socket_path=sock)).endswith("one\ntwo\n")


async def test_only_the_sumps_owner_gets_its_log(tmp_path: Path) -> None:
    app = create_app(
        redis_client=fakeredis.aioredis.FakeRedis(),
        env={"SUMP_DATA_DIR": str(tmp_path)},
        start_ingest=False,
    )
    owner, other = ed25519.Ed25519PrivateKey.generate(), ed25519.Ed25519PrivateKey.generate()
    app.state.users.set_owner("alice", public_key_of(owner).line())
    app.state.users.add_key("bob", public_key_of(other).line())
    transport = httpx.ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://sump") as http,
    ):

        async def token(user: str, key: ed25519.Ed25519PrivateKey) -> dict[str, str]:
            c = (await http.post("/session/challenge", json={"user": user})).json()["challenge"]
            body = {
                "user": user,
                "challenge": c,
                "signature": sign(key, c.encode(), LOGIN_NAMESPACE),
            }
            login = await http.post("/session/login", json=body)
            return {"Authorization": f"Bearer {login.json()['token']}"}

        assert (await http.get("/logs/sump")).status_code == 401
        assert (await http.get("/logs/sump", headers=await token("bob", other))).status_code == 403
        got = await http.get("/logs/sump", headers=await token("alice", owner))
        assert got.status_code == 200
        assert got.headers["content-type"].startswith("text/plain")
