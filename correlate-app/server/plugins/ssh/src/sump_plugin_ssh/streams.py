"""The SSH plugin's data streams (REQ-000025-sJpO9KMY Requirements 1 and 2).

The streams, their store and their rules are the core's
(`correlate_sump.streams`, br-PLUGIN-000010-sJpO9KMY); re-exported here for
this plugin's modules. What stays here is the SSH kind's own: parsing an SSH
target.

A data stream is a Docker host: "self" (the Sump's own host, through its
Docker socket, when detected) or one reached over SSH, identified by its SSH
user, host and port (`ssh:user@host:port`), so the same machine on two ports
is two streams with their own followed sets (br-STREAM-000005-sJpO9KMY). The
streams and their followed sets are kept in the Sump's data volume, owner-only
(decided in FEAT-000026-sJpO9KMY): collection goes on while the app is
closed, and resumes when the Sump restarts.
"""

from __future__ import annotations

import re

from correlate_sump.streams import (
    SELF_ID,
    Followed,
    StreamDef,
    StreamError,
    StreamStore,
    check_names,
)

__all__ = [
    "SELF_ID",
    "Followed",
    "StreamDef",
    "StreamError",
    "StreamStore",
    "check_names",
    "parse_target",
]

# The same checks as the app's SSH targets (`app/main/src/provision/plan.ts`).
_HOST = re.compile(
    r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*"
    r"|\[[0-9A-Fa-f:.]+\])$"
)
_USER = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$")


def parse_target(target: object, port: object) -> StreamDef:
    """An SSH stream from `user@host` and a port; `StreamError` if either is bad."""
    if not isinstance(target, str) or "@" not in target:
        raise StreamError("the target is user@host")
    user, host = target.rsplit("@", 1)
    if not _USER.match(user):
        raise StreamError(f"not a user name: {user!r}")
    if not _HOST.match(host):
        raise StreamError(f"not a host name: {host!r}")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise StreamError("the SSH port is a whole number from 1 to 65535")
    plain = host.strip("[]")
    return StreamDef(id=f"ssh:{user}@{host}:{port}", kind="ssh", user=user, host=plain, port=port)
