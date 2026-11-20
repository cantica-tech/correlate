"""Check br-BUILD-000001 (two-part repository) on any operating system.

Product code lives only in `app/` and `server/`, never at the repository root
or in another top-level folder, and `app/`, `server/` and `server/plugins/`
exist. Prints the offending paths and exits 1 otherwise.

Usage: python scripts/check_layout.py [repository root]
(default: this script's parent folder). Standard library only.
"""

from __future__ import annotations

import sys
from pathlib import Path

#: File extensions that count as product code.
SOURCE_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".cjs", ".mjs"}

#: Top-level folders where product code belongs.
CODE_ROOTS = {"app", "server"}

#: Folders that must exist, relative to the repository root.
REQUIRED_DIRS = ("app", "server", "server/plugins")

#: Folders never searched: dependencies, environments, tool output and this
#: script's own folder.
SKIPPED_DIRS = {"node_modules", ".venv", ".git", "scripts", "__pycache__"}


def misplaced_sources(root: Path) -> list[Path]:
    """Return the product-code files outside `app/` and `server/`, relative to `root`."""
    found: list[Path] = []
    for entry in sorted(root.iterdir()):
        if entry.name in CODE_ROOTS or entry.name in SKIPPED_DIRS:
            continue
        candidates = [entry] if entry.is_file() else entry.rglob("*")
        for path in candidates:
            rel = path.relative_to(root)
            if any(part in SKIPPED_DIRS for part in rel.parts):
                continue
            if path.is_file() and path.suffix in SOURCE_SUFFIXES:
                found.append(rel)
    return found


def missing_dirs(root: Path) -> list[str]:
    """Return the required folders that do not exist under `root`."""
    return [d for d in REQUIRED_DIRS if not (root / d).is_dir()]


def main(argv: list[str]) -> int:
    """Run the check and report; return the process exit code."""
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    missing = missing_dirs(root)
    offenders = misplaced_sources(root)
    if missing:
        print("br-BUILD-000001: missing folder(s): " + ", ".join(missing))
    if offenders:
        print("br-BUILD-000001: product code outside app/ and server/:")
        for path in offenders:
            print(f"  {path.as_posix()}")
    if missing or offenders:
        return 1
    print("br-BUILD-000001: layout ok (app/, server/, server/plugins/)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
