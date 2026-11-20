# Rewriting cttc as correlate-app: roadmap

> Status: proposed, 2026-11-20. Based on the material in `docs/cttc/`:
>
> - **cttc's own criterion** ([`docs/cttc/criterion/`](../cttc/criterion/)):
>   42 business rules in 13 domains and 33 open bugs. All of them come from
>   the whole-project analysis
>   [`ANALYSIS-000003`](../cttc/criterion/analyses/ANALYSIS-000003-uKKrzikI-whole-project.md),
>   run at cttc commit `88f9673`.
> - **The three roadmaps from the earlier correlator port**
>   ([`docs/cttc/roadmap/`](../cttc/roadmap/)):
>   [the port](../cttc/roadmap/cttc-to-correlator-port.md),
>   [feature parity](../cttc/roadmap/cttc-feature-parity.md) and
>   [the UI audit](../cttc/roadmap/cttc-ui-port-audit.md).
>
> cttc is reference-only. Nothing in this roadmap changes it.

## 0. Purpose

correlate-app is a from-scratch rewrite of cttc. Its product thesis is the one
cttc proved: **a shared, clickable timeline that correlates container
telemetry with service logs.** Click a log line and the charts recentre on that
moment. Click a chart and the log panels jump to the matching lines.

This roadmap has three aims:

1. **Carry every cttc rule forward.** Each of the 42 rules in
   [`cttc-rules.md`](../cttc/criterion/rules/cttc-rules.md) is either kept
   (and marked ✅ only once a test proves it), changed on purpose (with a
   decision recorded), or dropped on purpose.
2. **Close all 33 cttc bugs by design.** Each bug becomes a named regression
   test in the phase that builds the code it was found in (§4). None of them
   should be rediscovered later.
3. **Avoid the failures of the correlator port** (§2). That port got the
   architecture right, but it shipped engine code nobody could reach from the
   UI, and it left visual design until last.

## 1. Vocabulary

This keeps the correlator naming, which the icon set in
`~/sources/icons/correlator/` was drawn for.

| cttc | correlate-app | Notes |
|---|---|---|
| Gateway | **Sump** | A containerized collector, provisioned locally or over SSH. |
| Docker host | **Data stream** (source) | Comes from a plugin. Docker-over-SSH is the first plugin, not the only one. |
| `~/.cttc/gateways.json` | **Instance catalog** (`.correlate/`) | JSON documents stored in SQLite, not a flat file. |
| `.cttc-record` | **Recording** (`*.recording`) | Contains one or more tracks. |
| `.cttc-metric` / metric export | **Track** (`*.track`) | One captured series. |
| Snapshot | **Snapshot** | A plain JSON or text export. |
| Opened Data / Load Data | **Project** (`*.correlator`) | A workspace that references files and never copies them. |
| Gateway mesh / peer audit | **Secondary Sump federation** | |

## 2. Lessons from the correlator port

The three correlator roadmaps record what went wrong. This plan is shaped
around those findings.

| Correlator finding | Rule for correlate-app |
|---|---|
| The correlation engine was built and unit-tested but never imported by `App.tsx` ([feature parity §1.1](../cttc/roadmap/cttc-feature-parity.md)). | **A phase is done only when its feature can be used in the running app.** Code nothing calls doesn't count. Every phase ends with an end-to-end test that drives the UI. |
| The app had real functional depth but none of cttc's polish: no CSS, no dark mode, no icons, no dialogs ([UI audit](../cttc/roadmap/cttc-ui-port-audit.md)). | **cttc's design system is ported first** (Phase 4, D8), before any feature screen. |
| Recording was built as an export of a time range, while cttc's recording is a session that can pause and survive a crash ([feature parity §1.3](../cttc/roadmap/cttc-feature-parity.md)). | cttc's session model (`br-REC-000002`, ✅ working) is ported as it is (Phase 8). |
| The UI only ever allowed one Sump; cttc has several gateways and a switcher ([feature parity §1.2](../cttc/roadmap/cttc-feature-parity.md)). | Decide single or multiple Sumps **before** the catalog schema is built (decided: D2). |
| 17% of cttc's historical bugs came from gateway and daemon state that was implicit and scattered ([port §5.5](../cttc/roadmap/cttc-to-correlator-port.md)). | Use one explicit Sump lifecycle state machine, and test every transition. |
| One crashing background loop could stop every plugin (`ORCH`, [feature parity §2](../cttc/roadmap/cttc-feature-parity.md)). | Isolate exceptions per plugin from Phase 1 onwards. |

## 3. Target stack

`correlate-app/` is currently an empty `uv init` Python 3.13 scaffold. With
the `app/` and `server/` split (D1), this roadmap uses the stack the correlator
port already proved:

| Layer | Choice |
|---|---|
| Desktop shell | Electron + electron-builder |
| UI | React + TypeScript (strict) + Jotai, bundled with esbuild |
| App tooling | Vitest, Biome, plain npm |
| Sump server | Python 3.13, FastAPI + uvicorn |
| Server tooling | uv, ruff, ty, pytest + pytest-asyncio + fakeredis, hatchling |
| Store | Redis Streams for records; SQLite for the local catalog |
| Ingestion | Fluent Bit |
| Plugins | pluggy hookspecs, discovered through the `sump.plugins` entry-point group, never by scanning a directory |
| Observability | OpenTelemetry, built into the server from the first phase |

## 4. How cttc's rules and bugs carry forward

Each cttc domain maps to a correlate-app domain and to the phase that builds
it. Each bug becomes a regression test in that phase, and the phase cannot
close until the test passes.

| cttc domain | Rules (✅ / ⚠️ / ❌) | correlate-app domain | Phase | Bugs that must be closed by design |
|---|---|---|---|---|
| `GATE` gateway management | 7 (2/5/0) | `SUMP` | 3 | 1 🔴, 2, 3 🔴, 4, 5, 6 |
| `TUNL` SSH tunnel transport | 2 (0/2/0) | `SUMP` (transport, D4) | 3 | 8, 12 (impossible by design) |
| `VAULT` key vault and secrets | 6 (3/2/1) | `VAULT` | 2 | 7, 9 🔴, 10 🔴 |
| `CONN` startup and connection | 4 (2/2/0) | `CONN` | 1–3 | 11 🔴, 20 |
| `DHOST` Docker host management | 5 (1/4/0) | `STREAM` | 5 | 13, 28, 30, 31 |
| `VIEW` timeline view | 2 (2/0/0) | `VIEW` | 6 | — |
| `LOGV` log viewer | 1 (0/1/0) | `LOGV` | 6 | 21 |
| `ANLYS` analysis view | 6 (1/5/0) | `ANLYS` | 7 | 14, 16, 17, 18, 19 |
| `REC` recording | 2 (1/1/0) | `REC` | 8 | 29 |
| `EXPORT` export and snapshots | 0 (domain only) | `EXPORT` | 9 | 14 (shared with `ANLYS`) |
| `EVENT` events | 3 (0/3/0) | `EVENT` (Sump-hosted, D7) | 10 | 15, 22, 23, 24, 25, 26, 27 🔴, 32 |
| `DIAG` diagnostics and own logs | 3 (2/1/0) | `DIAG` | 11 | 33 |
| `PREF` preferences | 1 (1/0/0) | `PREF` | 11 | — |

🔴 marks the six Critical bugs: 1 (PowerShell injection through a peer host),
3 (a corrupt `gateways.json` is silently overwritten), 9 (vault setup can
re-key an initialized vault), 10 (the token file gets default permissions),
11 (a corrupt token file silently regenerates tokens) and 27 (an event artifact
name allows path traversal). All six have to do with secrets, persistence or
untrusted input. That is why Phases 2 and 3 come before any feature UI.

## 5. Phases and items

Items are numbered in order. When this file is ingested with `/roadmap-add` in
correlate-app's criterion, Item N becomes the Nth `RM-` row assigned.

### Phase 0: Foundations

**Item 1: Repository layout and toolchains.** Two top-level folders, per
decision D1: `app/` for the Electron and React client, and `server/` for the
Sump, with its plugin packages in `server/plugins/`. Move the root
`pyproject.toml` into `server/`, delete the placeholder `main.py`, set up the
toolchains in §3, and add a root `Taskfile` that drives both folders.

Per decision D6, also bring over correlator's tested modules with their tests:
`correlate/*` (time mapping, density buckets, log window) into `app/`, and the
plugin manager into `server/`. Phases 1 and 6 check them against the carried
cttc rules instead of writing them again.

**Item 2: CI on every push.** Lint, type-check and test both the app and the
server. cttc never had CI that ran on push.

**Item 3: Seed correlate-app's rule documents from cttc.** Create the domains
from §4 in correlate-app's criterion. Copy each cttc rule into the single rule
document `correlate-app-rules.md` as `❌ missing`, since correlate-app has no
code yet, with its cttc ID cited and its cttc status kept in Notes. It moves
to ⚠️ once partly built, and to ✅ only when a correlate-app test proves it.

**Item 4: Regression-corpus harness.** Add one skipped placeholder test per
cttc bug (`test_cttc_bug_000NNN_*`), so the 33 open cases are visible in every
test run until each is closed.

### Phase 1: Sump server core

**Item 5: Sump server skeleton.** FastAPI with Redis Streams records, Fluent Bit
ingestion and OpenTelemetry traces and metrics.

**Item 6: Plugin manager.** pluggy hookspecs (`sump_plugin_info`,
`register_transport`, `register_data_source`, `contribute_routes`,
`on_health_check`), discovered through entry points. Plugins are on by default
and can be turned off. A route that conflicts with an existing one is refused.

**Item 7: Per-plugin fault isolation.** An exception in one plugin's background
task never stops another plugin. A plugin that fails its health check sleeps
and resumes on its own.

**Item 8: Time limits on every call.** Every request from the client to a Sump
has a finite timeout, including raw fetches and SSE (`br-CONN-000003`, bug 20).

### Phase 2: Secrets and identity

**Item 9: Key vault.** Keys are encrypted at rest with OS safe storage, or
scrypt + AES-256-GCM as a fallback. Files are written atomically and named by
an HMAC. Decrypted keys go to temporary files that are always deleted. Only
PEM keys are accepted. (`br-VAULT-000001`, `-000002`, `-000004`)

**Item 10: Vault invariants.** An initialized vault can never be re-keyed
(bug 9). Every secret file is readable by its owner only (bug 10). Orphaned key
files are cleaned up (`br-VAULT-000005`, the one ❌ rule in cttc). A new key
never overwrites the working one until it has been proven (bug 7).

**Item 11: Sump session tokens.** cttc shares one static token per gateway
(`br-CONN-000002`). In correlate-app, a token is issued per user by the
SSH-key login in Item 12 and expires after a while. The Sump stores only a hash
of each token. A corrupt token store is refused loudly and never silently
regenerated (bug 11).

**Item 12: Per-user identity through SSH keys.** Per decision D3, a user is
identified by an SSH key pair. The private key stays in the vault (Item 9). The
Sump keeps each user's authorized public keys, in the same format as
`authorized_keys`. To log in, the client signs a challenge from the Sump with
the private key, and the Sump issues the session token from Item 11. The user
who provisions a Sump becomes its owner and can add other users' public keys.
This builds on cttc's `/gateway/ownership/claim|rotate`, which already signs
with the owner's SSH key. The catalog schema (Phase 3) and federation
(Phase 12) both use this identity.

### Phase 3: Sump provisioning, catalog and lifecycle

**Item 13: Instance catalog.** JSON documents stored in SQLite under
`.correlate/`. Per decision D2, it holds any number of Sumps; each window has
one active Sump, and the others stay connected in the background. Entries are
deduplicated and soft-deleted, so history is kept (`br-GATE-000001`). A corrupt
catalog is never silently overwritten (bug 3).

**Item 14: Sump lifecycle state machine.** The states are
`provisioning → active ⇄ unreachable → retired`. The UI only reads this state;
it never keeps its own copy. Every transition is tested.

**Item 15: Startup and provisioning flow.** If Docker is available locally,
provision the Sump there; otherwise provision it over SSH (`br-CONN-000001`,
`-000004`). A failed first connect leaves no orphaned key (`br-GATE-000007`).
Choosing "Later" never leaves the window on a dead connection (bug 6).

**Item 16: New, edit, switch and uninstall Sump.** A failed switch or edit
keeps the current connection (`br-GATE-000003`, bug 5). A host can be added
again after an uninstall (`br-GATE-000004`, bug 4). Switching never collides
with the local Sump's port (bug 12). Every path that switches Sumps asks for
confirmation first while a recording is live (bug 29, ahead of Phase 8).

**Item 17: SSH-forward transport.** Per decision D4 (§7.2), a remote Sump is
reached only through an SSH port forward that runs inside the Electron main
process, using an SSH library rather than the `ssh` command:

- One SSH connection per remote Sump, authenticated with the user's key
  (D3), forwarding to the Sump's loopback port.
- The local port is picked by the OS, never fixed (bug 12).
- No subprocess, so no PIDs to record or orphans to kill (bug 8).
- A switch opens the new connection before closing the old one (bug 5).
- The connection is part of the lifecycle state machine (Item 14). When it
  drops, the Sump goes `unreachable` and the app reconnects with backoff.
- The compose file publishes `127.0.0.1:8765:8765` only, and provisioning
  refuses any other binding.

`br-TUNL-000002` (direct first, tunnel fallback) is dropped on purpose.
`br-TUNL-000001` is rewritten for in-process forwards: a forward counts as up
only once it carries traffic, failures are reported, and it is closed on
switch, uninstall and quit.

**Item 18: Peer audit.** Port the audit truth table (`br-GATE-000005`). Values
supplied by peers are only ever passed as plain arguments, never into a shell
(`br-GATE-000006`, bug 1). A TCP probe that falls back to telnet reports open
ports correctly (bug 2).

### Phase 4: App shell and design system

Per decision D8, correlate-app keeps cttc's look: colors, typography, spacing,
component shapes and layout. cttc's `app/renderer/style.css` (about 2,000
lines) is the reference, read from the file itself, never copied secondhand.
A screen differs from cttc only where a new concept needs it (Sump,
data streams, projects), and then it reuses cttc's existing patterns.

**Item 19: Design tokens and dark mode.** Port cttc's custom properties as
they are, light and dark: `--surface-*`, `--text-*`, `--accent`,
`--critical`, `--warning`, `--series-1..8`, `--radius-*` and `--shadow-*`
(`style.css:1-69`), along with its font stacks and sizes. Keep the token
names, so cttc's rules can be ported line for line. Follow
`prefers-color-scheme` by default, with an override in Preferences that
actually changes the app, as cttc's `nativeTheme.themeSource` does.

**Item 20: Icons.** Use the `~/sources/icons/correlator/` set for the new
concepts, and cttc's own icons (`app/renderer/assets/sidebar/` and the inline
SVGs in `index.html` and `action-bar.js`) for everything that keeps its
meaning. The hard-coded fill in `recordind.svg` must be stripped so it follows
the theme.

**Item 21: Component primitives.** Port cttc's components with their existing
styling: native `<dialog>` modals, `.btn`, `.btn-fetch`, `.btn-danger`,
`.seg-control`, `.switch` and the bordered panel (`style.css:946-1015`,
`:1606-1699`). Build each once as a React component and reuse it everywhere.

Item 21 also sets up visual parity checks. Use cttc's screenshots in `docs/images/`
(`app-overview.png`, `dlg-set-sources.png`, `dlg-snapshot.png`,
`dlg-appearance.png`) and fresh captures of the other cttc screens as
references. Each ported screen gets a screenshot test, in light and dark
mode, that is compared against its cttc reference. Any intentional difference
is listed in the test with its reason.

**Item 22: Sidebar.** Three sections (Sump, Projects, Events), with dock
left/right, collapse to a rail and pop-out windows (cttc `SIDE`).

**Item 23: Status bar with history.** The Sump status pill polls every 5 s and
has a switcher dropdown and a right-click menu. Notifications go to a feed with
history.

**Item 24: Application menu and keyboard shortcuts.** The File, Edit, View,
Window and Help menus, plus a cut/copy/paste context menu on editable fields.

### Phase 5: Data streams

**Item 25: SSH data-stream plugin.** One package that implements both
`register_transport` and `register_data_source`. It detects the Sump's own host
and hides the Sump's own container unless the user chooses to watch it.

**Item 26: Data-stream picker.** A per-source checklist with select-all per
group and a "gone but still selected" state. Submitting syncs the sources to
exactly the checklist (`br-DHOST-000002`).

**Item 27: Selection persistence.** Each source keeps its own selection, keyed
by its full identity including the SSH port (`br-DHOST-000005`, bug 31). On
relaunch, only the latest selection is restored, not every historical one
(`br-DHOST-000003`, bug 28).

**Item 28: Removing and scoping sources.** Removing a source stops its
collection, even if it is inactive (`br-DHOST-000004`, bug 30). Only the active
source's data is shown, and host telemetry is titled for that host
(`br-DHOST-000001`, bug 13).

### Phase 6: Core correlation UX

This phase delivers the product thesis. Nothing after it may break it without
a failing end-to-end test.

**Item 29: Shared timeline and charts.** Multi-series charts with a legend, axes
and gridlines. Downsampling takes the maximum of each bucket, not the mean
(cttc's `BUCKET` lesson). The view span is at least 200 ms, and the other input
limits of `br-VIEW-000002` apply.

**Item 30: Event-density lanes and log panels.** One lane per source, and
virtual-scrolled log panels that page on demand, highlight rows near the cursor
and search in both directions (`br-LOGV-000001`). A failed page fetch is
retried and never cached (bug 21).

**Item 31: Correlation in both directions.** Clicking a log line recentres the
charts; clicking a chart moves the logs to that time. Legend and log panels
stay linked when hiding or reordering a source.

**Item 32: Live view.** The view stays centred 5 s behind now, with a now line,
a live-tracking cursor and pause on double-click (`br-VIEW-000001`). Zoom, pan
and the timeline navigator are included.

**Item 33: Host and container telemetry kept apart.** Two chart groups that are
never overlaid.

### Phase 7: Analysis view and projects

**Item 34: Strict separation of live and analysis views.** No data crosses
between the two views in either direction (`br-ANLYS-000001`). The analysis
view is static, and nothing in it jumps to the present, including the "now"
label (`br-ANLYS-000002`, bug 16). Navigation stays within the file's range
(`br-ANLYS-000003`).

**Item 35: Framing of loaded files.** The active file is centred on its own
midpoint and fills 75% of the view width on load, re-open and switch
(`br-ANLYS-000004`, bugs 17, 18). Opening a file that is already open switches
to it, matched by full path, not basename (`br-ANLYS-000005`, bug 19). Removing
a file goes back to the right view (`br-ANLYS-000006`).

**Item 36: Projects (`*.correlator`).** A default project at a fixed location,
virtual folders, references instead of copies, and New, Open, Recent, Save and
Save As. A live Sump can be bound to a project. Each track has delay and
visibility controls.

**Item 37: File associations.** `*.recording`, `*.track` and `*.correlator`
files open in the app on double-click.

### Phase 8: Recording sessions

**Item 38: Recording session lifecycle.** Start, pause, resume and stop. Each
span from record to pause becomes one segment. Stop flushes the last segment
before asking where to save, and a cancelled save can be retried
(`br-REC-000002`).

**Item 39: Crash recovery.** After a crash, the user chooses to resume from the
interruption, resume from now or decide later. A stopped marker waits for a
destination.

**Item 40: Confirm before abandoning a recording.** Every action that changes
the active Sump or source, including New Sump and the pill switch, asks first
(`br-REC-000001`, bug 29).

**Item 41: Recording motif on the chart.** A pulsing indicator and the
captured-range band.

### Phase 9: Export and snapshots

**Item 42: Write the `EXPORT` rules.** cttc defines this domain but has no
rules in it. Write them before building it.

**Item 43: Snapshots and capture.** Point-in-time snapshots, scoped to the
active view only (bug 14). Drag to select a range on the chart, and view the
result as raw text or JSON.

**Item 44: Export wizard.** Export a loaded file's full range as text or JSON,
summary or full series. Log export asks for the destination before fetching any
rows.

### Phase 10: Events

Per decision D7, events run in the Sump only. The app edits them and shows
their firings, and never evaluates a condition itself.

**Item 45: Event engine as a Sump plugin.** The engine runs as a Sump plugin,
so Item 7's fault isolation applies. Each event keeps a stored position in the
Redis streams it watches, and evaluates live data from there, never the data
the app happens to display (bug 15):

- Events fire on an edge: once per change from not met to met.
- A metric condition checks every series it watches (bug 22).
- A log condition reads every new line with no per-tick cap (bug 23), starting
  at the stream's tail when the event is created, not row 0 (bug 24).

Rewrites `br-EVENT-000001` for Sump-hosted events.

**Item 46: Event API and ownership.** Events are created, edited and deleted
through the Sump API. Each event belongs to the user who created it, through
the D3 identity. Thresholds must be numeric and regular expressions must
compile, or the Sump refuses the event. Every edit carries a version number,
so a concurrent change is refused rather than overwritten (bug 25).

**Item 47: Actions and artifacts on the Sump.** A firing's snapshot or
recording is created on the Sump, next to the data:

- Artifacts are stored there with cttc's time to live (24 h by default,
  longer if kept) and swept hourly. Rewrites `br-EVENT-000002` for Sump
  storage.
- Artifact names are generated or sanitized by the Sump and can never leave
  its artifact folder (bug 27).
- A recording action is part of the Sump's own session lifecycle, so there is
  no pending session for the app to poll. One that can't complete is marked
  failed (bug 32). `br-EVENT-000003` is replaced by this rule.

**Item 48: Events in the app.** The Events sidebar section lists the user's
events and edits them. Firings reach the app over a stream from each connected
Sump and go into the status-bar history (Item 23). Each artifact can be
downloaded into a project, and is saved only after the Sump confirms it is
complete (bug 26).

**Item 49: Scheduling and rolling buffer.** One-shot and cron triggers, and a
rolling buffer on the Sump for snapshots that include the moments before an
event fired.

### Phase 11: Diagnostics, preferences, About

**Item 50: App's own logs.** On by default, with a single fallback that then
turns itself off (`br-DIAG-000001`). Sump stderr lines are classified by level
(`br-DIAG-000003`).

**Item 51: Ship Logs.** Zips local logs together with the Sump's logs. It still
works when the log folder is missing (`br-DIAG-000002`, bug 33).

**Item 52: Preferences.** A Settings pane, which opens by default
(`br-PREF-000001`), and an Appearance pane. Includes a Hard Reset that never
touches user files.

**Item 53: About dialog.** Real version, build and dependency metadata.

### Phase 12: Federation

**Item 54: Promote a source to a secondary Sump.** A secondary Sump can be
reached from its parent and works fully on its own.

**Item 55: Per-user source catalog and privacy flag.** Depends on Item 12.

### Phase 13: Packaging and migration

**Item 56: Installers and image publishing.** NSIS, DMG and AppImage
installers, plus publishing the Sump image.

**Item 57: cttc import.** Per decision D5, import `.cttc-record` and
`.cttc-metric` files read-only, converting them to `*.recording` and
`*.track`, and leave the originals untouched. `~/.cttc/gateways.json` and the
cttc key vault are not imported: users add their Sumps again, which provisions
them under the SSH-key identity of D3.

### Phase 14: More data-stream plugins (exploratory)

**Item 58: logstream plugin.** Survey `log-sump` upstream first.

**Item 59: Kibana/Elasticsearch plugin.** A design spike to check that the
plugin contract fits a source that isn't a container.

## 6. Order of work

```text
0 ──► 1 ──► 2 ──► 3 ──► 5 ──┐
 └──► 4 (against a mock Sump)├──► 6 ──► 7 ──► 8 ──► 9 ──► 10 ──► 11
                            ┘                              12, 13, 14 later
```

- The server track (1–3) and the shell track (4) run in parallel after
  Phase 0.
- Phase 6 starts only when both tracks meet at a real Sump that has one real
  source.
- **Walking skeleton:** by the end of Phase 6, a user can install a Sump, pick
  one container and correlate its logs with its CPU on screen. Treat this as
  the first release candidate.

## 7. Decisions

### 7.1 Decided (2026-11-20)

| ID | Decision | Affects |
|---|---|---|
| D1 | The repository has two top-level folders: `app/` (client) and `server/` (Sump, with plugins in `server/plugins/`). | Item 1 |
| D2 | The app manages several Sumps, with one active per window and a switcher, as in cttc's `GATE` model. | Items 13, 16, 23 |
| D3 | Users are identified by SSH keys. The Sump keeps each user's authorized public keys and issues session tokens after a signed challenge. | Items 11, 12, 55 |
| D4 | Remote Sumps are reached only through an in-process SSH port forward (option C in §7.2). The Sump binds to loopback only. There is no direct-HTTP path and no `ssh` subprocess. | Items 15, 17, 54 |
| D5 | cttc recordings and metric files are imported read-only. The cttc gateway registry and key vault are not imported; Sumps are provisioned again. | Item 57 |
| D6 | correlator's tested modules (`correlate/*`: time mapping, density buckets, log window) and its plugin manager are ported with their tests, then checked against the rules in §4. | Items 6, 29–31 |
| D7 | Events run in the Sump only, as a plugin. The app edits events and shows firings, and never evaluates conditions. One event watches one Sump. | Items 45–49 |
| D8 | The UI keeps cttc's style as closely as possible: its tokens, colors, typography, spacing, components, icons and layout. Differences are allowed only for new concepts, and are recorded. | Items 19–24, every UI phase |

### 7.2 How the client reaches a remote Sump (decided: D4, option C)

This section records the reasoning behind D4. Three questions shape the answer:

- Is the Sump's port open to the network?
- Is the traffic encrypted?
- How much connection code is there to get wrong?

**What cttc does.** cttc publishes the gateway on port 8765 of the remote host
(`"8765:8765"` in its compose file), so anyone on the LAN can reach it. On
connect, it first tries plain HTTP for 10 s. If that fails, it starts an
`ssh -N -L` subprocess that forwards a local port to the remote one
(`br-TUNL-000002`). Two consequences:

- On the direct path, the bearer token and every log line travel unencrypted.
- The tunnel path needs about 250 lines of supervision code
  (`ssh-tunnel.js`, `tunnel-registry.js`) to check that the local port is
  free, wait for the forward to listen, notice when the tunnel dies, record
  PIDs and kill tunnels orphaned by a previous run.

**Bugs this design caused.** The `TUNL` and `GATE` bugs all come from that
second path:

- **Bug 8:** the orphan cleanup kills recorded PIDs without checking that they
  are still `ssh`, so after a reboot it can kill an unrelated process.
- **Bug 12:** a tunnel binds local port 8765, which is the local Sump's port,
  so switching fails while a local Sump is running.
- **Bug 5:** a failed switch tears down the working tunnel first.
- Also, gateways that are already known skip the direct attempt and always
  tunnel, so in practice both paths are always in use.

**What correlator did.** It uses SSH only once, to provision, and then always
plain HTTP. That removes the supervision code, but it keeps the unencrypted,
LAN-exposed port. It also stops working wherever a firewall blocks the Sump's
port while allowing SSH, which is common on servers.

**The options:**

| | A. Direct HTTP only | B. Direct first, tunnel fallback (cttc) | C. SSH forward only, in-process |
|---|---|---|---|
| Sump port open to the network | Yes, all interfaces | Yes | **No**: bound to `127.0.0.1` on its host |
| Traffic encrypted | No (unless TLS is added: certificates on every Sump) | Only on the tunnel path | **Yes**, always (SSH) |
| Works behind a firewall that allows only SSH | No | Yes | Yes |
| Subprocesses and PIDs to manage | None | `ssh` processes, PID file, orphan cleanup | **None**: the forward is a channel inside the app's own SSH connection |
| Local port collisions (bug 12) | n/a | Possible | Impossible: the OS assigns an ephemeral port |
| Fits D3 (SSH-key identity) | Separate login step | Partly | **Directly**: the same key opens the connection and proves who the user is |
| Code paths to test | 1 | 2, plus the switch between them | 1 |
| Cost | Plain HTTP; the weakest security | The most code; caused bugs 5, 8 and 12 | One long-lived SSH connection per remote Sump, with reconnect logic |

**Chosen: C.** It is the only option that is both encrypted and
firewall-friendly while keeping a single code path. It also follows directly
from D3: the user already has an SSH key on that host. In practice, C means:

- **Electron main process.** It opens one SSH connection per remote Sump with
  an SSH library (for example `ssh2` for Node) and forwards a channel to the
  Sump's loopback port. There is no `ssh` subprocess, so there are no PIDs to
  record and no orphans to kill at launch; bug 8 can't happen.
- **Ephemeral local port.** The renderer talks to the forward through a local
  port the OS picks. Bug 12 can't happen.
- **Lifecycle.** The connection is part of the Sump lifecycle state machine
  (Item 14): it drops to `unreachable` and reconnects with backoff, and a
  switch opens the new connection before closing the old one (bug 5).
- **Local Sump.** No SSH is involved; it is reached on `127.0.0.1` directly.
- **Compose.** The compose file publishes `127.0.0.1:8765:8765` only, and
  provisioning refuses any other binding. This carries forward correlator's
  `br-NET-004` check.
- **Server-to-server.** Federation (Phase 12) uses the same mechanism: a
  parent Sump reaches a secondary Sump through its own SSH forward.

The rules change as follows. `br-TUNL-000002` (direct first, tunnel fallback)
is dropped on purpose and replaced by a rule that remote Sumps are reached only
through an SSH forward. `br-TUNL-000001` keeps its intent: a forward counts as
up only once it carries traffic, failures are reported, and it is closed on
switch, uninstall and quit. The PID and orphan parts of that rule no longer
apply.

**When to reconsider.** Choose A with TLS instead if users must reach Sumps
from machines that can't have SSH access to the host, for example a shared
team Sump reached by people who have no account on the box.

### 7.3 Where events run (decided: D7)

This section records the reasoning behind D7.

cttc lets the user choose between UI-hosted events, which the renderer
evaluates and which stop when the window closes, and gateway-hosted ones.
All eight of cttc's open `EVENT` bugs are in the UI-hosted path:

- **Bug 15:** the renderer can only see the data on screen, so it evaluates
  the displayed data instead of the live data.
- **Bugs 22, 23 and 24:** a metric condition checks only the first series
  with data, a log condition reads at most 200 lines per tick, and a new log
  condition starts at row 0.
- **Bug 25:** its tick loop overwrites edits made at the same time.
- **Bugs 26 and 32:** a triggered recording has to be polled and downloaded
  from the gateway; the download isn't checked and the polling never ends.
- **Bug 27:** artifact names from the renderer can escape the events folder.

**Chosen: events run in the Sump only.** The app edits events and
shows notifications; it never evaluates them.

- The Sump already holds the live Redis streams. It evaluates every series
  and every new log line from a stored stream position, which removes bugs
  15, 22, 23 and 24 by construction.
- A triggered snapshot or recording is created where the data is, so there
  is nothing to poll or download (bugs 26 and 32). The Sump sanitizes the
  artifact name (bug 27).
- Events keep running with the window closed and with the app connected to
  another Sump (D2).
- Each event belongs to the user who created it, through the D3 identity,
  and edits are versioned so a concurrent change is refused, not lost
  (bug 25).
- The app gets firings over a stream from the Sump, shows them in the
  status-bar history and offers each artifact for download into a project.
  Artifacts keep cttc's time to live (`br-EVENT-000002`), but stored on the
  Sump.
- The engine is a Sump plugin, so the fault isolation of Item 7 applies.

**What this gives up:** a single event can't watch two Sumps at once.
Nobody has asked for that, and it can be added later as an app-side
aggregate over Sump firings without bringing back UI evaluation.

## 8. Traceability

Under correlate-app's `CODE-OF-CONDUCT.md` §1, no item starts as development
work until a `FEAT-` or `REQ-` has been opened for it. First register this file
with `/roadmap-add correlate-app-rewrite docs/roadmap/correlate-app-rewrite.md`.
Cite cttc rule and bug IDs in full (`br-GATE-000006-uKKrzikI`,
`BUG-000001-uKKrzikI`) in each REQ, so every carried rule can be traced back to
the cttc analysis it came from.
