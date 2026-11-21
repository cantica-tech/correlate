"""REQ-000024-sJpO9KMY Requirements 1 and 3: the plugin's registrations,
its route, and self-host detection."""

from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sump_plugin_ssh.datasource import DockerHostDataSource
from sump_plugin_ssh.plugin import SELF_SOURCE, SumpPluginSSH, detect_self_host_data_source
from sump_plugin_ssh.transport import LocalTransport, SSHTransport

from correlate_sump.transport import ExecResult, Transport


class Recorder:
    def __init__(self) -> None:
        self.transports: dict[str, Any] = {}
        self.sources: dict[str, Any] = {}

    def add_transport_type(self, name: str, factory: Any) -> None:
        self.transports[name] = factory

    def add_data_source(self, name: str, source: Any) -> None:
        self.sources[name] = source


class Docker:
    def __init__(self, code: int = 0, missing: bool = False) -> None:
        self.code = code
        self.missing = missing

    async def run(self, args):
        if self.missing:
            raise FileNotFoundError("docker")
        return ExecResult(
            self.code, "id\n" if self.code == 0 else "", "" if self.code == 0 else "no socket"
        )


def test_registers_local_and_ssh_with_the_sumps_key(tmp_path: Path) -> None:
    plugin = SumpPluginSSH({"SUMP_DATA_DIR": str(tmp_path)})
    manager = Recorder()
    plugin.register_transport(manager)
    assert manager.transports["local"] is LocalTransport
    ssh = manager.transports["ssh"]("lab", "ops", port=2222)
    assert isinstance(ssh, SSHTransport)
    assert ssh.target == "ops@lab:2222"
    assert (tmp_path / "ssh" / "id_ed25519").exists()


async def test_detects_self_when_docker_answers() -> None:
    source = await detect_self_host_data_source(cast(Transport, Docker()))
    assert isinstance(source, DockerHostDataSource)
    assert source.name == SELF_SOURCE


async def test_registers_no_self_without_docker_and_never_raises() -> None:
    assert await detect_self_host_data_source(cast(Transport, Docker(code=1))) is None
    assert await detect_self_host_data_source(cast(Transport, Docker(missing=True))) is None


def test_info_names_the_plugin() -> None:
    assert SumpPluginSSH().sump_plugin_info()["name"] == "ssh"


def test_gives_the_public_key_and_never_the_private_one(tmp_path: Path) -> None:
    plugin = SumpPluginSSH({"SUMP_DATA_DIR": str(tmp_path)})
    app = FastAPI()
    plugin.contribute_routes(app)
    body = TestClient(app).get("/plugins/ssh/public-key").json()
    assert body == {"public_key": plugin.identity().public_key()}
    assert "PRIVATE" not in str(body)


async def test_the_sump_finds_it_through_its_installed_entry_point(
    tmp_path: Path, monkeypatch
) -> None:
    """br-PLUGIN-000001-sJpO9KMY: installed, not scanned for."""
    from importlib.metadata import entry_points

    from sump_plugin_ssh import plugin as module

    from correlate_sump.plugins import PluginManager

    eps = [ep for ep in entry_points(group="sump.plugins") if ep.name == "ssh"]
    assert [ep.value for ep in eps] == ["sump_plugin_ssh.plugin:plugin"]
    monkeypatch.setenv("SUMP_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(module.plugin, "_identity", None)
    manager = PluginManager()
    assert "ssh" in await manager.discover()
    assert {"local", "ssh"} <= set(manager.transport_types)
    assert (tmp_path / "ssh" / "id_ed25519.pub").exists()
