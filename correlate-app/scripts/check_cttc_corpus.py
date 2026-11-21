"""Check br-BUILD-000006 (every cttc bug has one regression test) on any operating system.

Finds the regression test of each cttc bug in `app/tests/regression/cttc/`
(Vitest titles `cttc BUG-000NNN: ...`) and `server/tests/regression/cttc/`
(pytest functions `test_cttc_bug_000NNN_...`), whatever its status
(placeholder, expected failure or passing). Fails, naming the bugs, if any of
cttc's bugs 1 to 33 has no test or more than one, or if a test names a bug
outside that range.

Usage: python scripts/check_cttc_corpus.py [repository root]
(default: this script's parent folder). Standard library only.
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

#: cttc's open bugs, BUG-000001-uKKrzikI to BUG-000033-uKKrzikI.
CTTC_BUGS = range(1, 34)

#: Each corpus folder, the files to read in it, and how a test names its bug.
CORPUS = (
    ("app/tests/regression/cttc", "*.test.ts", re.compile(r"""["'`]cttc BUG-(\d{6}):""")),
    ("server/tests/regression/cttc", "test_*.py", re.compile(r"\bdef test_cttc_bug_(\d{6})_")),
)


def find_tests(root: Path) -> dict[int, list[str]]:
    """Map each bug number found in the corpus to the files that test it."""
    found: dict[int, list[str]] = defaultdict(list)
    for folder, pattern, regex in CORPUS:
        for path in sorted((root / folder).glob(pattern)):
            for match in regex.finditer(path.read_text(encoding="utf-8")):
                found[int(match.group(1))].append(path.relative_to(root).as_posix())
    return found


def problems(found: dict[int, list[str]]) -> list[str]:
    """Describe every bug with no test, more than one, or outside cttc's range."""
    issues = [f"BUG-{n:06d}: no test" for n in CTTC_BUGS if n not in found]
    issues += [
        f"BUG-{n:06d}: {len(files)} tests ({', '.join(files)})"
        for n, files in sorted(found.items())
        if n in CTTC_BUGS and len(files) > 1
    ]
    issues += [
        f"BUG-{n:06d}: not a cttc bug ({', '.join(files)})"
        for n, files in sorted(found.items())
        if n not in CTTC_BUGS
    ]
    return issues


def main(argv: list[str]) -> int:
    """Run the check and report; return the process exit code."""
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parent.parent
    issues = problems(find_tests(root))
    if issues:
        print("br-BUILD-000006: the cttc bug corpus is incomplete:")
        for issue in issues:
            print(f"  {issue}")
        return 1
    print(f"br-BUILD-000006: corpus ok ({len(CTTC_BUGS)} cttc bugs, one test each)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
