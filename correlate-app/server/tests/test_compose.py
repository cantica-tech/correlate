"""br-SUMP-000009-sJpO9KMY, for the Sump's own compose file (REQ-000004-sJpO9KMY
Requirement 5): every published port binds to 127.0.0.1, and Redis is never
published."""

import re
from pathlib import Path

import yaml

COMPOSE = Path(__file__).resolve().parent.parent / "docker-compose.yml"

#: Redis's port inside the container.
REDIS_PORT = "6379"


def published_ports() -> list[str]:
    """Every `ports:` entry of every service, as written."""
    services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
    return [str(port) for service in services.values() for port in service.get("ports", [])]


def test_compose_publishes_ports() -> None:
    assert published_ports(), "the Sump must publish its API and ingest ports"


def test_every_published_port_is_loopback_only() -> None:
    for port in published_ports():
        assert port.startswith("127.0.0.1:"), f"{port!r} is not bound to 127.0.0.1"


def test_redis_is_not_published() -> None:
    for port in published_ports():
        container_port = re.split(r"[:/]", port.rsplit(":", 1)[-1])[0]
        assert container_port != REDIS_PORT, f"{port!r} publishes Redis"


def test_no_host_networking() -> None:
    services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
    for name, service in services.items():
        assert service.get("network_mode") != "host", f"{name} uses host networking"
