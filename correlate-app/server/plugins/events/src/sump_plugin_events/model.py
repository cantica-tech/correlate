"""An event: what it watches, its conditions, and its state (REQ-000043-sJpO9KMY).

Ported from cttc's gateway engine (`server-logsump/.../server/events.py`):
metric conditions (cpu, mem or net compared with a number) and log
conditions (a regex), matched on any or all of them. An event is checked
when it is made, so a Sump never keeps one it cannot evaluate: the threshold
must be a number and the regex must compile (br-EVENT-000004-sJpO9KMY).

What an event watches is one data stream of the Sump: all its containers
(those it starts following later included) or only named ones, and its host
when asked (decided in FEAT-000045-sJpO9KMY).
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from sump_plugin_events.errors import InvalidEvent
from sump_plugin_events.schedule import Schedule, parse_schedule

__all__ = ["InvalidEvent"]

#: The comparisons a metric condition may use.
OPS = (">", "<", ">=", "<=", "=")
#: The metrics a metric condition may watch.
METRICS = ("cpu", "mem", "net")
#: A data stream or container name: printable, at most 200 characters.
_NAME = re.compile(r"^[\x21-\x7e]{1,200}$")


#: An event's definition: what the API writes. The rest is the engine's state.
DEFINITION = frozenset(
    {
        "id",
        "name",
        "stream",
        "conditions",
        "match",
        "action",
        "schedule",
        "containers",
        "host",
        "enabled",
        "created_at",
        "owner",
        "version",
    }
)


@dataclass
class MetricCondition:
    """A metric of every watched series compared with a threshold."""

    metric: Literal["cpu", "mem", "net"]
    op: Literal[">", "<", ">=", "<=", "="]
    threshold: float
    type: Literal["metric"] = "metric"


@dataclass
class LogCondition:
    """A regex searched in every new log line of the watched containers."""

    pattern: str
    type: Literal["log"] = "log"


Condition = MetricCondition | LogCondition

#: An action's minutes, by kind: (default, most) (decided in FEAT-000047-sJpO9KMY).
ACTION_MINUTES = {"snapshot": (5.0, 60.0), "recording": (10.0, 120.0)}


@dataclass
class Action:
    """What a firing does on the Sump (REQ-000045-sJpO9KMY): nothing, a snapshot
    of the minutes before it, or a recording of the minutes after."""

    kind: Literal["none", "snapshot", "recording"] = "none"
    minutes: float = 0.0
    #: Days each artifact is kept; 0, the default 24 h (REQ-000046-sJpO9KMY).
    keep_days: float = 0.0


def parse_action(raw: Any) -> Action:
    """An action from its JSON (none when absent), or why it is refused."""
    if raw is None:
        return Action()
    if not isinstance(raw, dict):
        raise InvalidEvent("an action is an object")
    kind = raw.get("kind", "none")
    if kind == "none":
        return Action()
    if kind not in ACTION_MINUTES:
        raise InvalidEvent(f"unknown action: {kind!r}")
    default, most = ACTION_MINUTES[kind]
    minutes = raw.get("minutes", default)
    if isinstance(minutes, bool) or not isinstance(minutes, int | float):
        raise InvalidEvent("an action's minutes must be a number")
    if not 0 < minutes <= most:
        raise InvalidEvent(f"a {kind}'s minutes are more than 0 and at most {most:g}")
    keep = raw.get("keep_days", 0)
    if isinstance(keep, bool) or not isinstance(keep, int | float) or not 0 <= keep <= 30:
        raise InvalidEvent("an action's artifacts are kept for 0 (24 h) to 30 days")
    return Action(kind=kind, minutes=float(minutes), keep_days=float(keep))


@dataclass
class Event:
    """An event, its definition and the engine's state for it."""

    id: str
    name: str
    #: The data stream watched (its id, as `/streams` names it).
    stream: str
    conditions: list[Condition]
    #: `any` condition met is enough, or `all` at once.
    match: Literal["any", "all"] = "any"
    #: What a firing does (Item 47).
    action: Action = field(default_factory=Action)
    #: When it fires by the clock, besides conditions (Item 49).
    schedule: Schedule = field(default_factory=Schedule)
    #: The containers watched; empty, all of the stream's.
    containers: list[str] = field(default_factory=list)
    #: The stream's host is watched by its metric conditions too.
    host: bool = False
    enabled: bool = True
    #: When it was made (epoch ms); log positions start there.
    created_at: int = 0
    #: The user who made it, through the D3 identity (br-EVENT-000007-sJpO9KMY).
    owner: str = ""
    #: The definition's version: each edit is based on one, and bumps it.
    version: int = 1
    #: `armed` (watching) or `triggered` (met, until it clears or is reset).
    status: Literal["armed", "triggered"] = "armed"
    #: The edge latch: the conditions were not met at the last check.
    armed: bool = True
    triggered_at: int | None = None
    trigger_count: int = 0
    trigger_detail: str | None = None
    #: Per log condition (its index), per source: the last stream id read.
    positions: dict[str, dict[str, str]] = field(default_factory=dict)
    #: A schedule's next due time (epoch ms); None when it has none left.
    next_due: int | None = None

    def to_json(self) -> dict[str, Any]:
        """The whole event, as the API answers it."""
        return asdict(self)

    def definition(self) -> dict[str, Any]:
        """What the API writes, versioned."""
        return {k: v for k, v in asdict(self).items() if k in DEFINITION}

    def state(self) -> dict[str, Any]:
        """What the engine writes, with the definition version it was computed for."""
        return {k: v for k, v in asdict(self).items() if k not in DEFINITION or k == "version"}

    @staticmethod
    def from_json(data: dict[str, Any]) -> Event:
        """An event from its definition and state, merged; its definition checked again."""
        triggered_at = data.get("triggered_at")
        event = Event(
            id=str(data["id"]),
            name=str(data.get("name", "")),
            stream=str(data.get("stream", "")),
            conditions=[parse_condition(c) for c in data.get("conditions", [])],
            match="all" if data.get("match") == "all" else "any",
            action=parse_action(data.get("action")),
            schedule=parse_schedule(data.get("schedule")),
            containers=[str(c) for c in data.get("containers", [])],
            host=data.get("host") is True,
            enabled=data.get("enabled") is not False,
            created_at=int(data.get("created_at", 0)),
            status="triggered" if data.get("status") == "triggered" else "armed",
            armed=data.get("armed") is not False,
            triggered_at=int(triggered_at) if triggered_at is not None else None,
            trigger_count=int(data.get("trigger_count", 0)),
            trigger_detail=data.get("trigger_detail"),
            positions={
                str(index): {str(s): str(p) for s, p in by_source.items()}
                for index, by_source in (data.get("positions") or {}).items()
            },
            owner=str(data.get("owner", "")),
            version=int(data.get("version", 1)),
            next_due=int(data["next_due"]) if data.get("next_due") is not None else None,
        )
        validate(event)
        return event


def parse_condition(raw: Any) -> Condition:
    """A condition from its JSON, or why it is refused."""
    if not isinstance(raw, dict):
        raise InvalidEvent("a condition is an object")
    kind = raw.get("type")
    if kind == "metric":
        threshold = raw.get("threshold")
        if isinstance(threshold, bool) or not isinstance(threshold, int | float):
            raise InvalidEvent("a metric condition's threshold must be a number")
        if not math.isfinite(threshold):
            raise InvalidEvent("a metric condition's threshold must be finite")
        return MetricCondition(
            metric=raw.get("metric"), op=raw.get("op"), threshold=float(threshold)
        )
    if kind == "log":
        pattern = raw.get("pattern")
        if not isinstance(pattern, str):
            raise InvalidEvent("a log condition's pattern must be text")
        return LogCondition(pattern=pattern)
    raise InvalidEvent(f"unknown condition type: {kind!r}")


def validate(event: Event) -> None:
    """Refuse an event the engine could not evaluate."""
    if not event.name.strip() or len(event.name) > 200:
        raise InvalidEvent("an event needs a name of at most 200 characters")
    if not _NAME.match(event.stream):
        raise InvalidEvent("an event watches one data stream")
    for name in event.containers:
        if not isinstance(name, str) or not _NAME.match(name):
            raise InvalidEvent(f"not a container name: {name!r}")
    if not event.conditions and event.schedule.kind == "none":
        raise InvalidEvent("an event needs at least one condition, or a schedule")
    if event.match not in ("any", "all"):
        raise InvalidEvent(f"match must be 'any' or 'all', got {event.match!r}")
    for condition in event.conditions:
        if isinstance(condition, MetricCondition):
            if condition.metric not in METRICS:
                raise InvalidEvent(f"unknown metric: {condition.metric!r}")
            if condition.op not in OPS:
                raise InvalidEvent(f"unknown operator: {condition.op!r}")
        else:
            try:
                re.compile(condition.pattern)
            except re.error as error:
                raise InvalidEvent(f"invalid regex {condition.pattern!r}: {error}") from error
