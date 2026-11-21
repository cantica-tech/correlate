"""Smoke test of the Sump container (REQ-000004-sJpO9KMY Requirement 5).

Needs Docker and a running stack, so it is not part of `task check` or CI:
run it with `task server:smoke`, which starts the stack, sets `SUMP_SMOKE=1`,
runs this file and stops the stack. A record sent to the Fluent Bit port must
come back from `GET /records`, and `/health` must report Redis up. The test
makes itself the Sump's owner with a fresh Ed25519 key (the owner command run
inside the container, as provisioning will) and logs in with an `SSHSIG`
signature (br-CONN-000007-sJpO9KMY).
"""

import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from functools import cache

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519

from correlate_sump.sshsig import LOGIN_NAMESPACE, public_key_of, sign

pytestmark = pytest.mark.skipif(
    os.environ.get("SUMP_SMOKE") != "1", reason="container smoke test: run `task server:smoke`"
)

API = f"http://127.0.0.1:{os.environ.get('SUMP_PORT', '8765')}"
FLUENT_PORT = int(os.environ.get("SUMP_FLUENT_PORT", "5140"))


KEY = ed25519.Ed25519PrivateKey.generate()


def post(path: str, body: dict) -> dict:
    request = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


@cache
def token() -> str:
    """Become the owner, then log in with an SSHSIG signature (br-CONN-000007)."""
    command = ["docker", "compose", "exec", "-T", "sump"]
    command += ["python", "-m", "correlate_sump.users", "set-owner", "--user", "smoke"]
    subprocess.run(
        [*command, "--replace"],
        input=public_key_of(KEY).line(),
        check=True,
        text=True,
        capture_output=True,
    )
    challenge = post("/session/challenge", {"user": "smoke"})["challenge"]
    signature = sign(KEY, challenge.encode(), LOGIN_NAMESPACE)
    login = post(
        "/session/login", {"user": "smoke", "challenge": challenge, "signature": signature}
    )
    return login["token"]


def get(path: str, **params: str) -> dict:
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    request = urllib.request.Request(f"{API}{path}{query}")
    if path != "/health":
        request.add_header("Authorization", f"Bearer {token()}")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def wait_for_health(timeout: float = 60) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        try:
            health = get("/health")
            if health["redis"]:
                return health
        except OSError:
            pass
        if time.monotonic() > deadline:
            raise AssertionError("the Sump did not become healthy in time")
        time.sleep(1)


def test_health_reports_redis_up() -> None:
    assert wait_for_health()["status"] == "ok"


def test_records_need_a_token() -> None:
    wait_for_health()
    request = urllib.request.Request(f"{API}/plugins")
    try:
        urllib.request.urlopen(request, timeout=5)
    except urllib.error.HTTPError as error:
        assert error.code == 401
    else:
        raise AssertionError("/plugins answered without a token")


def test_record_through_fluent_bit_comes_back() -> None:
    wait_for_health()
    ts = datetime.now(UTC).isoformat()
    marker = f"smoke-{time.time_ns()}"
    record = {"kind": "log", "source": "smoke", "ts": ts, "message": marker}
    with socket.create_connection(("127.0.0.1", FLUENT_PORT), timeout=5) as sock:
        sock.sendall(json.dumps(record).encode() + b"\n")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        body = get("/records", source="smoke", kind="log", **{"from": ts, "to": ts})
        if any(r["message"] == marker for r in body["records"]):
            return
        time.sleep(1)
    raise AssertionError("the record sent to Fluent Bit never reached /records")
