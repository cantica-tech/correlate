"""REQ-000024-sJpO9KMY Requirement 3: listing a Docker host's containers,
the Sump's own left out."""

import json

import pytest
from sump_plugin_ssh.containers import is_own_sump_container, list_containers, own_container_id

from correlate_sump.transport import ExecResult, TransportError


class FakeDocker:
    def __init__(self, rows: list[dict[str, str]], code: int = 0) -> None:
        self.rows = rows
        self.code = code
        self.calls: list[list[str]] = []

    async def run(self, args):
        self.calls.append(list(args))
        out = "\n".join(json.dumps(r) for r in self.rows) + "\n"
        return ExecResult(self.code, out if self.code == 0 else "", "boom" if self.code else "")


SUMP = {
    "ID": "a1b2c3d4e5f6",
    "Names": "correlate-sump-local-sump-1",
    "Labels": "com.docker.compose.project=correlate-sump-local,com.docker.compose.service=sump",
}
WEB = {"ID": "0123456789ab", "Names": "web", "Labels": "com.docker.compose.service=web"}
DB = {"ID": "ba9876543210", "Names": "db", "Labels": ""}


async def test_lists_running_containers_with_docker_ps() -> None:
    docker = FakeDocker([WEB, DB])
    refs = await list_containers(docker, own_id=None)
    assert [(r.container_id, r.container_name) for r in refs] == [
        ("0123456789ab", "web"),
        ("ba9876543210", "db"),
    ]
    assert docker.calls == [["docker", "ps", "--format", "{{json .}}"]]


async def test_leaves_out_the_sumps_own_container_by_its_id() -> None:
    renamed = {**SUMP, "Labels": "", "Names": "anything"}
    refs = await list_containers(FakeDocker([WEB, renamed]), own_id="a1b2c3d4e5f6")
    assert [r.container_name for r in refs] == ["web"]


async def test_leaves_it_out_by_its_compose_labels_when_its_id_is_unknown() -> None:
    refs = await list_containers(FakeDocker([WEB, SUMP]), own_id=None)
    assert [r.container_name for r in refs] == ["web"]


async def test_keeps_another_projects_sump_service_and_lists_its_own_when_asked() -> None:
    other = {
        **SUMP,
        "ID": "ffffffffffff",
        "Labels": "com.docker.compose.project=shop,com.docker.compose.service=sump",
    }
    refs = await list_containers(FakeDocker([other, SUMP]), own_id=None)
    assert [r.container_id for r in refs] == ["ffffffffffff"]
    refs = await list_containers(FakeDocker([other, SUMP]), include_self=True, own_id=None)
    assert len(refs) == 2


async def test_a_failing_docker_ps_raises() -> None:
    with pytest.raises(TransportError):
        await list_containers(FakeDocker([], code=1), own_id=None)


def test_own_container_id_is_the_containers_host_name() -> None:
    assert own_container_id("a1b2c3d4e5f6") == "a1b2c3d4e5f6"
    assert own_container_id("my-laptop.local") is None


def test_matches_a_full_or_short_id() -> None:
    assert is_own_sump_container({"ID": "a1b2c3d4e5f6"}, "a1b2c3d4e5f6")
    assert not is_own_sump_container({"ID": "0123456789ab"}, "a1b2c3d4e5f6")
