"""Listing a Docker host's containers, the Sump's own left out
(REQ-000024-sJpO9KMY Requirement 3).

Ported from correlator's `sump-plugin-ssh` (log-sump's `BUG-0104`: its own
container showed in its own host's list). The Sump's container is found by
its container ID, which Docker gives the container as its host name; failing
that, by the compose service `sump` of a `correlate-sump…` project, the
names the app's provisioning and the development compose file use.
correlator matched its compose label only.
"""

from __future__ import annotations

import json
import re
import socket

from correlate_sump.datasource import ContainerRef
from correlate_sump.transport import TransportLike

#: A Docker short container ID, as a container's default host name.
_SHORT_ID = re.compile(r"^[0-9a-f]{12}$")
#: The compose service of the Sump, in every compose file the app writes.
SUMP_COMPOSE_SERVICE = "sump"
#: The compose projects the Sump runs in: `correlate-sump`,
#: `correlate-sump-local`, `correlate-sump-remote`.
SUMP_COMPOSE_PROJECT_PREFIX = "correlate-sump"


def own_container_id(hostname: str | None = None) -> str | None:
    """The Sump's own short container ID, when it runs in a container."""
    name = hostname if hostname is not None else socket.gethostname()
    return name if _SHORT_ID.match(name) else None


def _labels(data: dict[str, str]) -> dict[str, str]:
    pairs = (item.split("=", 1) for item in data.get("Labels", "").split(",") if "=" in item)
    return {key: value for key, value in pairs}


def is_own_sump_container(data: dict[str, str], own_id: str | None) -> bool:
    """Whether a `docker ps` row is the Sump's own container."""
    container_id = data.get("ID", "")
    if (
        own_id
        and container_id
        and (container_id.startswith(own_id) or own_id.startswith(container_id))
    ):
        return True
    labels = _labels(data)
    return labels.get("com.docker.compose.service") == SUMP_COMPOSE_SERVICE and labels.get(
        "com.docker.compose.project", ""
    ).startswith(SUMP_COMPOSE_PROJECT_PREFIX)


async def running_containers(
    transport: TransportLike, *, include_self: bool = False, own_id: str | None = None
) -> list[dict[str, str]]:
    """The running containers `transport` reaches, as `{id, name, image}`,
    the Sump's own left out unless `include_self`."""
    result = await transport.run(["docker", "ps", "--format", "{{json .}}"])
    result.check()
    me = own_id if own_id is not None else own_container_id()
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        data = json.loads(line)
        if not include_self and is_own_sump_container(data, me):
            continue
        if data["ID"] in seen:
            continue
        seen.add(data["ID"])
        rows.append({"id": data["ID"], "name": data["Names"], "image": data.get("Image", "")})
    return rows


async def list_containers(
    transport: TransportLike, *, include_self: bool = False, own_id: str | None = None
) -> list[ContainerRef]:
    """The running containers `transport` reaches, the Sump's own left out
    unless `include_self`."""
    rows = await running_containers(transport, include_self=include_self, own_id=own_id)
    return [ContainerRef(container_id=r["id"], container_name=r["name"]) for r in rows]
