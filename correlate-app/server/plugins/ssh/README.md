# correlate-sump-plugin-ssh

The Sump's first plugin (roadmap Item 25, `REQ-000024-sJpO9KMY`): local and
SSH transports, and Docker hosts as data streams. At start it registers the
Sump's own host as `self` when the host's Docker socket is mounted into the
Sump's container, with the Sump's own container left out of its list.

- **SSH key**: each Sump makes its own Ed25519 key pair in
  `SUMP_DATA_DIR/ssh/`; the private key never leaves it. Add the public key
  (`GET /plugins/ssh/public-key`) to a host's `authorized_keys`.
- **Host keys**: recorded at the first connection to a host, then required
  to match (`SUMP_DATA_DIR/ssh/known_hosts`).

Ported from correlator's `sump-plugin-ssh`. Its tests run with the server's
(`task server:test`).
