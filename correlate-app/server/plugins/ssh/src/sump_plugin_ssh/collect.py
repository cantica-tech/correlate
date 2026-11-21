"""Collection (REQ-000025-sJpO9KMY Requirement 3): the followed containers'
and services' logs, and the containers' stats, written as records.

As cttc's gateway did, but in the Sump (decided in FEAT-000026-sJpO9KMY):

- One log follower per followed container (`docker logs -f --timestamps`)
  or service (`docker service logs -f --timestamps --raw`), from now, or from
  its last line after a drop; each line a `log` record. A follower that
  ends (a container stopped, a host away) is tried again after 5 s for as
  long as it is followed.
- One stats poll per stream that follows containers: `docker stats
  --no-stream` every 5 s, each followed container a `metric` record.
- One host reader per stream that follows anything (REQ-000032-sJpO9KMY):
  a loop on the host printing its `/proc` figures every 5 s
  (`sump_plugin_ssh.host`), each sample a `metric` record of
  `<stream>/__host__`; it starts and stops with the stream's collection and
  is tried again after 5 s when it ends.

`apply` makes one stream's running followers exactly its followed set
(br-STREAM-000002-sJpO9KMY); other streams are untouched. Records go to the
Sump's record store through its ingest adapter, `source` `<stream>/<name>`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from correlate_sump.transport import Transport
from sump_plugin_ssh.host import BEGIN, END, host_record, parse_sample
from sump_plugin_ssh.streams import Followed

logger = logging.getLogger(__name__)

#: How often stats are read, and how long before a lost follower retries:
#: cttc's 5 s.
STATS_EVERY_S = 5.0
RETRY_AFTER_S = 5.0

#: Stores one raw record; the Sump's `IngestAdapter.ingest`.
Sink = Callable[[bytes], Awaitable[bool]]
#: The transport of a stream, or None while it cannot be reached.
TransportFor = Callable[[str], Transport | None]
#: How to read a stream's host: its transport, the reader's command, and the
#: host's name for the records; None when it cannot be read now.
HostReaderFor = Callable[[str], Awaitable[tuple[Transport, list[str], str] | None]]

_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d) ?(.*)$", re.S)
_SIZE = re.compile(r"^\s*([\d.]+)\s*([A-Za-z]*)\s*$")
_UNITS = {
    "": 1,
    "b": 1,
    "kb": 1000,
    "mb": 1000**2,
    "gb": 1000**3,
    "tb": 1000**4,
    "kib": 1024,
    "mib": 1024**2,
    "gib": 1024**3,
    "tib": 1024**4,
}


def split_timestamp(line: str) -> tuple[str, str] | None:
    """`docker logs --timestamps`' `<RFC 3339 time> <text>`, as an ISO time
    Python reads (microseconds at most) and the text; None without a time."""
    m = _TS.match(line)
    if not m:
        return None
    base, fraction, zone, text = m.groups()
    micro = (fraction or "0")[:6].ljust(6, "0")
    zone = "+00:00" if zone == "Z" else zone
    return f"{base}.{micro}{zone}", text


def size_bytes(text: str) -> int | None:
    """A Docker size ("1.5MiB", "12kB", "0B") in bytes; None if unreadable."""
    m = _SIZE.match(text)
    if not m or m.group(2).lower() not in _UNITS:
        return None
    return round(float(m.group(1)) * _UNITS[m.group(2).lower()])


def _pair(text: str) -> tuple[int | None, int | None]:
    left, _, right = text.partition("/")
    return size_bytes(left), size_bytes(right)


def stats_record(stream_id: str, row: dict[str, str], ts: str) -> dict[str, object]:
    """One `docker stats` row as a `metric` record."""
    mem_used, mem_limit = _pair(row.get("MemUsage", ""))
    net_rx, net_tx = _pair(row.get("NetIO", ""))
    block_read, block_write = _pair(row.get("BlockIO", ""))
    cpu = row.get("CPUPerc", "").rstrip("%")
    pids = row.get("PIDs", "")
    return {
        "kind": "metric",
        "source": f"{stream_id}/{row['Name']}",
        "ts": ts,
        "container": row["Name"],
        "cpu_percent": float(cpu) if cpu.replace(".", "", 1).isdigit() else None,
        "mem_used_bytes": mem_used,
        "mem_limit_bytes": mem_limit,
        "net_rx_bytes": net_rx,
        "net_tx_bytes": net_tx,
        "block_read_bytes": block_read,
        "block_write_bytes": block_write,
        "pids": int(pids) if pids.isdigit() else None,
    }


def _now() -> datetime:
    return datetime.now(UTC)


class Collection:
    """The Sump's running followers and stats polls, per stream."""

    def __init__(
        self,
        sink: Sink,
        transport_for: TransportFor,
        *,
        stats_every: float = STATS_EVERY_S,
        retry_after: float = RETRY_AFTER_S,
        now: Callable[[], datetime] = _now,
        host_reader: HostReaderFor | None = None,
    ) -> None:
        self._sink = sink
        self._transport_for = transport_for
        self._stats_every = stats_every
        self._retry_after = retry_after
        self._now = now
        self._host_reader = host_reader
        self._followed: dict[str, Followed] = {}
        self._tasks: dict[tuple[str, str, str], asyncio.Task[None]] = {}

    def running(self) -> list[tuple[str, str, str]]:
        """What runs: `(stream, "container" | "service" | "stats" | "host", name)`."""
        return sorted(key for key, task in self._tasks.items() if not task.done())

    def apply(self, stream_id: str, followed: Followed) -> None:
        """Make `stream_id`'s followers exactly `followed`; others untouched."""
        self._followed[stream_id] = followed
        wanted = {(stream_id, "container", n) for n in followed.containers}
        wanted |= {(stream_id, "service", n) for n in followed.services}
        if followed.containers:
            wanted.add((stream_id, "stats", ""))
        if self._host_reader is not None and (followed.containers or followed.services):
            wanted.add((stream_id, "host", ""))
        mine = {key for key in self._tasks if key[0] == stream_id}
        for key in sorted(mine - wanted):
            logger.info("collection: stop %s %s on %s", key[1], key[2] or "", stream_id)
            self._tasks.pop(key).cancel()
        for key in sorted(wanted - mine):
            logger.info("collection: start %s %s on %s", key[1], key[2] or "", stream_id)
            if key[1] == "stats":
                self._tasks[key] = asyncio.create_task(self._stats(stream_id))
            elif key[1] == "host":
                self._tasks[key] = asyncio.create_task(self._host(stream_id))
            else:
                self._tasks[key] = asyncio.create_task(self._follow(stream_id, key[1], key[2]))

    async def stop(self) -> None:
        """Stop every follower and poll, and wait for them."""
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _store(self, record: dict[str, object]) -> None:
        await self._sink(json.dumps(record).encode())

    async def _follow(self, stream_id: str, kind: str, name: str) -> None:
        since = self._now().isoformat()
        while True:
            transport = self._transport_for(stream_id)
            if transport is not None:
                if kind == "service":
                    args = ["docker", "service", "logs", "-f", "--timestamps", "--raw"]
                else:
                    args = ["docker", "logs", "-f", "--timestamps"]
                args += ["--since", since, name]
                try:
                    async with transport.stream_lines(args) as lines:
                        async for line in lines:
                            parsed = split_timestamp(line.text)
                            if parsed is None:
                                # Docker's own words (no such container, ...).
                                logger.warning(
                                    "collection: %s %s on %s: %s",
                                    kind,
                                    name,
                                    stream_id,
                                    line.text[:200],
                                )
                                continue
                            ts, text = parsed
                            since = ts
                            await self._store(
                                {
                                    "kind": "log",
                                    "source": f"{stream_id}/{name}",
                                    "ts": ts,
                                    kind: name,
                                    "stream": line.stream,
                                    "text": text,
                                }
                            )
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 -- one follower never stops the others
                    logger.warning("collection: %s %s on %s failed: %s", kind, name, stream_id, exc)
            await asyncio.sleep(self._retry_after)

    async def _stats(self, stream_id: str) -> None:
        while True:
            transport = self._transport_for(stream_id)
            names = set(self._followed.get(stream_id, Followed()).containers)
            if transport is not None and names:
                try:
                    result = await transport.run(
                        ["docker", "stats", "--no-stream", "--format", "{{json .}}"]
                    )
                    if result.returncode != 0:
                        logger.warning(
                            "collection: stats on %s: %s", stream_id, result.stderr.strip()[:200]
                        )
                    ts = self._now().isoformat()
                    for line in result.stdout.splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        row = json.loads(line)
                        if row.get("Name") in names:
                            await self._store(stats_record(stream_id, row, ts))
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    logger.warning("collection: stats on %s failed: %s", stream_id, exc)
            await asyncio.sleep(self._stats_every)

    async def _host(self, stream_id: str) -> None:
        """Read the stream's host until cancelled; a reader that ends is tried
        again after a while, its CPU % starting over."""
        assert self._host_reader is not None
        while True:
            previous = None
            try:
                reader = await self._host_reader(stream_id)
                if reader is not None:
                    transport, args, host = reader
                    async with transport.stream_lines(args) as lines:
                        block: list[str] | None = None
                        async for line in lines:
                            text = line.text.strip()
                            if line.stream == "stderr":
                                logger.warning("collection: host of %s: %s", stream_id, text[:200])
                            elif text == BEGIN:
                                block = []
                            elif text == END and block is not None:
                                sample = parse_sample(block)
                                ts = self._now().isoformat()
                                await self._store(
                                    host_record(stream_id, host, sample, previous, ts)
                                )
                                previous, block = sample, None
                            elif block is not None:
                                block.append(text)
                    logger.warning("collection: host reader of %s ended", stream_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 -- the host never stops the others
                logger.warning("collection: host of %s failed: %s", stream_id, exc)
            await asyncio.sleep(self._retry_after)
