"""REQ-000025-sJpO9KMY Requirement 3: collection, against a fake transport."""

import asyncio
import contextlib
import json
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from datetime import UTC, datetime

from sump_plugin_ssh.collect import Collection, size_bytes, split_timestamp, stats_record
from sump_plugin_ssh.streams import Followed

from correlate_sump.ingest import validate_record
from correlate_sump.transport import ExecResult, StreamLine, Transport

NOW = datetime(2026, 11, 21, 18, 0, tzinfo=UTC)


class FakeDocker(Transport):
    """Answers `docker logs -f` with given lines, then ends; `docker stats` with rows."""

    def __init__(self, logs: dict[str, list[str]] | None = None, stats: list[dict] | None = None):
        self.logs = logs or {}
        self.stats = stats or []
        self.streamed: list[list[str]] = []
        self.ran: list[list[str]] = []

    def _shell_command(self, script: str) -> list[str]:
        return [script]

    async def run(self, args: Sequence[str]) -> ExecResult:
        self.ran.append(list(args))
        return ExecResult(0, "\n".join(json.dumps(r) for r in self.stats), "")

    @contextlib.asynccontextmanager
    async def stream_lines(self, args: Sequence[str]) -> AsyncGenerator[AsyncIterator[StreamLine]]:
        self.streamed.append(list(args))
        name = args[-1]

        async def lines():
            for text in self.logs.get(name, []):
                yield StreamLine("stderr" if text.startswith("!") else "stdout", text.lstrip("!"))
            await asyncio.sleep(3600)

        yield lines()


async def _settle() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


def test_reads_docker_timestamps_to_microseconds() -> None:
    assert split_timestamp("2026-11-21T18:00:01.123456789Z hello world") == (
        "2026-11-21T18:00:01.123456+00:00",
        "hello world",
    )
    assert split_timestamp("2026-11-21T18:00:01Z x") == ("2026-11-21T18:00:01.000000+00:00", "x")
    assert split_timestamp("Error: No such container: web") is None


def test_reads_docker_sizes() -> None:
    assert size_bytes("0B") == 0
    assert size_bytes("1.5MiB") == 1572864
    assert size_bytes("12kB") == 12000
    assert size_bytes("2GiB") == 2 * 1024**3
    assert size_bytes("--") is None


def test_a_stats_row_is_a_valid_metric_record() -> None:
    row = {
        "Name": "web",
        "CPUPerc": "1.25%",
        "MemUsage": "12.5MiB / 1.9GiB",
        "NetIO": "1.2kB / 3kB",
        "BlockIO": "0B / 4.1MB",
        "PIDs": "7",
    }
    record = stats_record("self", row, NOW.isoformat())
    assert record["source"] == "self/web"
    assert record["cpu_percent"] == 1.25
    assert record["mem_used_bytes"] == round(12.5 * 1024**2)
    assert record["net_tx_bytes"] == 3000
    assert record["block_write_bytes"] == 4100000
    assert record["pids"] == 7
    assert validate_record(json.dumps(record).encode())[1] is None


async def test_follows_logs_and_stats_of_exactly_the_followed_set() -> None:
    stored: list[dict] = []

    async def sink(raw: bytes) -> bool:
        assert validate_record(raw)[1] is None
        stored.append(json.loads(raw))
        return True

    docker = FakeDocker(
        logs={
            "web": ["2026-11-21T18:00:01.5Z GET /", "!2026-11-21T18:00:02Z oops", "No such thing"],
            "api": ["2026-11-21T18:00:03Z ready"],
        },
        stats=[{"Name": "web", "CPUPerc": "1%"}, {"Name": "other", "CPUPerc": "9%"}],
    )
    collection = Collection(sink, lambda _id: docker, stats_every=0.01, now=lambda: NOW)
    collection.apply("self", Followed(["web"], ["api"]))
    await asyncio.sleep(0.05)
    assert collection.running() == [
        ("self", "container", "web"),
        ("self", "service", "api"),
        ("self", "stats", ""),
    ]
    logs = [r for r in stored if r["kind"] == "log"]
    assert [(r["source"], r["stream"], r["text"]) for r in logs if r["source"] == "self/web"] == [
        ("self/web", "stdout", "GET /"),
        ("self/web", "stderr", "oops"),
    ]
    assert {"service": "api", "text": "ready"}.items() <= next(
        r for r in logs if r["source"] == "self/api"
    ).items()
    metrics = [r for r in stored if r["kind"] == "metric"]
    assert metrics and {r["container"] for r in metrics} == {"web"}
    assert docker.streamed[0] == [
        "docker",
        "logs",
        "-f",
        "--timestamps",
        "--since",
        NOW.isoformat(),
        "web",
    ]
    assert docker.streamed[1][:6] == ["docker", "service", "logs", "-f", "--timestamps", "--raw"]
    # Unchecking stops exactly what left; another stream is untouched.
    collection.apply("ssh:ops@lab:22", Followed(["db"], []))
    collection.apply("self", Followed([], ["api"]))
    await _settle()
    assert collection.running() == [
        ("self", "service", "api"),
        ("ssh:ops@lab:22", "container", "db"),
        ("ssh:ops@lab:22", "stats", ""),
    ]
    await collection.stop()
    assert collection.running() == []


async def test_a_follower_that_ends_is_retried_from_its_last_line() -> None:
    class Ending(FakeDocker):
        @contextlib.asynccontextmanager
        async def stream_lines(self, args):
            self.streamed.append(list(args))

            async def lines():
                yield StreamLine("stdout", "2026-11-21T18:00:05Z last")

            yield lines()

    async def sink(raw: bytes) -> bool:
        return True

    docker = Ending()
    collection = Collection(sink, lambda _id: docker, retry_after=0.01, now=lambda: NOW)
    collection.apply("self", Followed(["web"], []))
    await asyncio.sleep(0.05)
    await collection.stop()
    assert len(docker.streamed) >= 2
    assert docker.streamed[1][5] == "2026-11-21T18:00:05.000000+00:00"


async def test_waits_while_a_stream_cannot_be_reached() -> None:
    async def sink(raw: bytes) -> bool:
        return True

    collection = Collection(sink, lambda _id: None, retry_after=0.01, stats_every=0.01)
    collection.apply("ssh:ops@gone:22", Followed(["web"], []))
    await asyncio.sleep(0.05)
    assert ("ssh:ops@gone:22", "container", "web") in collection.running()
    await collection.stop()
