"""Regression corpus of cttc's bugs: connection, startup and identity (CONN).

One test per cttc bug whose behavior the Sump owns (br-BUILD-000006-sJpO9KMY).
Each is a skipped placeholder until its roadmap item builds the code; then a
strict expected failure (`xfail(strict=True)`) until the code exists; then a
passing test. See README.md in this folder for the whole corpus.
"""

import pytest


@pytest.mark.skip(reason="placeholder: br-CONN-000004-sJpO9KMY, roadmap Item 11")
def test_cttc_bug_000011_corrupt_token_file_silently_regenerates_tokens() -> None:
    """cttc BUG-000011-uKKrzikI (Critical): Corrupt token file silently regenerates tokens.

    Breaks br-CONN-000004-sJpO9KMY. Becomes a real test with roadmap Item 11
    (RM-000012-sJpO9KMY).
    """
