"""correlate-app's Sump server: collects container telemetry and logs and
serves them to the client for correlation.

So far it holds only the pytest/pluggy-style plugin manager (`plugins`) and
the transport and data-source contracts it registers (`transport`,
`datasource`), ported from correlator under decision D6. The server itself
comes in Phase 1 of `docs/roadmap/correlate-app-rewrite.md`.
"""

__version__ = "0.1.1"
