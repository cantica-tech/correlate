"""`LocalTransport` and `SSHTransport` (REQ-000024-sJpO9KMY Requirement 2).

Ported from correlator's `sump-plugin-ssh` (itself from log-sump) onto
`correlate_sump.transport.Transport`, with three changes correlate-app's
rules need:

- SSH uses the Sump's own key (`identity.py`), never an agent or `~/.ssh`,
  which a container does not have.
- Host keys are pinned: recorded at the first connection to a host and port
  in the Sump's `known_hosts`, a different key later refused. correlator
  accepted any key.
- `docker` runs as `sudo -n docker` only when the SSH user may not use
  Docker (found once per transport), never prompting for a password;
  correlator always prepended `sudo`.

A failure to connect or run is never raised: it is reported as exit code 255
with its reason, as a failed `ssh` process would.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import select
import shlex
import threading
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from typing import Literal

import paramiko

from correlate_sump.transport import ExecResult, StreamLine, Transport, merge_streams
from sump_plugin_ssh.identity import SumpIdentity

logger = logging.getLogger(__name__)


class LocalTransport(Transport):
    """Runs commands on the Sump's own machine, as argument lists, no shell.

    Used for the "self" data source, through the host's Docker socket
    mounted into the Sump's container.
    """

    def _shell_command(self, script: str) -> list[str]:
        # No ssh, so no implicit remote shell: this process invokes one.
        return ["sh", "-c", script]

    async def run(self, args: Sequence[str]) -> ExecResult:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await proc.communicate()
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        return ExecResult(
            returncode=proc.returncode or 0,
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
        )

    @contextlib.asynccontextmanager
    async def stream_lines(self, args: Sequence[str]) -> AsyncGenerator[AsyncIterator[StreamLine]]:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdout is not None
        assert proc.stderr is not None
        lines: AsyncGenerator[StreamLine] = merge_streams(proc.stdout, proc.stderr)
        try:
            yield lines
        finally:
            await lines.aclose()
            if proc.returncode is None:
                proc.kill()
                await proc.wait()


#: How often the streaming thread re-checks for cancellation between reads.
_SSH_POLL_INTERVAL_S = 0.5
#: How a connection or command failure is reported: OpenSSH's own exit code
#: for "could not connect".
SSH_FAILURE_RETURNCODE = 255
#: How long a connection may take.
SSH_CONNECT_TIMEOUT_S = 10

#: One connection at a time reads and writes `known_hosts`, so no recorded
#: host key is lost to another connection's write.
_known_hosts_lock = threading.Lock()


def forget_host_key(identity: SumpIdentity, host: str, port: int) -> bool:
    """Drop the recorded key of `host:port` from the Sump's `known_hosts`; whether one was there."""
    name = host if port == 22 else f"[{host}]:{port}"
    with _known_hosts_lock:
        keys = paramiko.HostKeys(str(identity.known_hosts))
        if keys.lookup(name) is None:
            return False
        del keys[name]
        keys.save(str(identity.known_hosts))
    return True


class HostKeyChanged(paramiko.SSHException):
    """A host answered with another key than the one recorded for it."""


class SSHTransport(Transport):
    """Reaches a host over SSH with `paramiko`, never the `ssh` binary."""

    def __init__(self, host: str, user: str, *, port: int = 22, identity: SumpIdentity) -> None:
        self._host = host
        self._user = user
        self._port = port
        self._identity = identity
        #: Whether `docker` needs `sudo -n` on this host; found on first use.
        self._sudo: bool | None = None

    @property
    def target(self) -> str:
        """`user@host:port`, for messages."""
        return f"{self._user}@{self._host}:{self._port}"

    def _shell_command(self, script: str) -> list[str]:
        # One command string: paramiko's exec_command runs it through the
        # remote login shell already.
        return [script]

    def _connect(self) -> paramiko.SSHClient:
        client = paramiko.SSHClient()
        key = paramiko.Ed25519Key.from_private_key_file(str(self._identity.private_key))
        with _known_hosts_lock:
            # A recorded key must match (BadHostKeyException otherwise); a host
            # met for the first time is recorded in the file just loaded.
            client.load_host_keys(str(self._identity.known_hosts))
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            try:
                client.connect(
                    self._host,
                    port=self._port,
                    username=self._user,
                    pkey=key,
                    allow_agent=False,
                    look_for_keys=False,
                    timeout=SSH_CONNECT_TIMEOUT_S,
                    banner_timeout=SSH_CONNECT_TIMEOUT_S,
                    auth_timeout=SSH_CONNECT_TIMEOUT_S,
                )
            except paramiko.BadHostKeyException as exc:
                client.close()
                logger.warning("refused %s: its host key changed", self.target)
                raise HostKeyChanged(
                    f"the host key of {self._host}:{self._port} changed "
                    f"({exc.key.get_name()} {exc.key.fingerprint}); refusing to connect"
                ) from exc
        return client

    async def _docker(self, args: Sequence[str]) -> Sequence[str]:
        """`args`, with `sudo -n` before `docker` when this host needs it."""
        if not args or args[0] != "docker":
            return args
        if self._sudo is None:
            probe = await asyncio.to_thread(self._run_sync, shlex.join(["docker", "version"]))
            denied = "permission denied" in probe.stderr.lower()
            self._sudo = probe.returncode != 0 and denied
        return ["sudo", "-n", *args] if self._sudo else args

    async def run(self, args: Sequence[str]) -> ExecResult:
        command = shlex.join(await self._docker(args))
        return await asyncio.to_thread(self._run_sync, command)

    def _run_sync(self, command: str) -> ExecResult:
        try:
            client = self._connect()
        except Exception as exc:  # noqa: BLE001 -- reported, as a failed ssh process would
            return ExecResult(
                returncode=SSH_FAILURE_RETURNCODE, stdout="", stderr=f"ssh connect failed: {exc}"
            )
        try:
            _stdin, stdout, stderr = client.exec_command(command)
            out = stdout.read().decode(errors="replace")
            err = stderr.read().decode(errors="replace")
            code = stdout.channel.recv_exit_status()
            return ExecResult(returncode=code, stdout=out, stderr=err)
        except Exception as exc:  # noqa: BLE001
            return ExecResult(
                returncode=SSH_FAILURE_RETURNCODE, stdout="", stderr=f"ssh command failed: {exc}"
            )
        finally:
            client.close()

    @contextlib.asynccontextmanager
    async def stream_lines(self, args: Sequence[str]) -> AsyncGenerator[AsyncIterator[StreamLine]]:
        command = shlex.join(await self._docker(args))
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[StreamLine | None] = asyncio.Queue()
        stop_event = threading.Event()
        state: dict[str, paramiko.SSHClient] = {}

        def emit(buf: bytes, chunk: bytes, stream: Literal["stdout", "stderr"]) -> bytes:
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                item = StreamLine(stream=stream, text=line.decode(errors="replace"))
                loop.call_soon_threadsafe(queue.put_nowait, item)
            return buf

        def worker() -> None:
            try:
                client = self._connect()
            except Exception as exc:  # noqa: BLE001 -- a stderr line, as a failed ssh would give
                error_line = StreamLine(stream="stderr", text=f"ssh connect failed: {exc}")
                loop.call_soon_threadsafe(queue.put_nowait, error_line)
                loop.call_soon_threadsafe(queue.put_nowait, None)
                return
            state["client"] = client
            try:
                if stop_event.is_set():
                    return
                _stdin, stdout, _stderr = client.exec_command(command)
                channel = stdout.channel
                channel.setblocking(False)
                stdout_buf = b""
                stderr_buf = b""
                while not stop_event.is_set():
                    readable, _, _ = select.select([channel], [], [], _SSH_POLL_INTERVAL_S)
                    read_any = False
                    if channel in readable:
                        if channel.recv_ready():
                            chunk = channel.recv(4096)
                            if chunk:
                                read_any = True
                                stdout_buf = emit(stdout_buf, chunk, "stdout")
                        if channel.recv_stderr_ready():
                            chunk = channel.recv_stderr(4096)
                            if chunk:
                                read_any = True
                                stderr_buf = emit(stderr_buf, chunk, "stderr")
                    if not read_any and channel.exit_status_ready():
                        break
            except (OSError, EOFError, paramiko.SSHException):
                # A channel closed by our own cancellation, or the host going
                # away mid-read: how a forced stop looks from this thread.
                pass
            finally:
                client.close()
                loop.call_soon_threadsafe(queue.put_nowait, None)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        async def _lines() -> AsyncGenerator[StreamLine]:
            while True:
                item = await queue.get()
                if item is None:
                    return
                yield item

        gen = _lines()
        try:
            yield gen
        finally:
            stop_event.set()
            client = state.get("client")
            if client is not None:
                # Closing the client is what unblocks a worker parked in
                # select() or recv() on a long-lived command (`docker logs -f`).
                client.close()
            await gen.aclose()
            await asyncio.to_thread(thread.join, 5)
