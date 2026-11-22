"""pytest/pluggy-style plugin manager for the Sump server.

Plugins are installed packages declaring themselves in the `sump.plugins`
entry-point group, never found by scanning a directory
(br-PLUGIN-000001-sJpO9KMY). Every installed plugin loads unless turned off
(br-PLUGIN-000002-sJpO9KMY); one that fails to load is skipped and reported
(br-PLUGIN-000005-sJpO9KMY); `report()` says what became of each
(br-PLUGIN-000003-sJpO9KMY). Registrations and routes are made one plugin at a
time, so every name and route has a known owner and a clash stops startup
naming both (br-PLUGIN-000004-sJpO9KMY).

Ported from correlator (`server/src/correlator_sump/plugins.py`) under decision D6 of
`docs/roadmap/correlate-app-rewrite.md`, then extended by REQ-000005-sJpO9KMY.
The `cor-CORE` and `REQ-` IDs in the hook descriptions below are correlator's,
kept as the record of where each hook was proven.
"""

from __future__ import annotations

import inspect
import logging
from abc import abstractmethod
from collections.abc import Callable, Coroutine, Iterable
from dataclasses import dataclass
from importlib.metadata import EntryPoint, entry_points
from typing import Any, Protocol

import pluggy

from correlate_sump.datasource import DataSource
from correlate_sump.transport import Transport

logger = logging.getLogger(__name__)

PROJECT_NAME = "sump"
ENTRY_POINT_GROUP = "sump.plugins"

#: Constructs a `Transport` for a specific target (e.g. `SSHTransport(host,
#: user, port=22)`, `LocalTransport()`) -- parameters differ per transport
#: type, so this is intentionally loose; `register_transport` registers the
#: factory itself, not a pre-built instance, since the target isn't known
#: until something (e.g. a future provisioning flow) actually needs one.
TransportFactory = Callable[..., Transport]

#: Zero-arg callable returning the coroutine a background task runs --
#: a factory rather than a bare coroutine, since a coroutine object can
#: only be awaited/scheduled once and `register_background_task` may be
#: called well before `create_app`'s lifespan actually starts the task
#: (cor-CORE.DATASTREAM-003). `Coroutine`, not the broader `Awaitable`,
#: since `asyncio.create_task` requires specifically a coroutine object.
BackgroundTaskFactory = Callable[[], Coroutine[Any, Any, None]]


class IngestAdapterLike(Protocol):
    """Structural narrowing of `correlate_sump.ingest.IngestAdapter` --
    lets `plugins.py` reference "the thing a background task ingests
    into" without importing the concrete class (mirrors `TransportLike`
    in `transport.py`), and lets a test double satisfy it without
    building a real `IngestAdapter`."""

    async def ingest(self, raw: bytes) -> bool: ...


hookspec = pluggy.HookspecMarker(PROJECT_NAME)
hookimpl = pluggy.HookimplMarker(PROJECT_NAME)


class SumpHookSpecs:
    """The fixed set of hooks a Sump plugin may implement any subset of."""

    @hookspec
    @abstractmethod
    def sump_plugin_info(self) -> dict[str, Any]:
        """Return this plugin's name/version/capability manifest."""

    @hookspec
    def register_transport(self, manager: PluginManager) -> None:
        """Register a `TransportPlugin` implementing the `Transport` ABC.
        May be `async def` (awaited by `PluginManager.discover`)."""

    @hookspec
    def register_data_source(self, manager: PluginManager) -> None:
        """Register a data-stream source (§6.3). May be `async def`
        (awaited by `PluginManager.discover`) -- e.g. self-host detection
        needs a real transport call."""

    @hookspec
    def register_background_task(self, manager: PluginManager) -> None:
        """Register a long-lived background task via
        `manager.add_background_task(name, factory)` (cor-CORE.DATASTREAM-003)
        -- e.g. a data source that relays records into `manager.
        ingest_adapter` itself (set by `create_app` before `discover()`
        runs) rather than through Fluent Bit. `create_app`'s lifespan
        starts one `asyncio.Task` per registered factory after discovery
        and cancels+awaits every one on shutdown. May be `async def`
        (awaited by `PluginManager.discover`, same as
        `register_transport`/`register_data_source`)."""

    @hookspec
    def contribute_routes(self, app: Any) -> None:
        """Optionally add custom API routes to the Sump's FastAPI app."""

    @hookspec(firstresult=True)
    def federated_source(self, source: str) -> Any:
        """A `federation.Federated` when `source` is collected elsewhere from
        some time on (a promoted stream, br-FED-000002-sJpO9KMY), else None."""

    @hookspec(firstresult=True)
    def source_hidden(self, source: str, user: str | None) -> bool | None:
        """True when `source` is hidden from `user` (a private stream of
        someone else, br-STREAM-000007-sJpO9KMY); None when it is not this
        plugin's to say."""

    @hookspec
    def on_health_check(self) -> bool | None:
        """Report this plugin's health. `None` means "not applicable"."""


def _discover_entry_points(group: str = ENTRY_POINT_GROUP) -> Iterable[EntryPoint]:
    """The installed packages declaring themselves in `group`."""
    return entry_points(group=group)


#: The owner name of the Sump's own routes, in conflict messages.
CORE_OWNER = "sump"

#: Plugin states reported by `PluginManager.report`.
LOADED, DISABLED, FAILED = "loaded", "disabled", "failed"

#: Registration hooks, in the order `discover` runs them.
REGISTRATION_HOOKS = ("register_transport", "register_data_source", "register_background_task")


class PluginConflictError(ValueError):
    """Two plugins (or a plugin and the Sump) claimed the same name or route."""


@dataclass
class PluginRecord:
    """What became of one plugin: its name, state, and error if it failed."""

    name: str
    state: str
    error: str | None = None


class PluginManager:
    """Wraps `pluggy.PluginManager` with Sump's entry-point discovery,
    opt-out loading, load-failure handling and per-plugin ownership."""

    def __init__(
        self,
        disabled: Iterable[str] = (),
        ingest_adapter: IngestAdapterLike | None = None,
        disable_autoload: bool = False,
    ) -> None:
        self._disabled = frozenset(disabled)
        self._disable_autoload = disable_autoload
        self._pm = pluggy.PluginManager(PROJECT_NAME)
        self._pm.add_hookspecs(SumpHookSpecs)
        self.records: dict[str, PluginRecord] = {}
        self.loaded_plugin_names: list[str] = []
        self.transport_types: dict[str, TransportFactory] = {}
        self.data_sources: dict[str, DataSource] = {}
        self.background_task_factories: dict[str, BackgroundTaskFactory] = {}
        #: Which plugin registered each name, per kind (br-PLUGIN-000004).
        self.owners: dict[str, dict[str, str]] = {
            "transport type": {},
            "data source": {},
            "background task": {},
        }
        #: The running plugins' runtime (`correlate_sump.runtime.PluginRuntime`),
        #: set by the app once started; `report()` reads runtime state from it.
        self.runtime: Any = None
        #: The plugin whose hook is running, so `add_*` knows the owner.
        self._registering: str = CORE_OWNER
        #: Set by `create_app` before `discover()` runs -- the Sump's own
        #: `IngestAdapter`, so a `register_background_task` hookimpl (e.g.
        #: the logstream plugin) can build a task that ingests directly,
        #: without a Fluent-Bit/TCP round-trip (cor-CORE.DATASTREAM-003).
        self.ingest_adapter = ingest_adapter

    async def discover(self) -> list[str]:
        """Load every installed `sump.plugins` package not turned off, then
        run the registration hooks once, plugin by plugin. Returns the names
        loaded.

        A disabled plugin is never imported. A plugin whose package fails to
        load is logged, recorded as failed and skipped; the others carry on.
        Registration hooks run only after every plugin has loaded, so none
        misses another's registration; an `async def` hookimpl is awaited.
        """
        for ep in _discover_entry_points():
            if self._disable_autoload or ep.name in self._disabled:
                self.records[ep.name] = PluginRecord(ep.name, DISABLED)
                continue
            try:
                plugin = ep.load()
            except Exception as exc:  # any error importing a plugin: skip it, never crash
                logger.error("plugin %r failed to load; skipped", ep.name, exc_info=True)
                self.records[ep.name] = PluginRecord(
                    ep.name, FAILED, f"{type(exc).__name__}: {exc}"
                )
                continue
            self._pm.register(plugin, name=ep.name)
            self.records[ep.name] = PluginRecord(ep.name, LOADED)
            self.loaded_plugin_names.append(ep.name)
        for hook_name in REGISTRATION_HOOKS:
            await self._call_per_plugin(hook_name, manager=self)
        return self.loaded_plugin_names

    async def _call_per_plugin(self, hook_name: str, **kwargs: Any) -> None:
        """Run `hook_name` one plugin at a time, recording whose turn it is."""
        for impl in getattr(self._pm.hook, hook_name).get_hookimpls():
            self._registering = impl.plugin_name
            try:
                result = impl.function(**{arg: kwargs[arg] for arg in impl.argnames})
                if inspect.isawaitable(result):
                    await result
            finally:
                self._registering = CORE_OWNER

    def _claim(self, kind: str, name: str) -> None:
        """Record the running plugin as `name`'s owner; refuse a name already taken."""
        owners = self.owners[kind]
        if name in owners:
            raise PluginConflictError(
                f"{kind} {name!r} registered by both {owners[name]!r} and {self._registering!r}"
            )
        owners[name] = self._registering

    def add_transport_type(self, name: str, factory: TransportFactory) -> None:
        """Called by a plugin's `register_transport` hookimpl to register a
        `Transport` factory under `name` (e.g. `"ssh"`, `"local"`)."""
        self._claim("transport type", name)
        self.transport_types[name] = factory

    def add_data_source(self, name: str, source: DataSource) -> None:
        """Called by a plugin's `register_data_source` hookimpl to register
        a concrete `DataSource` under `name` (e.g. `"self"`)."""
        self._claim("data source", name)
        self.data_sources[name] = source

    def add_background_task(self, name: str, factory: BackgroundTaskFactory) -> None:
        """Called by a plugin's `register_background_task` hookimpl to
        register a long-lived task under `name` (cor-CORE.DATASTREAM-003)."""
        self._claim("background task", name)
        self.background_task_factories[name] = factory

    def contribute_routes(self, app: Any) -> None:
        """Let each plugin add routes to `app`, one plugin at a time.

        The app's existing routes belong to the Sump. A plugin route whose
        path and method are already taken stops startup with a
        `PluginConflictError` naming both owners (br-PLUGIN-000004).
        """
        owners: dict[tuple[str, str], str] = {}
        for key in _route_keys(getattr(app, "routes", [])):
            owners.setdefault(key, CORE_OWNER)
        for impl in self._pm.hook.contribute_routes.get_hookimpls():
            before = len(app.routes)
            impl.function(**{arg: app for arg in impl.argnames})
            for key in _route_keys(app.routes[before:]):
                if key in owners:
                    path, method = key
                    raise PluginConflictError(
                        f"route {method} {path} registered by both {owners[key]!r} "
                        f"and {impl.plugin_name!r}"
                    )
                owners[key] = impl.plugin_name

    def report(self) -> list[dict[str, Any]]:
        """Every discovered or directly registered plugin, sorted by name, with
        its state, manifest (`sump_plugin_info`, when loaded) and error, and,
        for a loaded plugin once the runtime runs, its `runtime` state and
        `tasks` (br-PLUGIN-000009); `null` otherwise."""
        infos: dict[str, Any] = {}
        for impl in self._pm.hook.sump_plugin_info.get_hookimpls():
            try:
                infos[impl.plugin_name] = impl.function()
            except Exception:  # a broken manifest must not hide the plugin
                logger.error("plugin %r: sump_plugin_info failed", impl.plugin_name, exc_info=True)
        entries = []
        for record in sorted(self.records.values(), key=lambda r: r.name):
            loaded = record.state == LOADED
            live = self.runtime.plugin_state(record.name) if loaded and self.runtime else {}
            entries.append(
                {
                    "name": record.name,
                    "state": record.state,
                    "info": infos.get(record.name) if loaded else None,
                    "error": record.error,
                    "runtime": live.get("runtime"),
                    "tasks": live.get("tasks"),
                }
            )
        return entries

    def health_checks(self) -> list[tuple[str, Callable[[], Any]]]:
        """Each loaded plugin's own `on_health_check`, by plugin name
        (br-PLUGIN-000008); plugins without one are not listed."""
        return [
            (impl.plugin_name, impl.function)
            for impl in self._pm.hook.on_health_check.get_hookimpls()
        ]

    @property
    def hook(self) -> Any:
        """pluggy's hook relay, to call a hook on every plugin at once."""
        return self._pm.hook

    def register(self, plugin: Any, name: str | None = None) -> None:
        """Register a plugin object directly (used by tests and by code
        that already holds a plugin instance rather than an entry point)."""
        registered = self._pm.register(plugin, name=name) or name or repr(plugin)
        self.records[registered] = PluginRecord(registered, LOADED)
        self.loaded_plugin_names.append(registered)


def _route_keys(routes: Iterable[Any]) -> list[tuple[str, str]]:
    """`(path, method)` for every method of every route in `routes`."""
    return [
        (route.path, method.upper())
        for route in routes
        if getattr(route, "path", None) and getattr(route, "methods", None)
        for method in route.methods
    ]


def validate_plugin_routes(app: Any) -> None:
    """Validate routes on `app` to ensure no two routes share the same path
    and HTTP method combination (cor-CORE.PLUGIN-002). Raises `ValueError`
    if a route collision is detected."""
    seen_endpoints: set[tuple[str, str]] = set()
    for route in getattr(app, "routes", []):
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if path and methods:
            for method in methods:
                key = (path, method.upper())
                if key in seen_endpoints:
                    raise ValueError(
                        f"Plugin route conflict detected for path '{path}' and method '{method}'"
                    )
                seen_endpoints.add(key)
