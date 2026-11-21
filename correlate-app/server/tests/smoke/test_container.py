"""Smoke test of the Sump container (REQ-000004-sJpO9KMY Requirement 5).

Needs Docker and a running stack, so it is not part of `task check` or CI:
run it with `task server:smoke`, which starts the stack, sets `SUMP_SMOKE=1`,
runs this file and stops the stack. A record sent to the Fluent Bit port must
come back from `GET /records`, and `/health` must report Redis up.
"""

import json
import os
import socket
import time
import urllib.parse
import urllib.request
from datetime import UTC, datetime

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("SUMP_SMOKE") != "1", reason="container smoke test: run `task server:smoke`"
)

API = f"http://127.0.0.1:{os.environ.get('SUMP_PORT', '8765')}"
FLUENT_PORT = int(os.environ.get("SUMP_FLUENT_PORT", "5140"))


def get(path: str, **params: str) -> dict:
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    with urllib.request.urlopen(f"{API}{path}{query}", timeout=5) as response:
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
