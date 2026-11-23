"""log-sump's records as the Sump's own (br-STREAM-000011-sJpO9KMY).

log-sump v0.4.2 (`log_sump/common/schema.py`): every record has
`docker_host`, `container_name`, `container_id`, `ts` (ISO 8601) and `seq`.
A log has `message`, `level`, `stream`; a metric has `cpu_pct`, `mem_*`,
`net_*`, `blk_*`, `pids`, and `metric_scope` "system" for the host's own
(`container_id` `__system__`). The Sump's are the SSH plugin's shapes: a log
`text`, a metric `cpu_percent` and byte counts, the host as `__host__`.
"""

from __future__ import annotations

from typing import Any

#: The Sump's name for a stream's host (the SSH plugin's `HOST_NAME`).
HOST_NAME = "__host__"
#: log-sump's container id for a host's own figures.
SYSTEM_ID = "__system__"


def is_system(record: dict[str, Any]) -> bool:
    """Whether a metric is the host's own, not a container's."""
    return record.get("metric_scope") == "system" or record.get("container_id") == SYSTEM_ID


def seen_key(record: dict[str, Any]) -> str:
    """What makes one log-sump record itself: its kind, container, time and sequence."""
    return "|".join(
        str(record.get(k, "")) for k in ("kind", "container_id", "container_name", "ts", "seq")
    )


def translate(stream_id: str, record: dict[str, Any]) -> dict[str, Any] | None:
    """The Sump's record for one of log-sump's; None for what it does not keep
    (services, unknown kinds, records without a time)."""
    kind, ts = record.get("kind"), record.get("ts")
    if not isinstance(ts, str) or not ts:
        return None
    if kind == "log":
        name = str(record.get("container_name", ""))
        return {
            "kind": "log",
            "source": f"{stream_id}/{name}",
            "ts": ts,
            "container": name,
            "stream": record.get("stream", "stdout"),
            "level": record.get("level"),
            "text": str(record.get("message", "")),
        }
    if kind == "metric":
        figures = {
            "cpu_percent": record.get("cpu_pct"),
            "mem_used_bytes": record.get("mem_used_bytes"),
            "mem_limit_bytes": record.get("mem_limit_bytes"),
            "net_rx_bytes": record.get("net_rx_bytes"),
            "net_tx_bytes": record.get("net_tx_bytes"),
        }
        if is_system(record):
            host = str(record.get("docker_host", ""))
            return {
                "kind": "metric",
                "source": f"{stream_id}/{HOST_NAME}",
                "ts": ts,
                "host": host,
                **figures,
            }
        name = str(record.get("container_name", ""))
        return {
            "kind": "metric",
            "source": f"{stream_id}/{name}",
            "ts": ts,
            "container": name,
            **figures,
            "block_read_bytes": record.get("blk_read_bytes"),
            "block_write_bytes": record.get("blk_write_bytes"),
            "pids": record.get("pids"),
        }
    return None


def followed_name(record: dict[str, Any]) -> str | None:
    """The container a log-sump record is of, None for the host's own."""
    if record.get("kind") == "metric" and is_system(record):
        return None
    name = record.get("container_name")
    return str(name) if name else None
