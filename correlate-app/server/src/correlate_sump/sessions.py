"""Per-user session tokens (br-CONN-000004-sJpO9KMY, REQ-000010-sJpO9KMY).

A token is a random 256-bit string the Sump gives a user after the SSH-key
login of roadmap Item 12. The Sump keeps only its SHA-256 hash, in Redis
under `sump:session:<hash>`, with the user, when it was issued and when it
ends at the latest. The record expires after `SUMP_SESSION_IDLE_SECONDS`
(12 hours) without use; each use renews that, never past the end
(`SUMP_SESSION_MAX_SECONDS`, 7 days after issue).

A record that is not what `issue` wrote raises `CorruptSessionStore`: the
request is refused and the record left as it is. cttc treated a corrupt token
file as empty and minted new tokens over it (cttc BUG-000011-uKKrzikI).

Tokens are issued by the SSH-key login (br-CONN-000007-sJpO9KMY): the Sump
hands out a single-use challenge, valid `CHALLENGE_SECONDS`, kept in Redis
under `sump:challenge:<hash>` with the user it was asked for.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

#: Where a token's record lives: this prefix and the token's SHA-256 in hex.
KEY_PREFIX = "sump:session:"

#: How long a token lives without use, and at most (br-CONN-000004).
DEFAULT_IDLE_SECONDS = 12 * 60 * 60
DEFAULT_MAX_SECONDS = 7 * 24 * 60 * 60

#: Bytes of randomness in a token, and in a login challenge.
TOKEN_BYTES = 32

#: Where login challenges live, and for how long (br-CONN-000007).
CHALLENGE_PREFIX = "sump:challenge:"
CHALLENGE_SECONDS = 60


class CorruptSessionStore(Exception):
    """A session record is not what `issue` writes; it is refused, never replaced."""


@dataclass(frozen=True)
class Session:
    """Who a token belongs to, when it was issued and when it ends at the latest."""

    user: str
    issued_at: int
    ends_at: int


def _challenge_key(challenge: str) -> str:
    return CHALLENGE_PREFIX + hashlib.sha256(challenge.encode()).hexdigest()


def token_key(token: str) -> str:
    """The Redis key of a token's record; the token itself is never stored."""
    return KEY_PREFIX + hashlib.sha256(token.encode()).hexdigest()


def _positive_seconds(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        raise ValueError(f"{name} must be a positive whole number of seconds, got {raw!r}")
    return value


def session_limits_from_env(env: Mapping[str, str]) -> tuple[int, int]:
    """`SUMP_SESSION_IDLE_SECONDS` and `SUMP_SESSION_MAX_SECONDS`; an invalid
    value raises `ValueError`, so the Sump refuses to start."""
    idle = _positive_seconds(env, "SUMP_SESSION_IDLE_SECONDS", DEFAULT_IDLE_SECONDS)
    most = _positive_seconds(env, "SUMP_SESSION_MAX_SECONDS", DEFAULT_MAX_SECONDS)
    return idle, most


class SessionStore:
    """Issue, check, renew and revoke tokens in Redis.

    `clock` returns the time in whole seconds (`time.time` outside tests).
    """

    def __init__(
        self,
        redis_client: Any,
        idle_seconds: int = DEFAULT_IDLE_SECONDS,
        max_seconds: int = DEFAULT_MAX_SECONDS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.redis = redis_client
        self.idle_seconds = idle_seconds
        self.max_seconds = max_seconds
        self.clock = clock

    def _now(self) -> int:
        return int(self.clock())

    async def issue(self, user: str) -> str:
        """A new token for `user`."""
        if not user:
            raise ValueError("a session needs a user")
        token = secrets.token_urlsafe(TOKEN_BYTES)
        now = self._now()
        key = token_key(token)
        record = {"user": user, "issued_at": str(now), "ends_at": str(now + self.max_seconds)}
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.hset(key, mapping=record)
            pipe.expire(key, min(self.idle_seconds, self.max_seconds))
            await pipe.execute()
        return token

    async def check(self, token: str) -> Session | None:
        """The token's session, its idle expiry renewed; `None` if it is not
        valid. Raises `CorruptSessionStore` for a record `issue` did not write."""
        key = token_key(token)
        try:
            raw = await self.redis.hgetall(key)
        except Exception as exc:
            if "WRONGTYPE" in str(exc):
                raise CorruptSessionStore(f"{key} is not a session record") from exc
            raise
        if not raw:
            return None
        session = self._parse(key, raw)
        now = self._now()
        if now >= session.ends_at:
            await self.redis.delete(key)
            return None
        await self.redis.expire(key, min(self.idle_seconds, session.ends_at - now))
        return session

    async def revoke(self, token: str) -> None:
        """Forget the token."""
        await self.redis.delete(token_key(token))

    async def new_challenge(self, user: str) -> str:
        """A fresh login challenge for `user`, valid `CHALLENGE_SECONDS`, once."""
        challenge = secrets.token_urlsafe(TOKEN_BYTES)
        await self.redis.set(_challenge_key(challenge), user, ex=CHALLENGE_SECONDS)
        return challenge

    async def take_challenge(self, challenge: str) -> str | None:
        """The user a challenge was issued to, consuming it; `None` when it is
        unknown, used or expired."""
        user = await self.redis.getdel(_challenge_key(challenge))
        if user is None:
            return None
        return user.decode() if isinstance(user, bytes) else str(user)

    @staticmethod
    def _parse(key: str, raw: Mapping[Any, Any]) -> Session:
        fields = {
            (k.decode() if isinstance(k, bytes) else str(k)): (
                v.decode() if isinstance(v, bytes) else str(v)
            )
            for k, v in raw.items()
        }
        try:
            session = Session(
                user=fields["user"],
                issued_at=int(fields["issued_at"]),
                ends_at=int(fields["ends_at"]),
            )
        except (KeyError, ValueError) as exc:
            raise CorruptSessionStore(f"{key} is not a session record: {exc!r}") from exc
        if not session.user or session.ends_at <= session.issued_at:
            raise CorruptSessionStore(f"{key} is not a session record: impossible values")
        return session
