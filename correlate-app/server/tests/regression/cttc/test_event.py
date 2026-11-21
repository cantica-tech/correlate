"""Regression corpus of cttc's bugs: Sump-hosted events (EVENT).

One test per cttc bug whose behavior the Sump owns (br-BUILD-000006-sJpO9KMY).
Each is a skipped placeholder until its roadmap item builds the code; then a
strict expected failure (`xfail(strict=True)`) until the code exists; then a
passing test. See README.md in this folder for the whole corpus.
"""

import pytest


@pytest.mark.skip(reason="placeholder: br-EVENT-000004-sJpO9KMY, roadmap Item 45")
def test_cttc_bug_000015_ui_metric_events_are_evaluated_against_displayed() -> None:
    """cttc BUG-000015-uKKrzikI (High): UI metric events are evaluated against displayed,
    not live, data.

    Breaks br-EVENT-000004-sJpO9KMY. Becomes a real test with roadmap Item 45
    (RM-000046-sJpO9KMY).
    """


@pytest.mark.skip(reason="placeholder: br-EVENT-000004-sJpO9KMY, roadmap Item 45")
def test_cttc_bug_000022_metric_condition_checks_only_the_first_series() -> None:
    """cttc BUG-000022-uKKrzikI (High): Metric condition checks only the first series with
    data.

    Breaks br-EVENT-000004-sJpO9KMY. Becomes a real test with roadmap Item 45
    (RM-000046-sJpO9KMY).
    """


@pytest.mark.skip(reason="placeholder: br-EVENT-000004-sJpO9KMY, roadmap Item 45")
def test_cttc_bug_000023_log_condition_skips_lines_beyond_200_per_tick() -> None:
    """cttc BUG-000023-uKKrzikI (High): Log condition skips lines beyond 200 per tick.

    Breaks br-EVENT-000004-sJpO9KMY. Becomes a real test with roadmap Item 45
    (RM-000046-sJpO9KMY).
    """


@pytest.mark.skip(reason="placeholder: br-EVENT-000004-sJpO9KMY, roadmap Item 45")
def test_cttc_bug_000024_new_log_condition_starts_at_row_0() -> None:
    """cttc BUG-000024-uKKrzikI (Medium): New log condition starts at row 0.

    Breaks br-EVENT-000004-sJpO9KMY. Becomes a real test with roadmap Item 45
    (RM-000046-sJpO9KMY).
    """


@pytest.mark.skip(reason="placeholder: br-EVENT-000007-sJpO9KMY, roadmap Item 46")
def test_cttc_bug_000025_event_tick_overwrites_concurrent_event_edits() -> None:
    """cttc BUG-000025-uKKrzikI (High): Event tick overwrites concurrent event edits.

    Breaks br-EVENT-000007-sJpO9KMY. Becomes a real test with roadmap Item 46
    (RM-000047-sJpO9KMY).
    """


@pytest.mark.skip(reason="placeholder: br-EVENT-000005-sJpO9KMY, roadmap Item 47")
def test_cttc_bug_000027_event_artifact_name_allows_path_traversal() -> None:
    """cttc BUG-000027-uKKrzikI (Critical): Event artifact name allows path traversal.

    Breaks br-EVENT-000005-sJpO9KMY. Becomes a real test with roadmap Item 47
    (RM-000048-sJpO9KMY).
    """


@pytest.mark.skip(reason="placeholder: br-EVENT-000006-sJpO9KMY, roadmap Item 47")
def test_cttc_bug_000032_pending_session_is_polled_forever() -> None:
    """cttc BUG-000032-uKKrzikI (High): Pending session is polled forever.

    Breaks br-EVENT-000006-sJpO9KMY. Becomes a real test with roadmap Item 47
    (RM-000048-sJpO9KMY).
    """
