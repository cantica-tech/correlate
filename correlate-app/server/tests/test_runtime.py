"""Running plugins safely (REQ-000006-sJpO9KMY Requirements 1 and 2):
isolation (br-PLUGIN-000006), restart with backoff (br-PLUGIN-000007), and
sleeping and waking on health checks (br-PLUGIN-000008)."""

import asyncio
import time

import pytest

from correlate_sump.plugins import PluginManager, hookimpl
from correlate_sump.runtime import (
    BACKOFF_CAP,
    DEFAULT_HEALTH_INTERVAL,
    PluginRuntime,
    TaskSupervisor,
    health_interval_from_env,
)


class FakeTime:
    """A sleep that records delays and returns at once, and a clock tests move."""

    def __init__(self) -> None:
        self.delays: list[float] = []
        self.now = 0.0

    async def sleep(self, seconds: float) -> None:
        self.delays.append(seconds)
        await asyncio.sleep(0)

    def clock(self) -> float:
        return self.now


async def wait_until(condition) -> None:
    """Yield to the event loop until `condition()` holds, failing after 2 seconds."""
    async with asyncio.timeout(2):
        # Polling on purpose: the conditions read plain attributes, not events.
        while not condition():  # noqa: ASYNC110
            await asyncio.sleep(0.001)


# --- br-PLUGIN-000006 and 000007: supervisors -----------------------------------------


async def test_crashing_task_restarts_with_doubling_capped_delays() -> None:
    fake = FakeTime()

    async def crash() -> None:
        raise RuntimeError("boom")

    supervisor = TaskSupervisor("t", "p", crash, fake.sleep, fake.clock)
    supervisor.start()
    await wait_until(lambda: len(fake.delays) >= 12)
    await supervisor.stop()
    assert fake.delays[:12] == [
        1,
        2,
        4,
        8,
        16,
        32,
        64,
        128,
        256,
        BACKOFF_CAP,
        BACKOFF_CAP,
        BACKOFF_CAP,
    ]
    assert supervisor.status.last_error == "RuntimeError: boom"
    assert supervisor.status.restarts >= 11


async def test_delay_resets_after_a_stable_run() -> None:
    fake = FakeTime()
    runs = 0

    async def crash_later() -> None:
        nonlocal runs
        runs += 1
        if runs == 4:
            fake.now += 61  # this run lasted over a minute before crashing
        raise RuntimeError("again")

    supervisor = TaskSupervisor("t", "p", crash_later, fake.sleep, fake.clock)
    supervisor.start()
    await wait_until(lambda: len(fake.delays) >= 6)
    await supervisor.stop()
    assert fake.delays[:6] == [1, 2, 4, 1, 2, 4]


async def test_task_that_returns_is_not_restarted() -> None:
    fake = FakeTime()
    calls = 0

    async def done() -> None:
        nonlocal calls
        calls += 1

    supervisor = TaskSupervisor("t", "p", done, fake.sleep, fake.clock)
    supervisor.start()
    await wait_until(lambda: supervisor.status.state == "finished")
    await supervisor.stop()
    assert calls == 1
    assert fake.delays == []


@pytest.mark.parametrize("during", ["task", "restart wait"])
async def test_stop_cancels_the_task_or_its_restart(during: str) -> None:
    started = asyncio.Event()

    async def forever() -> None:
        started.set()
        if during == "restart wait":
            raise RuntimeError("crash, then wait")
        await asyncio.Event().wait()

    async def long_sleep(seconds: float) -> None:
        await asyncio.Event().wait()

    supervisor = TaskSupervisor("t", "p", forever, long_sleep, time.monotonic)
    supervisor.start()
    await started.wait()
    await asyncio.sleep(0)
    await asyncio.wait_for(supervisor.stop(), timeout=1)
    assert supervisor.status.state == ("restarting" if during == "restart wait" else "running")


async def test_a_crashing_task_does_not_slow_another() -> None:
    fake = FakeTime()
    ticks = 0

    async def crash() -> None:
        raise RuntimeError("loop")

    async def steady() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0)

    crashing = TaskSupervisor("bad", "p1", crash, fake.sleep, fake.clock)
    working = TaskSupervisor("good", "p2", steady, fake.sleep, fake.clock)
    crashing.start()
    working.start()
    await wait_until(lambda: ticks >= 200 and len(fake.delays) >= 20)
    await crashing.stop()
    await working.stop()
    assert working.status.state == "running" and working.status.restarts == 0


async def test_isolated_background_task_catches_unhandled_exception() -> None:
    """correlator's test, skipped since STEP-000001-sJpO9KMY, rewritten for the runtime."""
    fake = FakeTime()

    async def failing_factory() -> None:
        raise RuntimeError("Task crashed")

    supervisor = TaskSupervisor("failing-task", "p", failing_factory, fake.sleep, fake.clock)
    supervisor.start()
    await wait_until(lambda: supervisor.status.restarts >= 1)
    await supervisor.stop()  # the exception never propagated
    assert supervisor.status.last_error == "RuntimeError: Task crashed"


# --- br-PLUGIN-000008: health, sleep and wake ------------------------------------------


class Health:
    """A plugin with one background task, one data source and a switchable check."""

    def __init__(self, name: str, answer: object = True, mode: str = "sync") -> None:
        self.name = name
        self.answer = answer
        self.mode = mode
        self.runs = 0

    @hookimpl
    def register_data_source(self, manager) -> None:
        manager.add_data_source(f"{self.name}-source", object())

    @hookimpl
    def register_background_task(self, manager) -> None:
        async def work() -> None:
            self.runs += 1
            await asyncio.Event().wait()

        manager.add_background_task(f"{self.name}-task", work)


def with_check(plugin: Health) -> Health:
    """Give `plugin` an `on_health_check` of its mode: sync, async, raising or hanging."""

    class Checked(Health):
        @hookimpl
        def on_health_check(self):
            if self.mode == "raise":
                raise RuntimeError("check failed")
            if self.mode == "hang":
                time.sleep(0.5)
            return self.answer

    class AsyncChecked(Health):
        @hookimpl
        async def on_health_check(self):
            if self.mode == "async-hang":
                await asyncio.sleep(5)
            return self.answer

    cls = AsyncChecked if plugin.mode.startswith("async") else Checked
    checked = cls(plugin.name, plugin.answer, plugin.mode)
    return checked


async def runtime_with(*plugins, interval: float = 0.2) -> tuple[PluginManager, PluginRuntime]:
    manager = PluginManager()
    for plugin in plugins:
        manager.register(plugin, name=plugin.name)
    await manager.discover()
    fake = FakeTime()
    runtime = PluginRuntime(manager, interval=interval, sleep=fake.sleep, clock=fake.clock)
    for name in manager.background_task_factories:
        runtime._start_task(name)
    return manager, runtime


@pytest.mark.parametrize("mode", ["sync", "async", "raise", "hang", "async-hang"])
async def test_unhealthy_plugin_sleeps_and_others_carry_on(mode: str) -> None:
    sick = with_check(Health("sick", answer=False, mode=mode))
    well = with_check(Health("well", answer=True))
    _, runtime = await runtime_with(sick, well, interval=0.2)
    await wait_until(lambda: sick.runs == 1 and well.runs == 1)
    await runtime.check_once()
    assert runtime.sleeping == {"sick"}
    assert "sick-task" not in runtime.supervisors
    assert runtime.supervisors["well-task"].status.state == "running"
    assert runtime.unavailable_data_sources() == ["sick-source"]
    assert runtime.plugin_state("sick")["runtime"] == "sleeping"
    assert runtime.plugin_state("well")["runtime"] == "running"
    await runtime.stop()


async def test_sleeping_plugin_wakes_and_restarts_its_tasks() -> None:
    sick = with_check(Health("sick", answer=False))
    _, runtime = await runtime_with(sick)
    await wait_until(lambda: sick.runs == 1)
    await runtime.check_once()
    assert runtime.sleeping == {"sick"}
    sick.answer = True
    await runtime.check_once()
    assert runtime.sleeping == set()
    await wait_until(lambda: sick.runs == 2)
    assert runtime.supervisors["sick-task"].status.restarts == 0
    assert runtime.unavailable_data_sources() == []
    await runtime.stop()


async def test_none_or_no_check_never_sleeps() -> None:
    abstains = with_check(Health("abstains", answer=None))
    silent = Health("silent")
    _, runtime = await runtime_with(abstains, silent)
    await runtime.check_once()
    assert runtime.sleeping == set()
    assert runtime.plugin_state("silent")["runtime"] == "running"
    await runtime.stop()


async def test_plugin_without_tasks_is_idle() -> None:
    manager = PluginManager()
    manager.register(object(), name="plain")
    await manager.discover()
    runtime = PluginRuntime(manager)
    assert runtime.plugin_state("plain") == {"runtime": "idle", "tasks": []}


async def test_health_loop_runs_checks_on_its_interval() -> None:
    sick = with_check(Health("sick", answer=False))
    manager = PluginManager()
    manager.register(sick, name="sick")
    await manager.discover()
    fake = FakeTime()
    runtime = PluginRuntime(manager, interval=7, sleep=fake.sleep, clock=fake.clock)
    runtime.start()
    await wait_until(lambda: runtime.sleeping == {"sick"})
    await runtime.stop()
    assert 7 in fake.delays


def test_check_timeout_is_ten_seconds_or_the_interval() -> None:
    manager = PluginManager()
    assert PluginRuntime(manager, interval=30).check_timeout == 10
    assert PluginRuntime(manager, interval=2).check_timeout == 2


def test_health_interval_default_and_value() -> None:
    assert health_interval_from_env({}) == DEFAULT_HEALTH_INTERVAL == 30
    assert health_interval_from_env({"SUMP_PLUGIN_HEALTH_INTERVAL": "2.5"}) == 2.5


@pytest.mark.parametrize("value", ["0", "-1", "soon", "inf", "nan"])
def test_invalid_health_interval_is_refused(value: str) -> None:
    with pytest.raises(ValueError, match="SUMP_PLUGIN_HEALTH_INTERVAL must be a positive number"):
        health_interval_from_env({"SUMP_PLUGIN_HEALTH_INTERVAL": value})
