# cttc bug corpus: `server/`

One regression test per cttc bug (rule `br-BUILD-000006-sJpO9KMY`), in
pytest, one file per domain (`test_<domain>.py`).

11 of cttc's 33 open bugs are owned by `server/`; the other
22 are in `app/tests/regression/cttc/`. The bugs come from
cttc's `ANALYSIS-000003-uKKrzikI` (IDs `BUG-000NNN-uKKrzikI`).

A test moves through three statuses:

- **placeholder**: skipped (pytest) or to-do (Vitest), until its roadmap item
  builds the code;
- **expected failure**: written before its code, as `xfail(strict=True)`
  (pytest) or `it.fails` (Vitest), so CI flags it the moment it passes;
- **passing**: the code exists and the test proves the bug can't come back.

Update the Status column when a test moves on. `task corpus` checks that
every bug from 1 to 33 has exactly one test across both parts.

Rule IDs omit their `-sJpO9KMY` suffix; Roadmap gives the item numbers in
`docs/roadmap/correlate-app-rewrite.md`.

| Bug | Title | Severity | Rule | Roadmap | Status |
|---|---|---|---|---|---|
| 11 | Corrupt token file silently regenerates tokens | Critical | `br-CONN-000004` | 11 | passing |
| 15 | UI metric events are evaluated against displayed, not live, data | High | `br-EVENT-000004` | 45 | placeholder |
| 22 | Metric condition checks only the first series with data | High | `br-EVENT-000004` | 45 | placeholder |
| 23 | Log condition skips lines beyond 200 per tick | High | `br-EVENT-000004` | 45 | placeholder |
| 24 | New log condition starts at row 0 | Medium | `br-EVENT-000004` | 45 | placeholder |
| 25 | Event tick overwrites concurrent event edits | High | `br-EVENT-000007` | 46 | placeholder |
| 27 | Event artifact name allows path traversal | Critical | `br-EVENT-000005` | 47 | placeholder |
| 32 | Pending session is polled forever | High | `br-EVENT-000006` | 47 | placeholder |
| 28 | Relaunch replays every historical Set request | High | `br-STREAM-000003` | 27 | passing |
| 31 | Container selection file ignores the ssh port | Medium | `br-STREAM-000005` | 27 | passing |
| 30 | Removing an inactive but connected Docker host leaves it collecting | Medium | `br-STREAM-000004` | 28 | passing |
