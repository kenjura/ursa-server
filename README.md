# ursa-server

A long-running server for [Ursa](https://github.com/kenjura/ursa) sites. Where
`ursa generate` builds a site once and `ursa serve` rebuilds it while you work
on your own machine, `ursa-server` keeps a site continuously built **from
wherever its sources live to wherever it is published**, and (later) gives
people a web UI to edit it.

It's meant for a machine that stays on: a home server, an EC2 instance, a VPS.

**Status:** M1 and M2 of the [roadmap](docs/ROADMAP.md) are built, plus
Auth0 sign-in. It watches a local folder, rebuilds incrementally with Ursa,
and deploys only changed files to a local folder, an S3-compatible bucket
(with CloudFront invalidation) or a server over rsync. The served site can
require an Auth0 (or any OIDC) sign-in. There's a control API and CLI. Remote
sources (S3, Dropbox, Google Drive) and the editor come next.

## Quick start

Requires Node 24+ and `@kenjura/ursa` ≥ 0.103.0.

```bash
npm install
npx ursa-server start --source ./docs --output ./site --serve   # dev: watch, build, serve with live reload
```

From a config file: start from [ursa-server.example.yml](ursa-server.example.yml)
(local folder in and out, Auth0 sign-in; set-up steps in
[docs/AUTH.md](docs/AUTH.md#setting-up-auth0)), or publish to S3
(see [docs/CONFIG.md](docs/CONFIG.md)):

```yaml
# ursa-server.yml
sites:
  - id: wiki
    source: { type: fs, path: /srv/wiki/docs }
    sink:
      type: s3
      bucket: wiki.example.com
      cloudfront: { distribution-id: E123ABC }
```

```bash
ursa-server start                 # reads ./ursa-server.yml
ursa-server status                # what it's doing
ursa-server rebuild               # discard the build cache, rebuild, deploy what differs
ursa-server invalidate graph a.md # rebuild one source file's outputs
ursa-server logs -f
```

To run it as a service, see [infra/](infra/README.md) (systemd unit, Docker).

### Developing against a local Ursa

```bash
pnpm install
pnpm run link-ursa       # use ../ursa (or $URSA_PATH) instead of the npm package; `pnpm install` undoes it
pnpm test
```

## What it does

| Role | What it does | Status | Doc |
|---|---|---|---|
| **Watcher** | Watches a source for changes, rebuilds only what changed using Ursa's incremental build graph, and deploys the delta to a sink. Has a control API and CLI for status, cache invalidation and full rebuilds. | fs source; fs, s3, rsync sinks | [WATCHER.md](docs/WATCHER.md), [CONTROL.md](docs/CONTROL.md) |
| **Server** | Serves the built site over HTTP with live reload, optionally behind Auth0 sign-in. Mainly for development and previews. | Done | [SERVER.md](docs/SERVER.md), [AUTH.md](docs/AUTH.md) |
| **Editor** | A web UI for editing the source files, behind Auth0 (and other providers). Edits are written back through the source adapter, so the watcher picks them up like any other change. | Designed | [EDITOR.md](docs/EDITOR.md), [AUTH.md](docs/AUTH.md) |

```
             ┌──────────── ursa-server ─────────────┐
 Source  ──▶ │ source adapter ─▶ working copy        │
 (fs; later  │                     │                 │
  s3, dropbox│                     ▼                 │
  gdrive)    │          Ursa build graph (runPass)   │ ──▶ Sink
   ▲         │                     │                 │    (fs, s3 + CloudFront, rsync)
   │         │                     ▼                 │
   │         │    staging output ─▶ deploy manifest  │
   │         │                     │                 │
   │         │              dev server ──────────────│──▶ browsers (dev)
   └──────── │ editor (writes via source adapter)    │
             │ control API ◀── CLI                   │
             └───────────────────────────────────────┘
```

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit, and what reuses Ursa
- [WATCHER.md](docs/WATCHER.md): source/sink adapters, the delta pipeline, the persistent cache
- [CONTROL.md](docs/CONTROL.md): control API and CLI
- [SERVER.md](docs/SERVER.md): the dev server
- [EDITOR.md](docs/EDITOR.md): the editing UI
- [AUTH.md](docs/AUTH.md): auth for the editor and control API
- [CONFIG.md](docs/CONFIG.md): the config file
- [UPSTREAM.md](docs/UPSTREAM.md): changes made (and still wanted) in Ursa
- [ROADMAP.md](docs/ROADMAP.md): build order
- [QUESTIONS.md](docs/QUESTIONS.md): decisions taken and still open

## Layout

```
bin/          ursa-server executable
docs/         design docs (start with ARCHITECTURE.md)
src/
  cli/        commands; all but `start` are thin control-API clients
  config/     config loading and validation
  core/       site runtime (build → deploy loop), deploy manifest, process startup
  adapters/
    source/   fs (s3, dropbox, gdrive: M3)
    sink/     fs, s3, rsync
  control/    control API (HTTP + SSE, TCP and Unix socket)
  editor/     editor API and UI (M4)
  auth/       auth providers (M5)
  util/
test/         node:test suites (`npm test`)
infra/
  aws/        IAM policy for the S3 + CloudFront sink
  systemd/    service unit for a VPS / home server
  docker/     Dockerfile
  local/      docker-compose with MinIO standing in for S3
  terraform/  placeholder
```
