"""REQ-000024-sJpO9KMY Requirement 2: the local and SSH transports, the SSH
one against an SSH server in the test process."""

import asyncio
import json
import sys

import paramiko
import pytest
from sump_plugin_ssh.identity import SumpIdentity
from sump_plugin_ssh.transport import SSH_FAILURE_RETURNCODE, LocalTransport, SSHTransport

PY = sys.executable

# --- local ---------------------------------------------------------------


async def test_local_run_takes_an_argument_list_without_a_shell() -> None:
    result = await LocalTransport().run([PY, "-c", "import sys; print(sys.argv[1])", "a; echo b"])
    assert result.returncode == 0
    assert result.stdout.strip() == "a; echo b"


async def test_local_run_reports_the_exit_code() -> None:
    result = await LocalTransport().run([PY, "-c", "import sys; sys.exit(3)"])
    assert result.returncode == 3


@pytest.mark.skipif(sys.platform == "win32", reason="the Sump runs on Linux; sh")
async def test_local_run_shell_supports_compound_commands() -> None:
    result = await LocalTransport().run_shell("echo a; echo b")
    assert result.stdout == "a\nb\n"


async def test_local_stream_merges_both_streams() -> None:
    code = "import sys; print('out1'); print('err1', file=sys.stderr); print('out2')"
    lines = []
    async with LocalTransport().stream_lines([PY, "-c", code]) as it:
        async for line in it:
            lines.append((line.stream, line.text.strip()))
    assert set(lines) == {("stdout", "out1"), ("stderr", "err1"), ("stdout", "out2")}


async def test_local_stream_is_killed_on_leaving() -> None:
    code = "import time\nwhile True:\n print('tick', flush=True); time.sleep(0.05)"
    async with LocalTransport().stream_lines([PY, "-c", code]) as it:
        async for _line in it:
            break
    # Leaving the block returned: the process was killed, not waited for.


# --- SSH -----------------------------------------------------------------


def _docker(answers: dict[str, tuple[list[str], list[str], int]]):
    def handler(command: str):
        return answers.get(command, ([], [f"unknown: {command}"], 127))

    return handler


async def test_ssh_runs_with_the_sumps_own_key(identity: SumpIdentity, ssh_server) -> None:
    server = ssh_server(_docker({"uptime": (["up 3 days"], [], 0)}))
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    result = await transport.run(["uptime"])
    assert (result.returncode, result.stdout) == (0, "up 3 days\n")
    assert server.commands == ["uptime"]


async def test_ssh_quotes_arguments_for_the_remote_shell(
    identity: SumpIdentity, ssh_server
) -> None:
    server = ssh_server(lambda command: ([command], [], 0))
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    result = await transport.run(["echo", "a; rm -rf /"])
    assert result.stdout.strip() == "echo 'a; rm -rf /'"


async def test_ssh_reports_a_refused_key_as_255(identity: SumpIdentity, ssh_server) -> None:
    server = ssh_server(_docker({}), user="someone-else")
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    result = await transport.run(["uptime"])
    assert result.returncode == SSH_FAILURE_RETURNCODE
    assert "ssh connect failed" in result.stderr


async def test_ssh_reports_an_unreachable_host_as_255(identity: SumpIdentity) -> None:
    transport = SSHTransport("127.0.0.1", "ops", port=1, identity=identity)
    result = await transport.run(["uptime"])
    assert result.returncode == SSH_FAILURE_RETURNCODE


async def test_ssh_pins_a_host_key_and_refuses_a_changed_one(
    identity: SumpIdentity, ssh_server
) -> None:
    first = ssh_server(_docker({"uptime": (["ok"], [], 0)}))
    transport = SSHTransport("127.0.0.1", "ops", port=first.port, identity=identity)
    assert (await transport.run(["uptime"])).returncode == 0
    recorded = identity.known_hosts.read_text()
    assert f"[127.0.0.1]:{first.port}" in recorded
    assert first.host_key.get_base64() in recorded
    # The same host and port answering with another key: refused.
    first.close()
    other = ssh_server(_docker({"uptime": (["ok"], [], 0)}))
    impostor = SSHTransport("127.0.0.1", "ops", port=other.port, identity=identity)
    # Record the impostor's port under the first key, as if the host changed key.
    identity.known_hosts.write_text(
        recorded.replace(f"[127.0.0.1]:{first.port}", f"[127.0.0.1]:{other.port}")
    )
    result = await impostor.run(["uptime"])
    assert result.returncode == SSH_FAILURE_RETURNCODE
    assert f"the host key of 127.0.0.1:{other.port} changed" in result.stderr
    assert other.commands == []


async def test_ssh_runs_docker_plainly_when_the_user_may(
    identity: SumpIdentity, ssh_server
) -> None:
    server = ssh_server(_docker({"docker version": (["ok"], [], 0), "docker ps": (["row"], [], 0)}))
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    assert (await transport.run(["docker", "ps"])).stdout == "row\n"
    assert (await transport.run(["docker", "ps"])).returncode == 0
    assert server.commands == ["docker version", "docker ps", "docker ps"]


async def test_ssh_runs_docker_with_sudo_n_when_the_socket_is_denied(
    identity: SumpIdentity, ssh_server
) -> None:
    denied = "permission denied while trying to connect to the Docker daemon socket"
    server = ssh_server(
        _docker(
            {
                "docker version": ([], [denied], 1),
                "sudo -n docker ps": (["row"], [], 0),
            }
        )
    )
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    assert (await transport.run(["docker", "ps"])).stdout == "row\n"
    assert server.commands == ["docker version", "sudo -n docker ps"]


async def test_ssh_streams_lines_and_stops_on_leaving(identity: SumpIdentity, ssh_server) -> None:
    def handler(command: str):
        if command == "docker version":
            return (["ok"], [], 0)
        return (json.dumps({"n": i}) for i in range(1000))

    server = ssh_server(handler)
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    seen = []
    async with asyncio.timeout(10):
        async with transport.stream_lines(["docker", "logs", "-f", "c1"]) as lines:
            async for line in lines:
                seen.append(json.loads(line.text)["n"])
                if len(seen) == 3:
                    break
    assert seen == [0, 1, 2]
    assert server.commands[-1] == "docker logs -f c1"


async def test_ssh_stream_reports_a_failed_connection_as_a_stderr_line(
    identity: SumpIdentity,
) -> None:
    transport = SSHTransport("127.0.0.1", "ops", port=1, identity=identity)
    async with asyncio.timeout(15):
        async with transport.stream_lines(["uptime"]) as lines:
            got = [line async for line in lines]
    assert len(got) == 1
    assert got[0].stream == "stderr"
    assert got[0].text.startswith("ssh connect failed")


def test_paramiko_never_uses_an_agent_or_home_keys(identity: SumpIdentity, monkeypatch) -> None:
    seen = {}

    def connect(self, *args, **kwargs):
        seen.update(kwargs)
        raise OSError("stop")

    monkeypatch.setattr(paramiko.SSHClient, "connect", connect)
    transport = SSHTransport("h", "ops", identity=identity)
    with pytest.raises(OSError):
        transport._connect()
    assert seen["allow_agent"] is False
    assert seen["look_for_keys"] is False
    assert isinstance(seen["pkey"], paramiko.Ed25519Key)


async def test_a_forgotten_host_key_is_recorded_afresh(identity: SumpIdentity, ssh_server) -> None:
    from sump_plugin_ssh.transport import forget_host_key

    server = ssh_server(_docker({"uptime": (["ok"], [], 0)}))
    transport = SSHTransport("127.0.0.1", "ops", port=server.port, identity=identity)
    assert (await transport.run(["uptime"])).returncode == 0
    assert forget_host_key(identity, "127.0.0.1", server.port) is True
    assert f"[127.0.0.1]:{server.port}" not in identity.known_hosts.read_text()
    assert forget_host_key(identity, "127.0.0.1", server.port) is False
