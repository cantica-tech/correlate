"""The stream host's own telemetry (REQ-000032-sJpO9KMY Requirement 1,
decided in FEAT-000033-sJpO9KMY), as cttc's "proc" source
(`server-logsump/.../listener/system_stats.py`): the host's `/proc/stat` cpu
line, `MemTotal` and `MemAvailable`, and `/proc/net/dev`, read every 5 s by
one long-lived shell loop on the host, line by line.

Over SSH the loop runs as a shell command. For "self" the Sump's container
cannot see its host's `/proc/net/dev`, so the loop runs in a short-lived
container of the Sump's own image on the host's network (`/proc/stat` and
`/proc/meminfo` are the kernel's, the same in any container); on Docker
Desktop the host is its Linux VM. That container has a fixed name, removed
before it starts, so a Sump that stopped abruptly leaves none behind for
long.

Each sample becomes a `metric` record, `source` `<stream>/__host__`, with the
container records' field names, so the charts read both the same way.
"""

from __future__ import annotations

import shlex
from collections.abc import Iterable
from dataclasses import dataclass

#: The host's records' name within a stream: `<stream>/__host__`.
HOST_NAME = "__host__"
#: How often the host is read: cttc's 5 s.
SAMPLE_EVERY_S = 5
#: Markers between samples.
BEGIN = "===SAMPLE==="
END = "===END==="

#: The loop on the host: fixed text, nothing from a request goes in.
SCRIPT = (
    "while :; do "
    f"echo {BEGIN}; "
    "head -n 1 /proc/stat; "
    "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; "
    "cat /proc/net/dev; "
    f"echo {END}; "
    f"sleep {SAMPLE_EVERY_S}; "
    "done"
)


@dataclass(frozen=True)
class Sample:
    """One reading of the host."""

    #: CPU time, all of it and idle (with iowait), in jiffies since boot.
    cpu_total: int | None
    cpu_idle: int | None
    mem_total: int | None
    mem_available: int | None
    #: Bytes since boot, every interface but `lo`.
    net_rx: int | None
    net_tx: int | None


def parse_sample(lines: Iterable[str]) -> Sample:
    """One sample from the lines between `BEGIN` and `END`; what cannot be read is None."""
    cpu_total = cpu_idle = mem_total = mem_available = None
    net_rx = net_tx = None
    for line in lines:
        text = line.strip()
        if text.startswith("cpu "):
            fields = [int(f) for f in text.split()[1:] if f.isdigit()]
            if len(fields) >= 4:
                # user nice system idle iowait irq softirq steal: guest time is in user.
                cpu_total = sum(fields[:8])
                cpu_idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
        elif text.startswith(("MemTotal:", "MemAvailable:")):
            parts = text.split()
            if len(parts) >= 2 and parts[1].isdigit():
                value = int(parts[1]) * 1024  # kB
                if text.startswith("MemTotal:"):
                    mem_total = value
                else:
                    mem_available = value
        elif ":" in text:
            iface, _, rest = text.partition(":")
            numbers = rest.split()
            if iface.strip() == "lo" or len(numbers) < 9 or not numbers[0].isdigit():
                continue
            net_rx = (net_rx or 0) + int(numbers[0])
            net_tx = (net_tx or 0) + int(numbers[8])
    return Sample(cpu_total, cpu_idle, mem_total, mem_available, net_rx, net_tx)


def cpu_percent(previous: Sample | None, current: Sample) -> float | None:
    """The host's CPU use between two samples, 0 to 100; None without a previous one."""
    if previous is None:
        return None
    a, b = previous.cpu_total, current.cpu_total
    c, d = previous.cpu_idle, current.cpu_idle
    if a is None or b is None or c is None or d is None:
        return None
    total = b - a
    idle = d - c
    if total <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * (total - idle) / total)), 2)


def host_record(
    stream_id: str, host: str, sample: Sample, previous: Sample | None, ts: str
) -> dict[str, object]:
    """One sample as a `metric` record of `<stream>/__host__`."""
    used = (
        sample.mem_total - sample.mem_available
        if sample.mem_total is not None and sample.mem_available is not None
        else None
    )
    return {
        "kind": "metric",
        "source": f"{stream_id}/{HOST_NAME}",
        "ts": ts,
        "host": host,
        "cpu_percent": cpu_percent(previous, sample),
        "mem_used_bytes": used,
        "mem_limit_bytes": sample.mem_total,
        "net_rx_bytes": sample.net_rx,
        "net_tx_bytes": sample.net_tx,
    }


def helper_name(sump_container: str) -> str:
    """The "self" reader container's fixed name, from the Sump's own container's."""
    safe = "".join(c for c in sump_container if c.isalnum() or c in "_.-")[:64] or "sump"
    return f"correlate-sump-host-{safe}"


def self_reader_args(image: str, name: str) -> list[str]:
    """The command running the loop in a container of `image` on the host's network:
    any container of that name is removed first, and this one goes when it stops."""
    run = shlex.join(
        [
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
            image,
            "-c",
            SCRIPT,
        ]
    )
    return ["sh", "-c", f"docker rm -f {shlex.quote(name)} >/dev/null 2>&1; exec {run}"]
