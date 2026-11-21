"""Regression corpus of cttc's bugs: data streams (STREAM).

One test per cttc bug whose behavior the Sump owns (br-BUILD-000006-sJpO9KMY);
see README.md in this folder for the whole corpus. Since roadmap Item 26 the
Sump keeps each data stream's followed set and collects it (FEAT-000026); these
two bugs moved here from the app's corpus with Item 27 (RM-000028-sJpO9KMY).
"""

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.plugin import SumpPluginSSH
from sump_plugin_ssh.streams import Followed, parse_target

from correlate_sump.transport import ExecResult, Transport


class QuietDocker(Transport):
    """A transport whose commands answer nothing and whose streams never end."""

    def _shell_command(self, script: str) -> list[str]:
        return [script]

    async def run(self, args: Sequence[str]) -> ExecResult:
        return ExecResult(0, "", "")

    def stream_lines(self, args: Sequence[str]) -> Any:
        import contextlib

        @contextlib.asynccontextmanager
        async def lines():
            async def none():
                await asyncio.sleep(3600)
                yield

            yield none()

        return lines()


class Manager:
    """The part of the Sump's plugin manager the plugin's task uses."""

    def __init__(self) -> None:
        self.tasks: dict[str, Any] = {}

        class Adapter:
            async def ingest(self, raw: bytes) -> bool:
                return True

        self.ingest_adapter = Adapter()

    def add_background_task(self, name: str, factory: Any) -> None:
        self.tasks[name] = factory


async def started(data_dir: Path) -> tuple[SumpPluginSSH, asyncio.Task[None]]:
    """The SSH plugin as a Sump starts it from `data_dir`, its collection running."""
    plugin = SumpPluginSSH({"SUMP_DATA_DIR": str(data_dir)})
    docker = QuietDocker()
    plugin.self_source = DockerHostDataSource("self", docker)
    setattr(plugin, "transport_for", lambda _id: docker)  # noqa: B010 -- a test double
    manager = Manager()
    plugin.register_background_task(manager)
    task = asyncio.create_task(manager.tasks["collection"]())
    for _ in range(50):
        await asyncio.sleep(0)
    return plugin, task


async def stopped(task: asyncio.Task[None]) -> None:
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def test_cttc_bug_000028_relaunch_replays_every_historical_set_request(
    tmp_path: Path,
) -> None:
    """cttc BUG-000028-uKKrzikI (High): Relaunch replays every historical Set request.

    Breaks br-STREAM-000003-sJpO9KMY (roadmap Item 27, RM-000028-sJpO9KMY).
    cttc replayed at launch every Set it had ever sent, so containers unchecked
    long ago came back. Now the Sump keeps one followed set per stream, the
    last, and resumes exactly that at its start; nothing else, and nothing of
    another Sump.
    """
    sump = tmp_path / "sump-a"
    plugin, task = await started(sump)
    lab = plugin.store().add(parse_target("ops@lab", 22))
    for followed in (
        Followed(["web", "db", "cache"], []),
        Followed(["web"], ["api"]),
        Followed(["db"], []),
    ):
        plugin.store().set_followed("self", followed)
    plugin.store().set_followed(lab.id, Followed(["queue"], []))
    await stopped(task)

    # The Sump restarts: its plugin is built again from its data volume.
    again, task = await started(sump)
    assert again.collection is not None
    assert again.collection.running() == [
        ("self", "container", "db"),
        ("self", "stats", ""),
        (lab.id, "container", "queue"),
        (lab.id, "stats", ""),
    ]
    await stopped(task)

    # Another Sump follows nothing of this one's.
    other, task = await started(tmp_path / "sump-b")
    assert other.collection is not None
    assert other.collection.running() == []
    await stopped(task)


async def test_cttc_bug_000031_container_selection_file_ignores_the_ssh_port(
    tmp_path: Path,
) -> None:
    """cttc BUG-000031-uKKrzikI (Medium): Container selection file ignores the ssh port.

    Breaks br-STREAM-000005-sJpO9KMY (roadmap Item 27, RM-000028-sJpO9KMY).
    cttc kept one selection file per host whatever its SSH port, so two Docker
    daemons on one machine overwrote each other's choice. Now a stream's
    identity is `ssh:user@host:port`, each with its own followed set.
    """
    plugin, task = await started(tmp_path)
    first = plugin.store().add(parse_target("ops@box", 22))
    second = plugin.store().add(parse_target("ops@box", 2222))
    assert first.id != second.id
    plugin.store().set_followed(first.id, Followed(["web"], []))
    plugin.store().set_followed(second.id, Followed(["db"], ["api"]))
    plugin.store().set_followed(first.id, Followed(["web", "cache"], []))
    await stopped(task)

    again, task = await started(tmp_path)
    assert again.store().followed(first.id) == Followed(["cache", "web"], [])
    assert again.store().followed(second.id) == Followed(["db"], ["api"])
    await stopped(task)
