# correlate-app

[![CI](https://github.com/cantica-tech/correlate/actions/workflows/ci.yml/badge.svg)](https://github.com/cantica-tech/correlate/actions/workflows/ci.yml)

correlate-app correlates container telemetry with service logs on one shared,
clickable timeline. It is a from-scratch rewrite of cttc; the plan is in
`../docs/roadmap/correlate-app-rewrite.md`.

## Layout

| Folder | What it holds |
|---|---|
| `app/` | The Electron and React client (TypeScript, Jotai, esbuild, Vitest, Biome, npm) |
| `server/` | The Sump, the containerized collector (Python 3.13, uv, ruff, ty, pytest) |
| `server/plugins/` | Sump plugin packages, discovered through the `sump.plugins` entry points |
| `scripts/` | Repository checks, such as `check_layout.py` and `check_versions.py` |

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
| `task check` | Check the layout and the version, then lint, type-check and test both parts |
| `task lint` | Biome and ruff |
| `task typecheck` | Strict TypeScript and ty |
| `task test` | Vitest and pytest |
| `task start` | Build the renderer and open the app |
| `task app:package` | Build this system's installers into `app/dist/` (unsigned unless signing secrets are set) |

`task app:<name>` or `task server:<name>` runs a task in one part only, and
`task --list` shows every task. On a fresh clone, run `task install` and then
`task check`; it must pass before code lands (rules `br-BUILD-000002` and
`br-BUILD-000003`). CI runs the same checks on Linux, macOS and Windows on
every push and pull request, and checks that every commit cites a catalyst ID
or starts `chore:` (rules `br-BUILD-000004` and `br-BUILD-000005`).

## Versions and releases

The app and the Sump carry one version (`app/package.json` and
`server/pyproject.toml`); `task versions` checks it (rule `br-BUILD-000007`).
The app provisions the Sump image of its own version,
`ghcr.io/cantica-tech/correlate-sump:<version>`. `app/resources/icon.png`, the
installers' icon, is rendered from the app's icon by `npm run icon`.

A release is cut from the repository's root Taskfile: `task release:checklist`
says what it takes; `task release` tags `v<version>` (the Release workflow
then builds the installers and the Sump image), follows that build, and
publishes the installers to the distribution repository's checkout
(`../cantica-tech`, `correlate/v<version>/` and the release
`correlate-v<version>` there).
