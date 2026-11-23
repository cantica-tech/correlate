# Sump plugins

One folder per plugin package, each discovered through the `sump.plugins`
entry-point group: `ssh/` (Docker hosts: the Sump's own, and over SSH) and
`events/` (events, their firings and artifacts).

## Writing a plugin

A plugin is a module-level object whose methods are `@hookimpl`s of
`correlate_sump.plugins.SumpHookSpecs`; it implements any of them:

| Hook | What it does |
| --- | --- |
| `sump_plugin_info` | Its name and version (`GET /plugins`) |
| `register_transport` | Transport types (`local`, `ssh`) |
| `register_data_source` | Data sources it finds (the Sump's own Docker host) |
| `register_stream_kind` | Its data streams' kind (below) |
| `register_background_task` | Long-lived tasks, each supervised and restarted |
| `contribute_routes` | Routes of its own; none may clash with another's |
| `on_health_check` | Whether it is healthy; an unhealthy plugin sleeps |
| `federated_source` | A source collected elsewhere from some time on |
| `source_hidden` | Whether a source of its own is hidden from a user |

Records reach the Sump through `manager.ingest_adapter.ingest(raw)`: JSON
with `kind` (`log` or `metric`), `source` (`<stream id>/<target>`), `ts`
(ISO 8601) and, for a log, `text`; for a metric, the fields the charts draw
(`cpu_percent`, `mem_percent`, `mem_bytes`, `net_bytes`, ...).

## Data streams

A data stream is one source the Sump collects: a Docker host, a log-sump
host, an Elasticsearch cluster... The core keeps every plugin's streams in
one store and holds their rules for all alike (br-PLUGIN-000010-sJpO9KMY):
`GET /streams`, adding, the followed set, pause, privacy, who may change a
stream, and removal (`correlate_sump/streams.py`,
`correlate_sump/stream_routes.py`). A plugin registers a `StreamKind` with
`manager.streams.add_kind(kind)` from `register_stream_kind`, and does only
its own part:

| `StreamKind` member | What it does |
| --- | --- |
| `kinds` | The `kind` values of its streams, unique across plugins |
| `detected()` | Streams it finds rather than keeps (listed first) |
| `create(body)` | A new stream from what the app sent (`POST /streams` with its `kind`) |
| `targets(stream)` | What can be followed there |
| `check_follow(stream)` | Refuse a followed-set change now (`StreamRefused`) |
| `apply(stream, followed)` | Collect exactly that set; nothing stops it |
| `removed(stream)` | Forget what it kept (or refuse, before anything is removed) |
| `describe(stream)` | Fields of its own for `GET /streams` |

## The Kibana/Elasticsearch design spike (REQ-000056-sJpO9KMY)

A stub plugin whose stream is an Elasticsearch-backed system and whose
targets are index patterns runs in the real Sump in
`server/tests/test_stream_kinds.py`: added, listed, followed, paused, made
private, its records queried and hidden, an event's view of it, removed.
Findings:

- **Fixed here.** Data streams were the SSH plugin's alone: no second
  plugin could list, follow or protect its own. They are now the core's.
- **Names that still say "container".** `ContainerRef`, a followed set's
  `containers`, the `containers` of `GET /streams/{id}/targets`, and the
  app's "followed per container" wording. An index pattern fits each by
  shape (two names), not by name. Renaming them is a change across the app
  and the Sump, left for when a second kind ships to people.
- **The chart fields are Docker's.** Metric records carry CPU, memory and
  network fields; an Elasticsearch cluster's own figures (query latency,
  indexing rate, document counts) have no field or chart to go to. A kind
  that is not a container host sends logs, and metrics only where they mean
  the same.
- **The host block is a Docker host's.** Host figures come from a reader on
  the host (`__host__` sources) and events' "host" option; a cluster's
  nodes have no place in it.
- **The app adds only SSH streams.** The Streams dialog's "New" form is
  SSH's; each kind needs its own fields there (Item 58 adds log-sump's).
- **Promotion and secondaries are SSH's.** They stay in the SSH plugin, as
  its routes.
