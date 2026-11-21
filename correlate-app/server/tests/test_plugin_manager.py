"""The plugin manager's correlate-app rules (REQ-000005-sJpO9KMY Requirements 1,
3 and 4, and the manager side of 2 and 5): opt-out (br-PLUGIN-000002),
visibility (br-PLUGIN-000003), no overwrites (br-PLUGIN-000004) and load
failures (br-PLUGIN-000005). correlator's ported tests are in test_plugins.py."""

import logging

import pytest
from fastapi import FastAPI

from correlate_sump.plugins import PluginConflictError, PluginManager, hookimpl


class InfoPlugin:
    def __init__(self, name: str) -> None:
        self.name = name

    @hookimpl
    def sump_plugin_info(self) -> dict:
        return {"name": self.name, "version": "1.0"}


alpha = InfoPlugin("alpha")
beta = InfoPlugin("beta")
LOADS: list[str] = []


class _CountingEntryPoint:
    """An entry point that records being loaded, to prove disabled plugins never are."""

    def __init__(self, name: str, plugin: object) -> None:
        self.name = name
        self._plugin = plugin

    def load(self) -> object:
        LOADS.append(self.name)
        return self._plugin


class _BrokenEntryPoint:
    def __init__(self, name: str, exc: Exception) -> None:
        self.name = name
        self._exc = exc

    def load(self) -> object:
        raise self._exc


def install(monkeypatch, *eps) -> None:
    """Pretend `eps` are the installed `sump.plugins` entry points."""
    LOADS.clear()
    monkeypatch.setattr(
        "correlate_sump.plugins._discover_entry_points", lambda group="sump.plugins": list(eps)
    )


# --- br-PLUGIN-000002: on by default, can be turned off -----------------------------


async def test_named_plugins_are_not_loaded_or_imported(monkeypatch) -> None:
    install(monkeypatch, _CountingEntryPoint("alpha", alpha), _CountingEntryPoint("beta", beta))
    manager = PluginManager(disabled=["alpha"])
    assert await manager.discover() == ["beta"]
    assert LOADS == ["beta"]
    states = {p["name"]: p["state"] for p in manager.report()}
    assert states == {"alpha": "disabled", "beta": "loaded"}


async def test_autoload_off_loads_no_entry_point_plugin(monkeypatch) -> None:
    install(monkeypatch, _CountingEntryPoint("alpha", alpha), _CountingEntryPoint("beta", beta))
    manager = PluginManager(disable_autoload=True)
    manager.register(InfoPlugin("in-code"), name="in-code")
    assert await manager.discover() == ["in-code"]
    assert LOADS == []
    states = {p["name"]: p["state"] for p in manager.report()}
    assert states == {"alpha": "disabled", "beta": "disabled", "in-code": "loaded"}


# --- br-PLUGIN-000005: a plugin that fails to load is skipped ----------------------


@pytest.mark.parametrize("exc", [ImportError("no module named boom"), RuntimeError("bad init")])
async def test_failing_plugin_is_skipped_and_reported(monkeypatch, caplog, exc) -> None:
    install(monkeypatch, _BrokenEntryPoint("broken", exc), _CountingEntryPoint("beta", beta))
    manager = PluginManager()
    with caplog.at_level(logging.ERROR):
        assert await manager.discover() == ["beta"]
    assert "plugin 'broken' failed to load" in caplog.text
    report = {p["name"]: p for p in manager.report()}
    assert report["broken"]["state"] == "failed"
    assert report["broken"]["error"] == f"{type(exc).__name__}: {exc}"
    assert report["beta"]["state"] == "loaded"


# --- br-PLUGIN-000003: visibility --------------------------------------------------


async def test_report_gives_manifests_for_loaded_plugins_only(monkeypatch) -> None:
    install(monkeypatch, _CountingEntryPoint("alpha", alpha), _CountingEntryPoint("beta", beta))
    manager = PluginManager(disabled=["beta"])
    await manager.discover()
    assert manager.report() == [
        {
            "name": "alpha",
            "state": "loaded",
            "info": {"name": "alpha", "version": "1.0"},
            "error": None,
        },
        {"name": "beta", "state": "disabled", "info": None, "error": None},
    ]


class BrokenInfoPlugin:
    @hookimpl
    def sump_plugin_info(self) -> dict:
        raise RuntimeError("no manifest")


async def test_broken_manifest_keeps_the_plugin_loaded(caplog) -> None:
    manager = PluginManager()
    manager.register(BrokenInfoPlugin(), name="shy")
    with caplog.at_level(logging.ERROR):
        assert manager.report() == [{"name": "shy", "state": "loaded", "info": None, "error": None}]
    assert "sump_plugin_info failed" in caplog.text


async def test_plugin_without_manifest_reports_null_info() -> None:
    manager = PluginManager()
    manager.register(object(), name="plain")
    assert manager.report() == [{"name": "plain", "state": "loaded", "info": None, "error": None}]


# --- br-PLUGIN-000004: no overwrites -----------------------------------------------


def registering(kind: str, item: str):
    """A plugin registering `item` as `kind` in the matching hook."""

    class Plugin:
        @hookimpl
        def register_transport(self, manager) -> None:
            if kind == "transport":
                manager.add_transport_type(item, object)

        @hookimpl
        def register_data_source(self, manager) -> None:
            if kind == "data source":
                manager.add_data_source(item, object())

        @hookimpl
        def register_background_task(self, manager) -> None:
            if kind == "background task":
                manager.add_background_task(item, lambda: None)

    return Plugin()


@pytest.mark.parametrize(
    ("kind", "label"),
    [
        ("transport", "transport type"),
        ("data source", "data source"),
        ("background task", "background task"),
    ],
)
async def test_same_name_from_two_plugins_is_refused(kind, label) -> None:
    manager = PluginManager()
    manager.register(registering(kind, "shared"), name="first")
    manager.register(registering(kind, "shared"), name="second")
    with pytest.raises(PluginConflictError) as excinfo:
        await manager.discover()
    message = str(excinfo.value)
    assert f"{label} 'shared'" in message
    assert "'first'" in message and "'second'" in message


async def test_different_names_coexist_with_owners() -> None:
    manager = PluginManager()
    manager.register(registering("data source", "one"), name="first")
    manager.register(registering("data source", "two"), name="second")
    await manager.discover()
    assert manager.owners["data source"] == {"one": "first", "two": "second"}


def route_plugin(path: str):
    class Plugin:
        @hookimpl
        def contribute_routes(self, app) -> None:
            @app.get(path)
            async def handler() -> dict:
                return {}

    return Plugin()


def test_plugin_route_clashing_with_a_core_route_names_both() -> None:
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict:
        return {}

    manager = PluginManager()
    manager.register(route_plugin("/health"), name="greedy")
    with pytest.raises(
        PluginConflictError, match="route GET /health registered by both 'sump' and 'greedy'"
    ):
        manager.contribute_routes(app)


def test_plugin_routes_clashing_with_each_other_name_both() -> None:
    manager = PluginManager()
    manager.register(route_plugin("/shared"), name="first")
    manager.register(route_plugin("/shared"), name="second")
    with pytest.raises(PluginConflictError) as excinfo:
        manager.contribute_routes(FastAPI())
    assert "route GET /shared registered by both" in str(excinfo.value)
    assert "'first'" in str(excinfo.value) and "'second'" in str(excinfo.value)


def test_distinct_plugin_routes_are_added() -> None:
    app = FastAPI()
    manager = PluginManager()
    manager.register(route_plugin("/one"), name="first")
    manager.register(route_plugin("/two"), name="second")
    manager.contribute_routes(app)
    assert {"/one", "/two"} <= {getattr(r, "path", None) for r in app.routes}
