"""Polling a log-sump stream's records into the Sump, each once
(br-STREAM-000011-sJpO9KMY; adapted from correlator's `relay.py`).

log-sump pages `/records` by its Redis entry ids and gives no cursor once a
page is short, so a poll reads a time window instead: from where the last
one ended, less 30 s (records still arriving there), to now; paged by its
cursors within it. What the last poll already had is dropped by its key
(`translate.seen_key`); the window's end and this poll's keys are kept, so
a restart neither loses nor repeats a record. The first poll starts when the
stream was added.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any

from sump_plugin_logsump.client import LogSumpClient
from sump_plugin_logsump.translate import followed_name, seen_key, translate

logger = logging.getLogger(__name__)

#: How far a poll reaches back into the last one's window.
OVERLAP = timedelta(seconds=30)
#: Pages one poll reads at most (1000 records each).
MAX_PAGES = 100


def _iso(at: datetime) -> str:
    return at.isoformat()


async def poll_once(
    client: LogSumpClient,
    stream_id: str,
    entry: dict[str, Any],
    followed: set[str],
    ingest: Callable[[dict[str, Any]], Awaitable[Any]],
    now: datetime,
) -> dict[str, Any]:
    """Read one window of `entry`'s Docker host and ingest what is followed;
    the entry's new place (`since`, `seen`). Raises `LogSumpError`."""
    since = datetime.fromisoformat(str(entry["since"]))
    first = datetime.fromisoformat(str(entry.get("start_at", entry["since"])))
    start = max(since - OVERLAP, first)
    already = set(entry.get("seen", []))
    keys: list[str] = []
    got = set()
    log_cursor: str | None = None
    metric_cursor: str | None = None
    for _ in range(MAX_PAGES):
        page = await client.records(
            str(entry["docker_host"]),
            start=_iso(start),
            end=_iso(now),
            log_cursor=log_cursor,
            metric_cursor=metric_cursor,
        )
        for record in page.get("records", []):
            if not isinstance(record, dict):
                continue
            key = seen_key(record)
            if key in got:
                continue
            # Every record of this window is remembered, brought now or before:
            # the next window starts inside this one.
            got.add(key)
            keys.append(key)
            if key in already:
                continue
            name = followed_name(record)
            # The host's own figures whenever anything is followed, as for SSH.
            if (name is None and followed) or (name is not None and name in followed):
                translated = translate(stream_id, record)
                if translated is not None:
                    await ingest(translated)
        log_cursor = page.get("next_log_cursor")
        metric_cursor = page.get("next_metric_cursor")
        if not log_cursor and not metric_cursor:
            break
    else:
        logger.warning(
            "logsump: %s read %d pages in one poll; the rest next time", stream_id, MAX_PAGES
        )
    return {"since": _iso(now), "seen": keys}
