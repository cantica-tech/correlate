"""A firing's artifacts on the Sump (REQ-000045-sJpO9KMY, br-EVENT-000005 and
br-EVENT-000006-sJpO9KMY, decision D7): made where the data is, so nothing
polls or downloads to make them.

- A **snapshot** is the N minutes before the firing, taken at once from the
  Sump's streams; a **recording** is the N minutes after it, pending until
  then (kept in Redis, so a restart does not lose it), completed from the
  streams, failed only if a full stream no longer holds its start.
  One recording at a time per event (decided in FEAT-000047-sJpO9KMY).
- Each is a `.recording` (`archive.py`) in the Sump's artifact folder, named
  by the Sump from its id alone, never from a request (cttc bug 27).
- Each is kept 24 h from its end; marked safe, for a chosen time of up to 30
  days; an hourly sweep removes the expired, file and record.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from correlate_sump.ingest import stream_key
from correlate_sump.segment import segment
from sump_plugin_events.archive import recording_bytes
from sump_plugin_events.engine import HOST_NAME, _text, watched_sources
from sump_plugin_events.model import Event

logger = logging.getLogger(__name__)

#: How long an artifact is kept by default, and at most when safe (ms).
TTL_MS = 24 * 3600 * 1000
MAX_KEEP_MS = 30 * 24 * 3600 * 1000
#: How often expired artifacts are swept (ms).
SWEEP_EVERY_MS = 3600 * 1000
#: The artifacts' ids, and each one's record.
INDEX = "sump:artifacts"
#: An artifact id: the Sump makes it, 16 hex digits; nothing else is a file name.
ARTIFACT_ID = re.compile(r"^[0-9a-f]{16}$")


def artifact_key(artifact_id: str) -> str:
    return f"sump:artifacts:{artifact_id}"


class ArtifactRefused(Exception):
    """A call on an artifact refused: its HTTP status and why."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class Artifacts:
    """The Sump's artifacts: records in Redis, files in `folder`."""

    def __init__(
        self,
        redis: Any,
        folder: Path,
        maxlen: int | None = None,
        hidden: Callable[[str, str], bool] | None = None,
    ) -> None:
        self.redis = redis
        #: An artifact leaves out what is hidden from its owner (br-STREAM-000007).
        self.hidden = hidden
        self.folder = folder
        #: The streams' cap: a full stream whose oldest record is later than a
        #: recording's start no longer holds it.
        self.maxlen = maxlen
        self.last_sweep = 0

    def path(self, artifact_id: str) -> Path:
        """The artifact's file, named by the Sump from its id alone."""
        if not ARTIFACT_ID.match(artifact_id):
            raise ArtifactRefused(404, f"no artifact {artifact_id}")
        return self.folder / f"{artifact_id}.recording"

    async def get(self, artifact_id: str) -> dict[str, Any] | None:
        if not ARTIFACT_ID.match(artifact_id):
            return None
        raw = await self.redis.get(artifact_key(artifact_id))
        return json.loads(_text(raw)) if raw is not None else None

    async def all(self) -> list[dict[str, Any]]:
        found = []
        for artifact_id in sorted(_text(i) for i in await self.redis.smembers(INDEX)):
            record = await self.get(artifact_id)
            if record is not None:
                found.append(record)
        return found

    async def of_event(self, event_id: str) -> list[dict[str, Any]]:
        """An event's artifacts, newest first."""
        mine = [a for a in await self.all() if a["event"] == event_id]
        return sorted(mine, key=lambda a: a["created_at"], reverse=True)

    async def _save(self, record: dict[str, Any]) -> None:
        await self.redis.set(artifact_key(record["id"]), json.dumps(record))
        await self.redis.sadd(INDEX, record["id"])

    async def on_firing(self, event: Event, at: int) -> tuple[str | None, str | None]:
        """Run `event`'s action for a firing at `at`: the artifact's id, and a note."""
        action = event.action
        if action.kind == "none":
            return None, None
        minutes_ms = int(action.minutes * 60_000)
        if action.kind == "recording":
            pending = [
                a
                for a in await self.of_event(event.id)
                if a["kind"] == "recording" and a["status"] == "pending"
            ]
            if pending:
                return None, "a recording of this event is still running"
            start, end = at, at + minutes_ms
        else:
            start, end = at - minutes_ms, at
        record = {
            "id": secrets.token_hex(8),
            "event": event.id,
            "event_name": event.name,
            "owner": event.owner,
            "kind": action.kind,
            "status": "pending",
            "stream": event.stream,
            "containers": list(event.containers),
            "host": event.host,
            "from": start,
            "to": end,
            "created_at": at,
            "expires_at": None,
            # Kept longer when the event says so (REQ-000046-sJpO9KMY).
            "safe": action.keep_days > 0,
            "keep_ms": int(action.keep_days * 24 * 3600 * 1000) or TTL_MS,
            "size": None,
            "reason": None,
            "note": None,
        }
        await self._save(record)
        if action.kind == "snapshot":
            await self._build(record, at)
        return record["id"], None

    async def complete_due(self, now: int) -> list[dict[str, Any]]:
        """Complete (or fail) every pending recording whose time is up."""
        done = []
        for record in await self.all():
            if record["status"] == "pending" and record["to"] <= now:
                await self._build(record, now)
                done.append(record)
        return done

    async def _lost_start(self, sources: list[str], start: int) -> bool:
        """Whether a full stream's oldest record is later than `start`: trimmed."""
        if not self.maxlen:
            return False
        for source in sources:
            for kind in ("metric", "log"):
                key = stream_key(source, kind)
                if await self.redis.xlen(key) < self.maxlen:
                    continue
                oldest = await self.redis.xrange(key, count=1)
                if not oldest:
                    continue
                fields = oldest[0][1]
                raw = fields.get(b"json", fields.get("json"))
                ts = json.loads(_text(raw)).get("ts") if raw is not None else None
                if ts and datetime.fromisoformat(ts).timestamp() * 1000 > start:
                    return True
        return False

    async def _build(self, record: dict[str, Any], now: int) -> None:
        """Write the artifact's file from the streams; complete, or failed with why."""
        stream, containers, host = record["stream"], record["containers"], record["host"]
        try:
            names = sorted(
                set(await watched_sources(self.redis, stream, containers, False, "metric"))
                | set(await watched_sources(self.redis, stream, containers, False, "log"))
            )
            host_source = f"{stream}/{HOST_NAME}" if host else None
            if self.hidden is not None:
                owner = str(record.get("owner", ""))
                names = [n for n in names if not self.hidden(n, owner)]
                if host_source and self.hidden(host_source, owner):
                    host_source = None
            if await self._lost_start(
                [*names, *([host_source] if host_source else [])], record["from"]
            ):
                if record["kind"] == "recording":
                    raise ValueError("the streams no longer hold the start of this recording")
                # A snapshot keeps what the streams still hold, and says so (Item 49).
                record["note"] = "shorter than asked: a stream no longer held its start"
            if not names and not host_source:
                raise ValueError("the stream has no data")
            data = await segment(
                self.redis,
                names,
                host=host_source,
                start=datetime.fromtimestamp(record["from"] / 1000, UTC),
                end=datetime.fromtimestamp(record["to"] / 1000, UTC),
            )
            created = datetime.fromtimestamp(now / 1000, UTC).isoformat()
            body = recording_bytes(data, created)
            self.folder.mkdir(parents=True, exist_ok=True)
            final = self.path(record["id"])
            temp = final.with_suffix(".tmp")
            temp.write_bytes(body)
            os.replace(temp, final)
            record.update(status="complete", size=len(body))
        except Exception as error:
            logger.warning("artifact %s failed: %s", record["id"], error)
            record.update(status="failed", reason=str(error))
        record["expires_at"] = now + int(record.get("keep_ms") or TTL_MS)
        await self._save(record)

    async def keep(self, artifact_id: str, keep_ms: int, caller: str, now: int) -> dict[str, Any]:
        """Mark an artifact safe: kept `keep_ms` from now, at most 30 days; its owner only."""
        record = await self.get(artifact_id)
        if record is None:
            raise ArtifactRefused(404, f"no artifact {artifact_id}")
        if record["owner"] != caller:
            raise ArtifactRefused(403, "only the event's owner can keep its artifacts")
        if not 0 < keep_ms <= MAX_KEEP_MS:
            raise ArtifactRefused(422, "an artifact is kept for more than 0 and at most 30 days")
        record.update(safe=True, expires_at=now + keep_ms)
        await self._save(record)
        return record

    async def sweep(self, now: int) -> list[str]:
        """Remove every expired artifact, file and record; their ids."""
        self.last_sweep = now
        gone = []
        for record in await self.all():
            if record["expires_at"] is not None and record["expires_at"] <= now:
                self.path(record["id"]).unlink(missing_ok=True)
                await self.redis.delete(artifact_key(record["id"]))
                await self.redis.srem(INDEX, record["id"])
                gone.append(record["id"])
        return gone

    async def tick(self, now: int) -> None:
        """The engine's tick: due recordings completed, the hourly sweep."""
        await self.complete_due(now)
        if now - self.last_sweep >= SWEEP_EVERY_MS:
            await self.sweep(now)


async def window_warnings(redis: Any, event: Event, maxlen: int | None) -> list[str]:
    """For a snapshot event: the watched streams whose cap, at their current
    rate, holds less than the event's window (Item 49, instead of a buffer)."""
    if not maxlen or event.action.kind != "snapshot":
        return []
    window_ms = event.action.minutes * 60_000
    sources = sorted(
        set(await watched_sources(redis, event.stream, event.containers, event.host, "metric"))
        | set(await watched_sources(redis, event.stream, event.containers, False, "log"))
    )
    warnings = []
    for source in sources:
        for kind in ("metric", "log"):
            key = stream_key(source, kind)
            count = await redis.xlen(key)
            if count < 2:
                continue
            first = await redis.xrange(key, count=1)
            last = await redis.xrevrange(key, count=1)
            span = _id_ms(last[0][0]) - _id_ms(first[0][0])
            if span <= 0:
                continue
            held_ms = maxlen * span / (count - 1)
            if held_ms < window_ms:
                warnings.append(
                    f"{source} {kind}s: about {held_ms / 60_000:.1f} of the "
                    f"{event.action.minutes:g} minutes are kept at the current rate"
                )
    return warnings


def _id_ms(entry_id: Any) -> int:
    """A stream entry id's time (ms)."""
    return int(_text(entry_id).split("-", 1)[0])
