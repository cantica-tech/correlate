# cttc bug corpus: `app/`

One regression test per cttc bug (rule `br-BUILD-000006-sJpO9KMY`), in
Vitest, one file per domain (`<domain>.test.ts`).

22 of cttc's 33 open bugs are owned by `app/`; the other
11 are in `server/tests/regression/cttc/`. The bugs come from
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
| 1 | PowerShell command injection via peer gateway host | Critical | `br-SUMP-000006` | 18 | passing |
| 2 | Telnet fallback reports open ports as closed | Medium | `br-SUMP-000005` | 18 | passing |
| 3 | Corrupt gateways.json is silently overwritten | Critical | `br-SUMP-000001` | 13 | passing |
| 4 | Uninstalled gateway's host can never be re-added | High | `br-SUMP-000002` | 16 | passing |
| 5 | Failed switch to a remote gateway tears down the current tunnel | High | `br-SUMP-000003` | 16, 17 | passing |
| 6 | Choosing 'Later' after adding a gateway leaves the window on a dead connection | Medium | `br-SUMP-000003` | 15 | passing |
| 7 | Edit Gateway overwrites the working key before the new one is proven | High | `br-SUMP-000003` | 10 | passing |
| 8 | Orphan cleanup can kill an unrelated process | High | `br-SUMP-000008` | 17 | passing |
| 9 | vault-setup can re-key an already initialized vault | Critical | `br-VAULT-000004` | 10 | passing |
| 10 | API token file is written with default permissions | Critical | `br-VAULT-000006` | 10 | passing |
| 12 | Switching to a known remote gateway collides with the local gateway's port | Medium | `br-SUMP-000008` | 16, 17 | passing |
| 13 | Host telemetry block shows for the wrong host or view | Medium | `br-STREAM-000001` | 33 | passing |
| 14 | Snapshots mix live and loaded-file telemetry | High | `br-ANLYS-000001` | 43 | placeholder |
| 16 | 'now' label moves the analysis view to the present | Medium | `br-ANLYS-000002` | 34 | placeholder |
| 17 | Multi-file load centres on the union, not the active file | Medium | `br-ANLYS-000004` | 35 | placeholder |
| 18 | Re-opening or switching files does not use the 75% framing | Low | `br-ANLYS-000004` | 35 | placeholder |
| 19 | Open-file dedup keys on basename only | Medium | `br-ANLYS-000005` | 35 | placeholder |
| 20 | Raw fetches to the gateway have no timeout | High | `br-CONN-000005` | 8 | passing |
| 21 | A failed log page fetch is cached forever | High | `br-LOGV-000001` | 30 | passing |
| 26 | Event recording download is saved without a status check | High | `br-EVENT-000005` | 48 | placeholder |
| 29 | New Gateway and pill switch change the active gateway with no recording check | High | `br-REC-000001` | 16, 40 | passing |
| 33 | Ship Logs throws when the saved log folder is missing | Medium | `br-DIAG-000002` | 51 | placeholder |
