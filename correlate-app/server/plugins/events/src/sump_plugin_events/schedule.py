"""An event's schedule (REQ-000047-sJpO9KMY): besides conditions, an event can
fire once (at a date and time) or on a cron schedule, in the time zone of the
app that made it (an IANA name, daylight saving included; decided in
FEAT-000049-sJpO9KMY).

Cron is the classic five fields (minute, hour, day of month, month, day of
week, 0 or 7 being Sunday), each `*`, a number, a range `a-b`, a list `a,b`,
or a step `*/n` or `a-b/n`; when both day fields are restricted, either
matching is enough, as cron's own rule. No dependency: the parser is small.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sump_plugin_events.errors import InvalidEvent

#: The fields' ranges: minute, hour, day of month, month, day of week.
_RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
_NAMES = ("minute", "hour", "day of month", "month", "day of week")
#: A cron schedule is searched at most this far ahead (minutes).
_HORIZON_MINUTES = 366 * 24 * 60 + 60


@dataclass
class Schedule:
    """When an event fires by the clock: never, once, or on a cron schedule."""

    kind: Literal["none", "once", "cron"] = "none"
    #: `once`: when (epoch ms).
    at: int | None = None
    #: `cron`: its five fields.
    cron: str = ""
    #: The zone the times are in, e.g. `Europe/Paris`.
    tz: str = "UTC"


def _field(text: str, low: int, high: int, name: str) -> frozenset[int]:
    """One cron field's values, or why it is refused."""
    values: set[int] = set()
    for part in text.split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            if not step_text.isdigit() or int(step_text) < 1:
                raise InvalidEvent(f"cron {name}: a step is a positive number")
            step = int(step_text)
        if part == "*":
            start, end = low, high
        elif "-" in part:
            a, b = part.split("-", 1)
            if not (a.isdigit() and b.isdigit()):
                raise InvalidEvent(f"cron {name}: {part!r} is not a range")
            start, end = int(a), int(b)
        elif part.isdigit():
            start = end = int(part)
        else:
            raise InvalidEvent(f"cron {name}: {part!r} is not a number")
        if not low <= start <= end <= high:
            raise InvalidEvent(f"cron {name}: {part} is outside {low}-{high}")
        values.update(range(start, end + 1, step))
    return frozenset(values)


@dataclass(frozen=True)
class Cron:
    """A parsed cron schedule."""

    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]
    #: Each day field restricted (not `*`): either matching is enough.
    days_restricted: bool
    weekdays_restricted: bool

    @staticmethod
    def parse(text: str) -> Cron:
        parts = text.split()
        if len(parts) != 5:
            raise InvalidEvent("a cron schedule has five fields: minute hour day month weekday")
        fields = [
            _field(p, lo, hi, n) for p, (lo, hi), n in zip(parts, _RANGES, _NAMES, strict=True)
        ]
        weekdays = frozenset(0 if d == 7 else d for d in fields[4])
        return Cron(
            fields[0],
            fields[1],
            fields[2],
            fields[3],
            weekdays,
            parts[2] != "*",
            parts[4] != "*",
        )

    def matches(self, t: datetime) -> bool:
        """Whether local time `t` (to the minute) is on the schedule."""
        if t.minute not in self.minutes or t.hour not in self.hours:
            return False
        if t.month not in self.months:
            return False
        day = t.day in self.days
        weekday = (t.isoweekday() % 7) in self.weekdays
        if self.days_restricted and self.weekdays_restricted:
            return day or weekday
        return day and weekday


def zone(name: str) -> ZoneInfo:
    """A time zone by its IANA name, or why it is refused."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise InvalidEvent(f"unknown time zone: {name!r}") from error


def parse_schedule(raw: Any, now_ms: int | None = None) -> Schedule:
    """A schedule from its JSON (none when absent), or why it is refused.

    With `now_ms`, a one-off time already past is refused.
    """
    if raw is None:
        return Schedule()
    if not isinstance(raw, dict):
        raise InvalidEvent("a schedule is an object")
    kind = raw.get("kind", "none")
    if kind == "none":
        return Schedule()
    tz = raw.get("tz", "UTC")
    if not isinstance(tz, str):
        raise InvalidEvent("a schedule's time zone is a name")
    zone(tz)
    if kind == "once":
        at = raw.get("at")
        if isinstance(at, bool) or not isinstance(at, int | float):
            raise InvalidEvent("a one-off schedule needs a time (`at`, epoch ms)")
        if now_ms is not None and at <= now_ms:
            raise InvalidEvent("a one-off schedule's time is already past")
        return Schedule(kind="once", at=int(at), tz=tz)
    if kind == "cron":
        text = raw.get("cron")
        if not isinstance(text, str):
            raise InvalidEvent("a cron schedule is text")
        Cron.parse(text)
        return Schedule(kind="cron", cron=" ".join(text.split()), tz=tz)
    raise InvalidEvent(f"unknown schedule: {kind!r}")


def next_due(schedule: Schedule, after_ms: int) -> int | None:
    """When the schedule is next due, strictly after `after_ms`; None if never."""
    if schedule.kind == "once":
        return schedule.at if schedule.at is not None and schedule.at > after_ms else None
    if schedule.kind != "cron":
        return None
    cron = Cron.parse(schedule.cron)
    tz = zone(schedule.tz)
    # From the next whole minute, in UTC steps (so a daylight saving gap or
    # repeat is walked through, not skipped), each minute read in the zone.
    t = datetime.fromtimestamp(after_ms / 1000, UTC).replace(second=0, microsecond=0)
    t += timedelta(minutes=1)
    for _ in range(_HORIZON_MINUTES):
        if cron.matches(t.astimezone(tz)):
            return int(t.timestamp() * 1000)
        t += timedelta(minutes=1)
    return None


def describe(schedule: Schedule) -> str:
    """The schedule in words, for a firing's detail."""
    if schedule.kind == "once" and schedule.at is not None:
        local = datetime.fromtimestamp(schedule.at / 1000, zone(schedule.tz))
        return f"scheduled once at {local:%Y-%m-%d %H:%M} {schedule.tz}"
    if schedule.kind == "cron":
        return f"scheduled ({schedule.cron}, {schedule.tz})"
    return ""
