"""Writing a `.recording` on the Sump (REQ-000045-sJpO9KMY): cttc's archive
format version 3, as the app writes it (`app/main/src/recording/archive.ts`)
and reads it (`app/main/src/analysis/archive.ts`).

A zip of `manifest.json` (its one segment, each source's file, and the
manifest's integrity hash) and the segment's `seg0/stats/<n>.json` and
`seg0/logs/<n>.jsonl`. The hash is the SHA-256 of the manifest's canonical
JSON without the hash: keys sorted, no spaces, each value as written. The
manifest is written with the same encoder, so the app's check of it holds.
"""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from typing import Any


def _encode(value: Any, *, canonical: bool) -> str:
    """JSON as the manifest is written (and, canonical, as it is hashed)."""
    if canonical:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def manifest_hash(manifest: dict[str, Any]) -> str:
    """The manifest's integrity hash, as cttc and the app compute it."""
    bare = {k: v for k, v in manifest.items() if k != "integrity_sha256"}
    return hashlib.sha256(_encode(bare, canonical=True).encode()).hexdigest()


def recording_bytes(segment: dict[str, Any], created: str) -> bytes:
    """`segment` (as `correlate_sump.segment.segment` answers it) as a `.recording`."""
    files: dict[str, str] = {}
    sources: list[dict[str, Any]] = []
    for i, source in enumerate(segment.get("sources", [])):
        if source.get("type") == "stats":
            file = f"seg0/stats/{i}.json"
            files[file] = json.dumps({"series": source.get("series", {})})
            sources.append(
                {
                    "type": "stats",
                    "name": source.get("name", ""),
                    "file": file,
                    "is_host": source.get("is_host") is True,
                }
            )
        elif source.get("type") == "log":
            rows = source.get("rows", [])
            file = f"seg0/logs/{i}.jsonl"
            files[file] = "\n".join(json.dumps(r) for r in rows)
            sources.append(
                {"type": "log", "name": source.get("name", ""), "file": file, "count": len(rows)}
            )
    manifest: dict[str, Any] = {
        "version": 3,
        "segments": [
            {
                "from": int(segment["from"]),
                "to": int(segment["to"]),
                "created": created,
                "sources": sources,
            }
        ],
    }
    manifest["integrity_sha256"] = manifest_hash(manifest)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, body in files.items():
            archive.writestr(name, body)
        archive.writestr("manifest.json", _encode(manifest, canonical=False))
    return out.getvalue()
