"""Running plugins safely (REQ-000006-sJpO9KMY).

`TaskSupervisor` runs one plugin background task in its own wrapper: a crash
is caught and logged and never reaches another task or the Sump
(br-PLUGIN-000006-sJpO9KMY), and the task restarts after a growing delay
(br-PLUGIN-000007-sJpO9KMY). `PluginRuntime` owns every supervisor and the
health loop that puts an unhealthy plugin to sleep and wakes it when it
recovers (br-PLUGIN-000008-sJpO9KMY), and says what state everything is in
(br-PLUGIN-000009-sJpO9KMY).

Sleeping and the clock are passed in, so tests run backoff and health timing
in milliseconds.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from correlate_sump.plugins import BackgroundTaskFactory, PluginManager

logger = logging.getLogger(__name__)

#: Waits the given number of seconds (`asyncio.sleep` outside tests).
Sleep = Callable[[float], Awaitable[None]]

#: Returns a monotonic time in seconds (`time.monotonic` outside tests).
Clock = Callable[[], float]

#: Restart delays (br-PLUGIN-000007): the first, the cap, and how long a task
#: must run without crashing for the delay to start over.
BACKOFF_START = 1.0
BACKOFF_CAP = 300.0
STABLE_AFTER = 60.0

#: Health checks (br-PLUGIN-000008): the setting, its default, and the
#: longest a single check may take.
HEALTH_INTERVAL_VAR = "SUMP_PLUGIN_HEALTH_INTERVAL"
DEFAULT_HEALTH_INTERVAL = 30.0
MAX_CHECK_TIMEOUT = 10.0

#: Task states, and plugin runtime states.
RUNNING, RESTARTING, FINISHED = "running", "restarting", "finished"
SLEEPING, IDLE = "sleeping", "idle"


def health_interval_from_env(env: Mapping[str, str]) -> float:
    """Read the health-check interval in seconds, or the default if unset.

    Raises `ValueError`, naming the variable, for anything but a positive number.
    """
    value = env.get(HEALTH_INTERVAL_VAR, "").strip()
    if not value:
        return DEFAULT_HEALTH_INTERVAL
    try:
        interval = float(value)
    except ValueError:
        interval = 0.0
    if not interval > 0 or interval == float("inf"):
        raise ValueError(f"{HEALTH_INTERVAL_VAR} must be a positive number, got {value!r}")
    return interval


def describe(exc: BaseException) -> str:
    """An exception as shown to operators: its type and message, no traceback."""
    return f"{type(exc).__name__}: {exc}"


@dataclass
class TaskStatus:
    """What a supervised task is doing, for `GET /plugins`."""

    name: str
    owner: str
    state: str = RUNNING
    restarts: int = 0
    last_error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """The status as reported (owner omitted: it is the enclosing plugin)."""
        return {
            "name": self.name,
            "state": self.state,
            "restarts": self.restarts,
            "last_error": self.last_error,
        }


class TaskSupervisor:
    """Runs one plugin background task, restarting it with backoff when it crashes."""

    def __init__(
        self,
        name: str,
        owner: str,
        factory: BackgroundTaskFactory,
        sleep: Sleep = asyncio.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        self.status = TaskStatus(name=name, owner=owner)
        self._factory = factory
        self._sleep = sleep
        self._clock = clock
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Start supervising, as an asyncio task."""
        self._task = asyncio.create_task(
            self._run(), name=f"plugin:{self.status.owner}:{self.status.name}"
        )

    async def stop(self) -> None:
        """Cancel the task, or its pending restart, and wait until it has stopped."""
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def _run(self) -> None:
        delay = BACKOFF_START
        while True:
            self.status.state = RUNNING
            began = self._clock()
            try:
                await self._factory()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # isolate: a plugin's crash stops only this task, for now
                self.status.last_error = describe(exc)
                if self._clock() - began >= STABLE_AFTER:
                    delay = BACKOFF_START
                logger.error(
                    "plugin %r background task %r crashed; restarting in %.0f s",
                    self.status.owner,
                    self.status.name,
                    delay,
                    exc_info=True,
                )
                self.status.state = RESTARTING
                await self._sleep(delay)
                self.status.restarts += 1
                delay = min(delay * 2, BACKOFF_CAP)
            else:
                self.status.state = FINISHED
                return


class PluginRuntime:
    """Every plugin's supervised background tasks, and the health loop."""

    def __init__(
        self,
        manager: PluginManager,
        interval: float = DEFAULT_HEALTH_INTERVAL,
        sleep: Sleep = asyncio.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        self._manager = manager
        self.interval = interval
        self.check_timeout = min(MAX_CHECK_TIMEOUT, interval)
        self._sleep = sleep
        self._clock = clock
        self.supervisors: dict[str, TaskSupervisor] = {}
        self.sleeping: set[str] = set()
        self._health_task: asyncio.Task[None] | None = None

    # --- tasks ------------------------------------------------------------------

    def _tasks_of(self, plugin: str) -> list[str]:
        owners = self._manager.owners["background task"]
        return [name for name, owner in owners.items() if owner == plugin]

    def _start_task(self, name: str) -> None:
        owner = self._manager.owners["background task"].get(name, "sump")
        supervisor = TaskSupervisor(
            name, owner, self._manager.background_task_factories[name], self._sleep, self._clock
        )
        self.supervisors[name] = supervisor
        supervisor.start()

    def start(self) -> None:
        """Start every registered background task, then the health loop."""
        for name in self._manager.background_task_factories:
            self._start_task(name)
        self._health_task = asyncio.create_task(self._health_loop(), name="plugin-health")

    async def stop(self) -> None:
        """Stop the health loop and every task."""
        if self._health_task is not None:
            self._health_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._health_task
            self._health_task = None
        for supervisor in list(self.supervisors.values()):
            await supervisor.stop()

    # --- health -----------------------------------------------------------------

    async def _health_loop(self) -> None:
        while True:
            await self._sleep(self.interval)
            await self.check_once()

    async def _check(self, function: Callable[[], Any]) -> bool | None:
        """Run one plugin's check with the time limit; a hang or error is `False`."""
        try:
            if inspect.iscoroutinefunction(function):
                result = await asyncio.wait_for(function(), self.check_timeout)
            else:
                # In a thread, so a hanging synchronous check can still time out.
                result = await asyncio.wait_for(asyncio.to_thread(function), self.check_timeout)
                if inspect.isawaitable(result):
                    result = await asyncio.wait_for(result, self.check_timeout)
        except TimeoutError:
            logger.warning("health check timed out after %.0f s", self.check_timeout)
            return False
        except Exception:
            logger.warning("health check raised", exc_info=True)
            return False
        return result if result is None else bool(result)

    async def check_once(self) -> None:
        """Ask every plugin with a health check, then put to sleep or wake each as needed."""
        for plugin, function in self._manager.health_checks():
            healthy = await self._check(function)
            if healthy is None:
                continue
            if not healthy and plugin not in self.sleeping:
                await self.put_to_sleep(plugin)
            elif healthy and plugin in self.sleeping:
                self.wake(plugin)

    async def put_to_sleep(self, plugin: str) -> None:
        """Stop `plugin`'s tasks and mark its data sources unavailable; nothing else changes."""
        self.sleeping.add(plugin)
        for name in self._tasks_of(plugin):
            supervisor = self.supervisors.pop(name, None)
            if supervisor is not None:
                await supervisor.stop()
        logger.warning("plugin %r is unhealthy: sleeping", plugin)

    def wake(self, plugin: str) -> None:
        """Restart `plugin`'s tasks afresh, backoff reset."""
        self.sleeping.discard(plugin)
        for name in self._tasks_of(plugin):
            self._start_task(name)
        logger.info("plugin %r is healthy again: awake", plugin)

    # --- state ------------------------------------------------------------------

    def unavailable_data_sources(self) -> list[str]:
        """The data sources owned by sleeping plugins, sorted."""
        owners = self._manager.owners["data source"]
        return sorted(name for name, owner in owners.items() if owner in self.sleeping)

    def plugin_state(self, plugin: str) -> dict[str, Any]:
        """`runtime` and `tasks` for one loaded plugin (br-PLUGIN-000009)."""
        task_names = self._tasks_of(plugin)
        if plugin in self.sleeping:
            runtime = SLEEPING
        elif task_names:
            runtime = RUNNING
        else:
            runtime = IDLE
        tasks = [
            self.supervisors[name].status.as_dict()
            for name in task_names
            if name in self.supervisors
        ]
        return {"runtime": runtime, "tasks": tasks}
