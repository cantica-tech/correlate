# correlate-app

correlate-app correlates container telemetry with service logs on one shared,
clickable timeline. It is a from-scratch rewrite of cttc; the plan is in
`../docs/roadmap/correlate-app-rewrite.md`.

## Layout

| Folder | What it holds |
|---|---|
| `app/` | The Electron and React client (TypeScript, Jotai, esbuild, Vitest, Biome, npm) |
| `server/` | The Sump, the containerized collector (Python 3.13, uv, ruff, ty, pytest) |
| `server/plugins/` | Sump plugin packages, discovered through the `sump.plugins` entry points |
| `scripts/` | Repository checks, such as `check_layout.py` |

Product code lives only in `app/` and `server/` (rule `br-BUILD-000001`).

## Requirements

- [Task](https://taskfile.dev) 3
- Node.js 22.12 or later, with npm
- [uv](https://docs.astral.sh/uv/)

## Commands

Run these from the repository root. Each one runs in both `app/` and
`server/`.

| Command | What it does |
|---|---|
| `task install` | Install both parts' dependencies from their lockfiles |
| `task check` | Check the layout, then lint, type-check and test both parts |
| `task lint` | Biome and ruff |
| `task typecheck` | Strict TypeScript and ty |
| `task test` | Vitest and pytest |
| `task start` | Build the renderer and open the app |

`task app:<name>` or `task server:<name>` runs a task in one part only, and
`task --list` shows every task. On a fresh clone, run `task install` and then
`task check`; it must pass before code lands (rules `br-BUILD-000002` and
`br-BUILD-000003`).
