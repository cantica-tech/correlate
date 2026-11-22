"""Promoting a data stream to a secondary Sump (br-FED-000001-sJpO9KMY,
REQ-000052-sJpO9KMY step 1): a Sump provisioned on the stream's host
through the parent's SSH access, as the app provisions one
(`app/main/src/provision/remote.ts`), but from the parent.

On the host: Docker checked; the parent's own image pulled; the compose file
written to `~/.correlate-sump-secondary/` (its own project and loopback ports,
beside any Sump already there); the Sump started and waited for; the person
who promotes made its owner, and the parent added as a user. Any failure
takes down what was started and removes the folder, so nothing is left
running and the parent keeps collecting the stream.

Commands go through the transport as argument lists or one `sh -c` script
built from constants and checked values; keys and the compose file travel as
base64, which holds no character a shell reads.
"""

from __future__ import annotations

import asyncio
import base64
import re
import shlex
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

#: Where the secondary's compose file goes on the host, and its project.
SECONDARY_DIR = "~/.correlate-sump-secondary"
SECONDARY_PROJECT = "correlate-sump-secondary"
#: The secondary's loopback ports on the host: the Sump and its log input.
SECONDARY_PORT = 8775
SECONDARY_FLUENT_PORT = 5150
DOCKER_SOCKET = "/var/run/docker.sock"
#: A user name on a Sump, as `correlate_sump.users` accepts.
_USER = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
#: An image reference: no shell character.
_IMAGE = re.compile(r"^[A-Za-z0-9._/:@-]{1,255}$")


class PromoteError(Exception):
    """A promotion that failed: the step, and why."""

    def __init__(self, step: str, message: str) -> None:
        super().__init__(f"{step}: {message}")
        self.step = step
        self.message = message


class ShellLike(Protocol):
    """The part of the SSH transport a promotion uses."""

    async def run(self, args: list[str]) -> Any: ...

    async def docker_prefix(self) -> list[str]: ...


@dataclass
class Secondary:
    """A secondary Sump, as its parent keeps it."""

    host: str
    ssh_port: int
    ssh_user: str
    sump_port: int
    owner: str
    parent_user: str
    promoted_at: int


def compose_file(image: str, port: int, socket_group: int, fluent_port: int) -> str:
    """The secondary's compose file: every port on the host's loopback only."""
    return "\n".join(
        [
            "# Written by a parent Sump (REQ-000052-sJpO9KMY); every port is loopback only.",
            "services:",
            "  sump:",
            f"    image: {image}",
            "    restart: unless-stopped",
            "    ports:",
            f'      - "127.0.0.1:{port}:8765"',
            f'      - "127.0.0.1:{fluent_port}:5140"',
            "    environment:",
            "      SUMP_DATA_DIR: /var/lib/correlate-sump",
            "    group_add:",
            f'      - "{socket_group}"',
            "    volumes:",
            "      - sump-data:/var/lib/correlate-sump",
            f"      - {DOCKER_SOCKET}:{DOCKER_SOCKET}",
            "volumes:",
            "  sump-data:",
            "",
        ]
    )


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


async def provision_secondary(
    shell: ShellLike,
    *,
    image: str,
    owner: str,
    owner_key: str,
    parent_user: str,
    parent_key: str,
    port: int = SECONDARY_PORT,
    fluent_port: int = SECONDARY_FLUENT_PORT,
    health_timeout: float = 60.0,
    poll: float = 2.0,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    """Provision the secondary on `shell`'s host, or leave nothing behind."""
    for name, value in (("owner", owner), ("parent", parent_user)):
        if not _USER.match(value):
            raise PromoteError("check", f"{name} {value!r} is not a user name")
    if not _IMAGE.match(image):
        raise PromoteError("check", f"{image!r} is not an image")
    docker = " ".join(shlex.quote(a) for a in await shell.docker_prefix())
    compose = f"{docker} compose -f {SECONDARY_DIR}/docker-compose.yml -p {SECONDARY_PROJECT}"
    img = shlex.quote(image)

    async def must(step: str, script: str) -> str:
        result = await shell.run(["sh", "-c", script])
        if result.returncode != 0:
            raise PromoteError(step, (result.stderr or result.stdout).strip()[:500] or "failed")
        return str(result.stdout)

    started = False
    try:
        await must(
            "check Docker on the host", f"{docker} version --format '{{{{.Server.Version}}}}'"
        )
        await must(
            "get the Sump's image",
            f"{docker} image inspect {img} >/dev/null 2>&1 || {docker} pull {img}",
        )
        group_out = await must(
            "find the Docker socket's group",
            f"{docker} run --rm --entrypoint stat -v {DOCKER_SOCKET}:{DOCKER_SOCKET} "
            f"{img} -c %g {DOCKER_SOCKET}",
        )
        group = group_out.strip()
        if not group.isdigit():
            raise PromoteError(
                "find the Docker socket's group", f"expected a group ID, got {group[:80]!r}"
            )
        text = compose_file(image, port, int(group), fluent_port)
        await must(
            "write the compose file",
            f"mkdir -p {SECONDARY_DIR} && printf %s {_b64(text)} | base64 -d "
            f"> {SECONDARY_DIR}/docker-compose.yml",
        )
        started = True
        await must("start the Sump", f"{compose} up -d")
        probe = (
            "import json,urllib.request;"
            "print(json.load(urllib.request.urlopen('http://127.0.0.1:8765/health'))['redis'])"
        )
        waited = 0.0
        while True:
            result = await shell.run(
                ["sh", "-c", f"{compose} exec -T sump python -c {shlex.quote(probe)}"]
            )
            if result.returncode == 0 and str(result.stdout).strip() == "True":
                break
            if waited >= health_timeout:
                raise PromoteError("wait for the Sump", "no healthy answer on the host")
            await sleep(poll)
            waited += poll
        users = f"{compose} exec -T sump python -m correlate_sump.users"
        await must(
            "make you its owner",
            f"printf %s {_b64(owner_key)} | base64 -d | {users} set-owner --user {owner}",
        )
        await must(
            "add the parent as a user",
            f"printf %s {_b64(parent_key)} | base64 -d | {users} add-key --user {parent_user}",
        )
    except Exception:
        if started:
            await shell.run(["sh", "-c", f"{compose} down -v --rmi local; rm -rf {SECONDARY_DIR}"])
        raise
