"""Check br-BUILD-000007 (one version for the app and the Sump).

The app's version (`app/package.json`) and the Sump's (`server/pyproject.toml`)
must be equal; given `--tag`, the tag must be `v<version>` (a release's).
Prints the version, or what differs and exits 1.

Usage: python scripts/check_versions.py [--tag vX.Y.Z] [repository root]
(default root: this script's parent folder). Standard library only.
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path


def versions(root: Path) -> dict[str, str]:
    """The app's and the Sump's versions, by where they are written."""
    app = json.loads((root / "app" / "package.json").read_text(encoding="utf-8"))
    server = tomllib.loads((root / "server" / "pyproject.toml").read_text(encoding="utf-8"))
    return {
        "app/package.json": str(app.get("version", "")),
        "server/pyproject.toml": str(server.get("project", {}).get("version", "")),
    }


def problems(root: Path, tag: str | None = None) -> list[str]:
    """What breaks the rule; none when the versions agree (and match `tag`)."""
    found = versions(root)
    values = set(found.values())
    if "" in values:
        return [f"{where} has no version" for where, v in found.items() if not v]
    if len(values) > 1:
        return ["the versions differ: " + ", ".join(f"{w} {v}" for w, v in found.items())]
    version = values.pop()
    if tag is not None and tag != f"v{version}":
        return [f"the tag {tag} is not v{version}, the app's and the Sump's version"]
    return []


def main(argv: list[str]) -> int:
    """Run the check; 0 when it passes."""
    tag = None
    args = list(argv)
    if "--tag" in args:
        i = args.index("--tag")
        if i + 1 >= len(args):
            print("--tag needs a value", file=sys.stderr)
            return 2
        tag = args[i + 1]
        del args[i : i + 2]
    root = Path(args[0]) if args else Path(__file__).resolve().parent.parent
    found = problems(root, tag)
    for problem in found:
        print(problem, file=sys.stderr)
    if not found:
        print(f"version {next(iter(versions(root).values()))}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
