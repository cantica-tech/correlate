# correlate-sump-plugin-logsump

The Sump's log-sump plugin (REQ-000057-sJpO9KMY): each Docker host of a
log-sump server (v0.4.2, `GET /catalog`, `GET /records` behind `X-API-Key`)
is a data stream, `logsump:<docker host>@<server>`. Its records are polled
every 5 s and translated to the Sump's own; its URL and API key are kept
owner-only in the Sump's data folder and never returned.

The relay reads a time window overlapping the last one by 30 s and drops the
records it already has, so each arrives once; a log-sump whose clock is more
than 30 s apart from the Sump's can lose records at a window's edge.
