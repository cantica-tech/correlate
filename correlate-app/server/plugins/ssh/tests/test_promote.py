"""br-FED-000001-sJpO9KMY (REQ-000052-sJpO9KMY step 1): provisioning a
secondary Sump on a stream's host through the parent's SSH access."""

import base64
import re
from dataclasses import dataclass, field
from typing import Any

import pytest
from sump_plugin_ssh.promote import (
    SECONDARY_DIR,
    PromoteError,
    compose_file,
    provision_secondary,
)

from correlate_sump.transport import ExecResult


@dataclass
class Shell:
    """A host: answers each script by the first rule whose text it holds."""

    fail_on: str = ""
    healthy_after: int = 0
    scripts: list[str] = field(default_factory=list)
    probes: int = 0

    async def docker_prefix(self) -> list[str]:
        return ["sudo", "-n", "docker"]

    async def run(self, args: list[str]) -> ExecResult:
        assert args[:2] == ["sh", "-c"]
        script = args[2]
        self.scripts.append(script)
        if self.fail_on and self.fail_on in script:
            return ExecResult(1, "", f"{self.fail_on} went wrong")
        if "--entrypoint stat" in script:
            return ExecResult(0, "998\n", "")
        if "exec -T sump python -c" in script:
            self.probes += 1
            ok = self.probes > self.healthy_after
            return ExecResult(0 if ok else 1, "True\n" if ok else "", "")
        return ExecResult(0, "", "")


async def _promote(shell: Shell, **overrides) -> None:
    slept: list[float] = []

    async def sleep(s: float) -> None:
        slept.append(s)

    kwargs: dict[str, Any] = {
        "image": "ghcr.io/cantica/correlate-sump:1.2.3",
        "owner": "alice",
        "owner_key": "ssh-ed25519 AAAAowner alice@laptop",
        "parent_user": "parent-sump",
        "parent_key": "ssh-ed25519 AAAAparent sump",
        "health_timeout": 10.0,
        "poll": 2.0,
        "sleep": sleep,
    } | overrides
    await provision_secondary(shell, **kwargs)


def _decoded(script: str) -> list[str]:
    return [base64.b64decode(b).decode() for b in re.findall(r"printf %s (\S+) \| base64", script)]


async def test_provisions_the_secondary_and_makes_the_promoter_its_owner() -> None:
    shell = Shell(healthy_after=2)
    await _promote(shell)
    joined = "\n".join(shell.scripts)
    assert "sudo -n docker version" in shell.scripts[0]
    assert "image inspect ghcr.io/cantica/correlate-sump:1.2.3" in joined
    compose = next(s for s in shell.scripts if "docker-compose.yml" in s and "printf" in s)
    text = _decoded(compose)[0]
    assert text == compose_file("ghcr.io/cantica/correlate-sump:1.2.3", 8775, 998, 5150)
    assert '"127.0.0.1:8775:8765"' in text and '"127.0.0.1:5150:5140"' in text
    assert "up -d" in joined and shell.probes == 3
    owner = next(s for s in shell.scripts if "set-owner" in s)
    assert _decoded(owner) == ["ssh-ed25519 AAAAowner alice@laptop"]
    assert owner.endswith("set-owner --user alice")
    parent = next(s for s in shell.scripts if "add-key" in s)
    assert _decoded(parent) == ["ssh-ed25519 AAAAparent sump"]
    assert "down -v" not in joined


@pytest.mark.parametrize(
    ("fail_on", "cleaned"),
    [("version", False), ("pull", False), ("up -d", True), ("add-key", True)],
)
async def test_a_failure_leaves_nothing_running(fail_on: str, cleaned: bool) -> None:
    shell = Shell(fail_on=fail_on)
    if fail_on == "pull":
        shell.fail_on = "image inspect"
    with pytest.raises(PromoteError):
        await _promote(shell)
    last = shell.scripts[-1]
    assert (f"down -v --rmi local; rm -rf {SECONDARY_DIR}" in last) is cleaned


async def test_a_sump_that_never_answers_is_taken_down() -> None:
    shell = Shell(healthy_after=100)
    with pytest.raises(PromoteError, match="wait for the Sump"):
        await _promote(shell)
    assert "down -v" in shell.scripts[-1]


@pytest.mark.parametrize(
    "override",
    [
        {"owner": "alice; reboot"},
        {"parent_user": "$(id)"},
        {"image": "img`id`"},
        {"image": "img with space"},
    ],
)
async def test_refuses_names_and_images_a_shell_would_read(override) -> None:
    shell = Shell()
    with pytest.raises(PromoteError, match="check"):
        await _promote(shell, **override)
    assert shell.scripts == []
