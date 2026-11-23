"""Each log-sump stream's server and API key, and the relay's place in it,
kept in the Sump's data folder, owner-only (br-STREAM-000010,
br-STREAM-000011-sJpO9KMY): `logsump/streams.json`, written whole and
atomically, readable by nobody but the Sump's user, never sent back.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


class LogSumpStore:
    """`{stream id: {url, api_key, docker_host, since, seen}}`, on disk."""

    def __init__(self, folder: Path) -> None:
        self.path = folder / "streams.json"
        self._lock = threading.Lock()
        self._data: dict[str, dict[str, Any]] = {}
        if self.path.exists():
            self._data = dict(json.loads(self.path.read_text(encoding="utf-8")))

    def get(self, stream_id: str) -> dict[str, Any] | None:
        found = self._data.get(stream_id)
        return dict(found) if found else None

    def put(self, stream_id: str, entry: dict[str, Any]) -> None:
        with self._lock:
            self._data[stream_id] = dict(entry)
            self._save()

    def update(self, stream_id: str, **changes: Any) -> None:
        with self._lock:
            if stream_id in self._data:
                self._data[stream_id] = {**self._data[stream_id], **changes}
                self._save()

    def remove(self, stream_id: str) -> None:
        with self._lock:
            if self._data.pop(stream_id, None) is not None:
                self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)
        os.replace(tmp, self.path)
