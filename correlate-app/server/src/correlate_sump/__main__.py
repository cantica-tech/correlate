"""Run the Sump: `python -m correlate_sump`.

Configures OpenTelemetry from the `OTEL_*` variables, then serves the app with
uvicorn on `SUMP_HOST`:`SUMP_PORT` (default 127.0.0.1:8765). The container
sets `SUMP_HOST=0.0.0.0` so Docker can publish the port, and its compose file
publishes it on 127.0.0.1 only (br-SUMP-000009-sJpO9KMY).
"""

from __future__ import annotations

import logging
import os

import uvicorn

from correlate_sump.app import create_app
from correlate_sump.otel import configure_from_env


def main() -> None:
    """Configure telemetry and serve the Sump until interrupted."""
    logging.basicConfig(level=os.environ.get("SUMP_LOG_LEVEL", "INFO"))
    traces_on, metrics_on = configure_from_env()
    logging.getLogger(__name__).info(
        "OpenTelemetry export: traces %s, metrics %s",
        "on" if traces_on else "off",
        "on" if metrics_on else "off",
    )
    app = create_app()
    uvicorn.run(
        app,
        host=os.environ.get("SUMP_HOST", "127.0.0.1"),
        port=int(os.environ.get("SUMP_PORT", "8765")),
    )


if __name__ == "__main__":
    main()
