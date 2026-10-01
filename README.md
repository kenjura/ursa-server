# ursa-server

A long-running server for [Ursa](https://github.com/kenjura/ursa) sites. Where
`ursa generate` builds a site once and `ursa serve` rebuilds it while you work
on your own machine, `ursa-server` keeps a site continuously built **from
wherever its sources live to wherever it is published**, and optionally gives
people a web UI to edit it.

**Status:** scaffold only. The docs describe the intended design; `src/` holds
stubs that mark where each piece goes. Nothing runs yet.

## What it does

It has three roles. They can be turned on independently in one process.

| Role | What it does | Doc |
|---|---|---|
| **Watcher** | Watches a source (local folder, bucket, Dropbox, Google Drive) for changes, rebuilds only what changed using Ursa's incremental build graph, and deploys the delta to a sink (local folder, bucket, …). Has a control API and CLI for status, cache invalidation and full rebuilds. | [docs/WATCHER.md](docs/WATCHER.md), [docs/CONTROL.md](docs/CONTROL.md) |
| **Server** | Serves the built site over HTTP with live reload. Mainly for development and previews. | [docs/SERVER.md](docs/SERVER.md) |
| **Editor** | A web UI for editing the source files, behind pluggable auth. Edits are written back through the source adapter, so the watcher picks them up like any other change. | [docs/EDITOR.md](docs/EDITOR.md), [docs/AUTH.md](docs/AUTH.md) |

```
             ┌──────────── ursa-server ─────────────┐
 Source  ──▶ │ source adapter ─▶ working copy        │
 (fs, s3,    │                     │                 │
  dropbox,   │                     ▼                 │
  gdrive)    │          Ursa build graph (runPass)   │ ──▶ Sink
   ▲         │                     │                 │    (fs, s3, rsync, …)
   │         │                     ▼                 │
   │         │       staging output ─▶ sink adapter  │
   │         │                     │                 │
   │         │              static server ───────────│──▶ browsers (dev)
   └──────── │ editor (writes via source adapter)    │
             │ control API ◀── CLI                   │
             └───────────────────────────────────────┘
```

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, and what reuses Ursa
- [WATCHER.md](docs/WATCHER.md): source/sink adapters, the delta pipeline, the persistent cache
- [CONTROL.md](docs/CONTROL.md): control API and CLI
- [SERVER.md](docs/SERVER.md): the static/dev server
- [EDITOR.md](docs/EDITOR.md): the editing UI
- [AUTH.md](docs/AUTH.md): auth for the editor and control API
- [CONFIG.md](docs/CONFIG.md): the config file
- [UPSTREAM.md](docs/UPSTREAM.md): changes this needs in Ursa itself
- [ROADMAP.md](docs/ROADMAP.md): build order
- [QUESTIONS.md](docs/QUESTIONS.md): open decisions

## Layout

```
docs/     design docs (start with ARCHITECTURE.md)
src/
  cli/        `ursa-server` command: start, status, rebuild, invalidate, …
  config/     config file loading and validation
  core/       site runtime: wires a source, the Ursa build and a sink together
  adapters/
    source/   fs, s3, dropbox, gdrive: list/read/write/watch
    sink/     fs, s3, rsync: put/delete
  control/    control API (HTTP + SSE)
  server/     static file server with live reload
  editor/
    api/      file CRUD for the editor UI
    ui/       the editor front end
  auth/       auth provider interface and providers
infra/
  docker/     Dockerfile
  local/      docker-compose for local dev (with MinIO standing in for S3)
  terraform/  AWS reference deployment (bucket, queue, CDN, IAM)
```
