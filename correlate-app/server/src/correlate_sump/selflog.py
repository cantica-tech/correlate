"""The Sump's own log, for Ship Logs (br-DIAG-000002-sJpO9KMY,
REQ-000049-sJpO9KMY; cttc's `GET /mlog` and `gather_own_container_logs`).

As cttc's, the Sump's container log, read through the Docker socket the Sump
is provisioned with (`docker logs --tail`), its container being its own
hostname; where it has no socket (or Docker refuses), its own last lines,
kept in memory by a logging handler from the start. Either way the last
`RECENT_LINES` lines (decided in FEAT-000051-sJpO9KMY).
"""

from __future__ import annotations

import asyncio
import logging
import socket
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path

#: How many lines the Sump's own log holds.
RECENT_LINES = 10_000
#: Where the Docker socket is mounted into the Sump's container.
DOCKER_SOCKET = Path("/var/run/docker.sock")

#: Runs a command; its exit code and its output (stdout and stderr merged).
Runner = Callable[[list[str]], Awaitable[tuple[int, str]]]


class RecentLines(logging.Handler):
    """The last `RECENT_LINES` log lines of this process, formatted."""

    def __init__(self, size: int = RECENT_LINES) -> None:
        super().__init__()
        self.lines: deque[str] = deque(maxlen=size)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.lines.append(self.format(record))
        except Exception:  # a log line must never break the Sump
            self.handleError(record)


def install(root: logging.Logger | None = None) -> RecentLines:
    """Keep the process's log lines from now on (once per logger)."""
    target = root or logging.getLogger()
    for handler in target.handlers:
        if isinstance(handler, RecentLines):
            return handler
    handler = RecentLines()
    target.addHandler(handler)
    return handler


async def _run(args: list[str]) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    return proc.returncode or 0, out.decode(errors="replace")


async def own_log(
    recent: RecentLines,
    run: Runner = _run,
    socket_path: Path = DOCKER_SOCKET,
    container: str | None = None,
) -> str:
    """The Sump's own log: its container's, or its own recent lines."""
    if await asyncio.to_thread(socket_path.exists):
        name = container or socket.gethostname()
        try:
            code, out = await run(["docker", "logs", "--tail", str(RECENT_LINES), name])
        except OSError:
            code, out = 1, ""
        if code == 0:
            return out
    lines = "\n".join(recent.lines)
    return f"# The Sump's own recent lines (its container log was not readable).\n{lines}\n"
