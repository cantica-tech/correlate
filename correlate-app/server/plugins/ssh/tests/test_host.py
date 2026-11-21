"""REQ-000032-sJpO9KMY Requirement 1: the stream host's own telemetry, read
from its `/proc` by one long-lived loop, against a fake transport."""

import asyncio
import contextlib
import json
import shlex
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from datetime import UTC, datetime
from pathlib import Path

from sump_plugin_ssh.collect import Collection
from sump_plugin_ssh.host import (
    BEGIN,
    END,
    SCRIPT,
    Sample,
    cpu_percent,
    helper_name,
    host_record,
    parse_sample,
    self_reader_args,
)
from sump_plugin_ssh.plugin import SumpPluginSSH
from sump_plugin_ssh.streams import Followed, parse_target

from correlate_sump.ingest import validate_record
from correlate_sump.transport import ExecResult, StreamLine, Transport

NOW = datetime(2026, 11, 22, 9, 0, tzinfo=UTC)


def sample_lines(user: int, idle: int, rx: int) -> list[str]:
    return [
        f"cpu  {user} 0 100 {idle} 50 0 0 0 0 0",
        "MemTotal:        2048000 kB",
        "MemAvailable:    1024000 kB",
        "Inter-|   Receive                                                |  Transmit",
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets",
        f"  eth0: {rx} 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
        "    lo: 999999 5 0 0 0 0 0 0 999999 5 0 0 0 0 0 0",
        "  eth1: 500 1 0 0 0 0 0 0 300 2 0 0 0 0 0 0",
    ]


def test_reads_a_sample_from_proc() -> None:
    sample = parse_sample(sample_lines(1000, 8000, 4000))
    assert sample == Sample(
        cpu_total=1000 + 100 + 8000 + 50,
        cpu_idle=8050,
        mem_total=2048000 * 1024,
        mem_available=1024000 * 1024,
        net_rx=4500,
        net_tx=2300,
    )
    assert parse_sample(["garbage"]) == Sample(None, None, None, None, None, None)


def test_cpu_percent_comes_from_two_samples() -> None:
    first = parse_sample(sample_lines(1000, 8000, 0))
    second = parse_sample(sample_lines(1300, 8100, 0))
    # 400 jiffies passed, 100 of them idle: 75% busy.
    assert cpu_percent(first, second) == 75.0
    assert cpu_percent(None, second) is None
    assert cpu_percent(second, second) is None


def test_a_sample_is_a_valid_metric_record_of_the_host() -> None:
    sample = parse_sample(sample_lines(1000, 8000, 4000))
    record = host_record("ssh:ops@lab:22", "lab", sample, None, NOW.isoformat())
    assert record == {
        "kind": "metric",
        "source": "ssh:ops@lab:22/__host__",
        "ts": NOW.isoformat(),
        "host": "lab",
        "cpu_percent": None,
        "mem_used_bytes": 1024000 * 1024,
        "mem_limit_bytes": 2048000 * 1024,
        "net_rx_bytes": 4500,
        "net_tx_bytes": 2300,
    }
    assert validate_record(json.dumps(record).encode())[1] is None


def test_self_reads_in_a_container_of_the_sumps_image_on_the_hosts_network() -> None:
    name = helper_name("0123abc;rm")
    assert name == "correlate-sump-host-0123abcrm"
    args = self_reader_args("correlate-sump:dev", name)
    assert args[:2] == ["sh", "-c"]
    removal, _, run = args[2].partition("; exec ")
    assert removal == f"docker rm -f {name} >/dev/null 2>&1"
    assert shlex.split(run) == [
        "docker",
        "run",
        "--rm",
        "--init",
        "--name",
        name,
        "--network",
        "host",
        "--entrypoint",
        "sh",
        "correlate-sump:dev",
        "-c",
        SCRIPT,
    ]
    assert "-p" not in shlex.split(run)


class FakeHost(Transport):
    """Streams the given lines for any command, then waits; answers `docker inspect`."""

    def __init__(self, lines: list[str], image: str = "correlate-sump:dev") -> None:
        self.lines = lines
        self.image = image
        self.streamed: list[list[str]] = []
        self.ran: list[list[str]] = []

    def _shell_command(self, script: str) -> list[str]:
        return [script]

    async def run(self, args: Sequence[str]) -> ExecResult:
        self.ran.append(list(args))
        if args[:2] == ["docker", "inspect"]:
            return ExecResult(0 if self.image else 1, self.image + "\n", "no such container")
        return ExecResult(0, "", "")

    @contextlib.asynccontextmanager
    async def stream_lines(self, args: Sequence[str]) -> AsyncGenerator[AsyncIterator[StreamLine]]:
        self.streamed.append(list(args))

        async def lines():
            for text in self.lines:
                yield StreamLine("stderr" if text.startswith("!") else "stdout", text.lstrip("!"))
            await asyncio.sleep(3600)

        yield lines()


async def _settle() -> None:
    for _ in range(30):
        await asyncio.sleep(0)


async def test_collection_reads_the_host_while_the_stream_collects() -> None:
    lines = [
        BEGIN,
        *sample_lines(1000, 8000, 10),
        END,
        "!grep: something odd",
        BEGIN,
        *sample_lines(1300, 8100, 20),
        END,
    ]
    host = FakeHost(lines)
    stored: list[dict] = []

    async def sink(raw: bytes) -> bool:
        stored.append(json.loads(raw))
        return True

    async def reader(stream_id: str):
        return host, ["loop"], "lab"

    collection = Collection(
        sink, lambda _s: None, host_reader=reader, now=lambda: NOW, retry_after=3600
    )
    collection.apply("ssh:ops@lab:22", Followed(services=["api"]))
    await _settle()
    assert ("ssh:ops@lab:22", "host", "") in collection.running()
    hosts = [r for r in stored if r["source"] == "ssh:ops@lab:22/__host__"]
    assert [r["cpu_percent"] for r in hosts] == [None, 75.0]
    assert host.streamed == [["loop"]]
    collection.apply("ssh:ops@lab:22", Followed())
    await _settle()
    assert collection.running() == []
    await collection.stop()


async def test_no_host_reader_without_anything_followed_or_without_the_option() -> None:
    async def reader(stream_id: str):
        return None

    async def sink(raw: bytes) -> bool:
        return True

    collection = Collection(sink, lambda _s: None, host_reader=reader)
    collection.apply("self", Followed())
    assert collection.running() == []
    plain = Collection(sink, lambda _s: None)
    plain.apply("self", Followed(services=["api"]))
    assert all(kind != "host" for _s, kind, _n in plain.running())
    await plain.stop()
    await collection.stop()


async def test_the_plugin_reads_ssh_hosts_by_shell_and_self_in_its_own_image(
    tmp_path: Path, monkeypatch
) -> None:
    plugin = SumpPluginSSH({"SUMP_DATA_DIR": str(tmp_path)})
    plugin.store().add(parse_target("ops@lab", 22))
    ssh = FakeHost([])
    self_host = FakeHost([], image="correlate-sump:dev")
    monkeypatch.setattr(plugin, "transport_for", lambda sid: self_host if sid == "self" else ssh)
    monkeypatch.setenv("HOSTNAME", "abc123")
    over_ssh = await plugin.host_reader("ssh:ops@lab:22")
    assert over_ssh == (ssh, [SCRIPT], "lab")
    for_self = await plugin.host_reader("self")
    assert for_self is not None
    assert for_self[2] == "localhost"
    assert "correlate-sump:dev" in for_self[1][2]
    assert self_host.ran == [["docker", "inspect", "--format", "{{.Config.Image}}", "abc123"]]
    # The image is found once.
    await plugin.host_reader("self")
    assert len(self_host.ran) == 1


async def test_no_self_reader_when_the_sumps_image_is_not_known(
    tmp_path: Path, monkeypatch
) -> None:
    plugin = SumpPluginSSH({"SUMP_DATA_DIR": str(tmp_path)})
    monkeypatch.setattr(plugin, "transport_for", lambda sid: FakeHost([], image=""))
    assert await plugin.host_reader("self") is None
