"""REQ-000025-sJpO9KMY Requirements 1 and 2: the data streams and their
followed sets, kept in the Sump's data volume."""

import os
import sys
from pathlib import Path

import pytest
from sump_plugin_ssh.streams import Followed, StreamError, StreamStore, check_names, parse_target


def test_a_streams_identity_includes_its_ssh_user_host_and_port() -> None:
    a = parse_target("ops@lab", 22)
    b = parse_target("ops@lab", 2222)
    assert (a.id, b.id) == ("ssh:ops@lab:22", "ssh:ops@lab:2222")
    assert (a.label, b.label) == ("ops@lab", "ops@lab:2222")


@pytest.mark.parametrize(
    ("target", "port", "why"),
    [
        ("lab", 22, "user@host"),
        ("ops@lab; reboot", 22, "host name"),
        ("o ps@lab", 22, "user name"),
        ("ops@lab", 0, "1 to 65535"),
        ("ops@lab", True, "1 to 65535"),
    ],
)
def test_refuses_a_bad_target(target: str, port: object, why: str) -> None:
    with pytest.raises(StreamError, match=why):
        parse_target(target, port)


def test_names_are_checked_and_deduplicated() -> None:
    assert check_names(["web", "db", "web"], "containers") == ["db", "web"]
    with pytest.raises(StreamError):
        check_names(["web; rm"], "containers")
    with pytest.raises(StreamError):
        check_names("web", "containers")


def test_followed_sets_are_kept_per_stream_across_restarts(tmp_path: Path) -> None:
    path = tmp_path / "streams.json"
    store = StreamStore(path)
    a = store.add(parse_target("ops@lab", 22))
    b = store.add(parse_target("ops@lab", 2222))
    store.set_followed(a.id, Followed(["web", "db"], []))
    store.set_followed(b.id, Followed(["cache"], ["api"]))
    store.set_followed(a.id, Followed(["db"], []))
    again = StreamStore(path)
    assert [s.id for s in again.streams()] == [a.id, b.id]
    assert again.followed(a.id) == Followed(["db"], [])
    assert again.followed(b.id) == Followed(["cache"], ["api"])
    assert again.followed("ssh:nobody@else:22") == Followed()


def test_adding_a_stream_twice_keeps_one(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "streams.json")
    store.add(parse_target("ops@lab", 22))
    store.add(parse_target("ops@lab", 22))
    assert len(store.streams()) == 1


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_the_file_is_owner_only(tmp_path: Path) -> None:
    store = StreamStore(tmp_path / "streams.json")
    store.add(parse_target("ops@lab", 22))
    assert os.stat(store.path).st_mode & 0o077 == 0
