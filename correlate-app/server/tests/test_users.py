"""Users, keys, the owner and the SSH-key login (br-CONN-000007-sJpO9KMY,
REQ-000011-sJpO9KMY Requirements 2 and 3)."""

import io
import os
import stat
import sys

import fakeredis.aioredis
import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

from correlate_sump.app import create_app
from correlate_sump.sessions import CHALLENGE_SECONDS
from correlate_sump.sshsig import LOGIN_NAMESPACE, public_key_of, sign
from correlate_sump.users import CorruptKeyStore, UserError, UserStore, main

POSIX = sys.platform != "win32"


def new_key():
    return ed25519.Ed25519PrivateKey.generate()


def line(key, comment: str = "") -> str:
    return public_key_of(key, comment).line()


# -- the store ---------------------------------------------------------------


def test_add_list_and_remove_keys(tmp_path) -> None:
    store = UserStore(tmp_path)
    a, b = new_key(), new_key()
    store.add_key("alice", line(a, "laptop"))
    store.add_key("alice", line(a, "laptop"))  # the same key once
    store.add_key("alice", line(b))
    assert store.users() == ["alice"]
    assert [k.comment for k in store.keys("alice")] == ["laptop", ""]
    store.remove_key("alice", public_key_of(a).fingerprint)
    assert [k.blob for k in store.keys("alice")] == [public_key_of(b).blob]
    store.remove_key("alice", public_key_of(b).fingerprint)
    assert store.users() == []
    with pytest.raises(LookupError):
        store.remove_key("alice", "SHA256:none")


def test_files_are_written_owner_only_in_authorized_keys_format(tmp_path) -> None:
    store = UserStore(tmp_path)
    key = new_key()
    store.set_owner("alice", line(key, "laptop"))
    text = (tmp_path / "keys" / "alice.authorized_keys").read_text()
    assert text == f"{line(key, 'laptop')}\n"
    assert (tmp_path / "owner").read_text() == "alice\n"
    assert [p.name for p in (tmp_path / "keys").iterdir()] == ["alice.authorized_keys"]
    if POSIX:
        for path in (tmp_path / "keys", tmp_path / "keys" / "alice.authorized_keys"):
            assert stat.S_IMODE(os.stat(path).st_mode) & 0o077 == 0


@pytest.mark.parametrize("name", ["", "Alice", "a/b", "..", "a b", "x" * 65, "é"])
def test_user_names_are_checked(tmp_path, name) -> None:
    with pytest.raises(UserError):
        UserStore(tmp_path).add_key(name, line(new_key()))


def test_refused_key_types_are_not_added(tmp_path) -> None:
    short = rsa.generate_private_key(65537, 2048)
    with pytest.raises(UserError, match="3072"):
        UserStore(tmp_path).add_key("alice", public_key_of_unchecked(short))


def public_key_of_unchecked(private_key) -> str:
    from cryptography.hazmat.primitives import serialization

    return (
        private_key.public_key()
        .public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH)
        .decode()
    )


def test_the_owners_last_key_stays(tmp_path) -> None:
    store = UserStore(tmp_path)
    key = new_key()
    store.set_owner("alice", line(key))
    with pytest.raises(UserError, match="last key"):
        store.remove_key("alice", public_key_of(key).fingerprint)


def test_a_different_owner_needs_replace(tmp_path) -> None:
    store = UserStore(tmp_path)
    store.set_owner("alice", line(new_key()))
    store.set_owner("alice", line(new_key()))  # same owner, another key: fine
    with pytest.raises(UserError, match="already owns"):
        store.set_owner("bob", line(new_key()))
    store.set_owner("bob", line(new_key()), replace=True)
    assert store.owner() == "bob"


@pytest.mark.parametrize(
    ("relative", "content"),
    [
        ("keys/alice.authorized_keys", "ssh-ed25519 garbage!!\n"),
        ("keys/alice.authorized_keys", "ssh-dss AAAAB3NzaC1kc3M=\n"),
        ("owner", "Not A Name\n"),
    ],
)
def test_a_corrupt_store_is_refused_and_left_alone(tmp_path, relative, content) -> None:
    store = UserStore(tmp_path)
    store.set_owner("alice", line(new_key()))
    (tmp_path / relative).write_text(content)
    with pytest.raises(CorruptKeyStore):
        store.keys("alice") if relative.startswith("keys") else store.owner()
    assert (tmp_path / relative).read_text() == content


def test_the_owner_command(tmp_path, monkeypatch, capsys) -> None:
    env = {"SUMP_DATA_DIR": str(tmp_path)}
    key = new_key()
    monkeypatch.setattr("sys.stdin", io.StringIO(line(key, "laptop") + "\n"))
    assert main(["set-owner", "--user", "alice"], env) == 0
    assert "alice owns this Sump (ssh-ed25519 SHA256:" in capsys.readouterr().out
    monkeypatch.setattr("sys.stdin", io.StringIO(line(new_key())))
    assert main(["set-owner", "--user", "bob"], env) == 1
    assert "already owns" in capsys.readouterr().err
    assert main(["list"], env) == 0
    assert capsys.readouterr().out.startswith("alice (owner) ssh-ed25519 SHA256:")


# -- the login and the owner routes ------------------------------------------


@pytest.fixture
def sump(tmp_path):
    """The app, its user store with alice as owner, and alice's key."""
    redis_client = fakeredis.aioredis.FakeRedis()
    app = create_app(
        redis_client=redis_client, env={"SUMP_DATA_DIR": str(tmp_path)}, start_ingest=False
    )
    key = new_key()
    app.state.users.set_owner("alice", line(key))
    return app, key, redis_client


async def post(app, path: str, json: dict, token: str | None = None) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
        return await client.post(path, json=json, headers=headers)


async def send(app, method: str, path: str, token: str, json: dict | None = None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://sump") as client:
        return await client.request(
            method, path, json=json, headers={"Authorization": f"Bearer {token}"}
        )


async def log_in(app, user: str, key) -> httpx.Response:
    challenge = (await post(app, "/session/challenge", {"user": user})).json()
    assert challenge["namespace"] == LOGIN_NAMESPACE
    assert challenge["expires_in"] == CHALLENGE_SECONDS
    signature = sign(key, challenge["challenge"].encode(), LOGIN_NAMESPACE)
    body = {"user": user, "challenge": challenge["challenge"], "signature": signature}
    return await post(app, "/session/login", body)


async def test_login_issues_a_working_token(sump) -> None:
    app, key, _ = sump
    async with app.router.lifespan_context(app):
        response = await log_in(app, "alice", key)
        assert response.status_code == 200
        body = response.json()
        assert body["user"] == "alice" and body["owner"] is True
        plugins = await send(app, "GET", "/plugins", body["token"])
        assert plugins.status_code == 200


async def test_refusals_all_look_the_same(sump) -> None:
    app, key, _ = sump
    async with app.router.lifespan_context(app):
        stranger = new_key()
        c = (await post(app, "/session/challenge", {"user": "alice"})).json()["challenge"]
        wrong_key = await post(
            app,
            "/session/login",
            {
                "user": "alice",
                "challenge": c,
                "signature": sign(stranger, c.encode(), LOGIN_NAMESPACE),
            },
        )
        reused = await post(
            app,
            "/session/login",
            {"user": "alice", "challenge": c, "signature": sign(key, c.encode(), LOGIN_NAMESPACE)},
        )
        c2 = (await post(app, "/session/challenge", {"user": "bob"})).json()["challenge"]
        other_user = await post(
            app,
            "/session/login",
            {
                "user": "alice",
                "challenge": c2,
                "signature": sign(key, c2.encode(), LOGIN_NAMESPACE),
            },
        )
        unknown_user = await log_in(app, "carol", key)
        made_up = await post(
            app, "/session/login", {"user": "alice", "challenge": "x", "signature": "y"}
        )
    for response in (wrong_key, reused, other_user, unknown_user, made_up):
        assert response.status_code == 401
        assert response.json() == {"detail": "login refused"}


async def test_a_challenge_expires(sump) -> None:
    app, key, redis_client = sump
    async with app.router.lifespan_context(app):
        c = (await post(app, "/session/challenge", {"user": "alice"})).json()["challenge"]
        keys = await redis_client.keys("sump:challenge:*")
        assert 0 < await redis_client.ttl(keys[0]) <= CHALLENGE_SECONDS
        await redis_client.delete(*keys)  # as if 60 s had passed
        late = await post(
            app,
            "/session/login",
            {"user": "alice", "challenge": c, "signature": sign(key, c.encode(), LOGIN_NAMESPACE)},
        )
    assert late.status_code == 401


async def test_a_corrupt_key_store_answers_503_and_is_left_alone(sump, tmp_path) -> None:
    app, key, _ = sump
    path = tmp_path / "keys" / "alice.authorized_keys"
    path.write_text("ssh-ed25519 garbage!!\n")
    async with app.router.lifespan_context(app):
        response = await log_in(app, "alice", key)
    assert response.status_code == 503
    assert path.read_text() == "ssh-ed25519 garbage!!\n"


async def test_the_owner_manages_users_and_others_cannot(sump) -> None:
    app, key, _ = sump
    async with app.router.lifespan_context(app):
        owner = (await log_in(app, "alice", key)).json()["token"]
        bob_key = new_key()
        added = await send(
            app, "POST", "/users/bob/keys", owner, {"public_key": line(bob_key, "bob@desk")}
        )
        assert added.status_code == 201
        assert added.json()["fingerprint"] == public_key_of(bob_key).fingerprint
        bob = (await log_in(app, "bob", bob_key)).json()
        assert bob["owner"] is False
        for method, path, body in [
            ("GET", "/users", None),
            ("POST", "/users/bob/keys", {"public_key": line(new_key())}),
            ("DELETE", f"/users/alice/keys/{public_key_of(key).fingerprint}", None),
        ]:
            assert (await send(app, method, path, bob["token"], body)).status_code == 403
        listing = (await send(app, "GET", "/users", owner)).json()
        assert listing["owner"] == "alice"
        assert [u["user"] for u in listing["users"]] == ["alice", "bob"]
        fingerprint = public_key_of(bob_key).fingerprint
        removed = await send(app, "DELETE", f"/users/bob/keys/{fingerprint}", owner)
        assert removed.status_code == 204
        last = await send(
            app, "DELETE", f"/users/alice/keys/{public_key_of(key).fingerprint}", owner
        )
        assert last.status_code == 409
        bad = await send(app, "POST", "/users/bob/keys", owner, {"public_key": "nonsense"})
        assert bad.status_code == 422


async def test_a_bad_user_name_gets_no_challenge(sump) -> None:
    app, _, _ = sump
    async with app.router.lifespan_context(app):
        response = await post(app, "/session/challenge", {"user": "../etc"})
    assert response.status_code == 422
