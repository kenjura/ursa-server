# Control API and CLI

Operating the server itself, as opposed to editing a site.

## Transport

- HTTP + JSON, **default `127.0.0.1:7071`** (`control.host` / `control.port`).
- Optionally a Unix socket (`control.socket`, created mode 0600). The CLI
  prefers it when the config names one.
- Auth: see [AUTH.md](AUTH.md#control-api-auth-implemented). In short: the
  socket is trusted; over TCP, a configured `control.token` is required on
  every request.

## Endpoints

Site routes live under `/sites/:id/…`. With one site, the same routes work
without the prefix (`/rebuild`, `/log`, …).

| Method | Path | Does |
|---|---|---|
| GET | `/health` | `{ ok: true }`. No auth; for load balancers and monitors. |
| GET | `/status` | Server version and every site's status. |
| GET | `/sites/:id/status` | One site: state, source and sink, last batch and deploy, backlog (pending changes, queued jobs, undeployed files), cache stats, recent jobs, last error. |
| GET | `/events`, `/sites/:id/events` | Server-sent events: `log`, `state`, `batch-start`, `batch-end`, `deploy`, `job-start`, `job-end`. |
| POST | `/sites/:id/rebuild` | **Force total rebuild**: discard Ursa's build cache, empty the staging output, build everything, then reconcile the sink. Body `{ "deploy": "diff" \| "all" }`: `diff` uploads only files whose bytes changed (in practice all pages, since they carry a build stamp, and no unchanged assets); `all` forgets the manifest and re-uploads everything. |
| POST | `/sites/:id/cache/invalidate` | **Force cache invalidation.** Body `{ "scope", "paths"? }`. `graph` with `paths` (relative to the source): rebuild what those files feed. `graph` without paths: same as rebuild. `working-copy`: re-fetch a remote source (for `fs`, same as sync). `manifest`: forget what the sink holds, ask the sink (S3 listing), upload what differs. `all`: everything. |
| POST | `/sites/:id/sync` | Re-check every source file (for missed watcher events), build, and reconcile the sink with the output. |
| POST | `/sites/:id/pause`, `/resume` | Stop/start building. Changes are queued meanwhile, not lost. Returns status. |
| GET | `/sites/:id/jobs/:jobId` | A job's state (`queued`, `running`, `done`, `failed`, `cancelled`) and result. The last 100 are kept. |
| GET | `/sites/:id/log?since=<seq>` | Recent log lines (the last 1000). |

`rebuild`, `cache/invalidate` and `sync` return `202 Accepted` with a job id.
Jobs run in order, between batches of source changes, never during one.
Failed deploys are retried automatically (30 s, doubling to 10 min) as
`retry` jobs.

## CLI

`ursa-server` is both the daemon and its client.

```bash
ursa-server start [config.yml]               # run the server
ursa-server start --source docs --serve      # no config: one local site
ursa-server status [--site id] [--json]
ursa-server rebuild [--deploy diff|all] [--no-wait]
ursa-server invalidate [graph|working-copy|manifest|all] [paths...] [--no-wait]
ursa-server sync [--no-wait]
ursa-server pause | resume
ursa-server logs [-f]
```

Commands that queue a job wait for it and print the result unless
`--no-wait`. Exit status is non-zero if the job failed.

The client finds the server from `--url` / `URSA_SERVER_URL`; else from the
config (`--config`, or `./ursa-server.yml`): its socket if present, else its
host and port; else `http://127.0.0.1:7071`. Token from `--token`,
`URSA_SERVER_TOKEN`, or the config.
