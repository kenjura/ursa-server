# Control API and CLI

Operating the server itself, as opposed to editing a site.

## Transport

- HTTP + JSON on its own listener, **default `127.0.0.1:7071`** (not the
  public port).
- Optionally a Unix socket (`control.socket`), which the CLI prefers when it
  is local. File permissions are the auth.
- Remote use requires a bearer token (`control.token`, or an `admin` role from
  the editor's auth provider; see [AUTH.md](AUTH.md)).

## Endpoints

All site-scoped endpoints live under `/sites/:id`. With one site configured,
`/sites/default` and the bare paths (`/status`, …) are equivalent.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness: `200` if the process is up. For load balancers. |
| GET | `/status` | All sites, summary. |
| GET | `/sites/:id/status` | Full status model (see [WATCHER.md](WATCHER.md#status-model)). |
| GET | `/sites/:id/events` | Server-sent events: batch start/end, deploy progress, errors. The CLI's `--follow` uses this. |
| POST | `/sites/:id/rebuild` | **Force total rebuild.** Ursa build with `clean: true` (graph discarded, staging output emptied), then a normal deploy filtered by the manifest. Body: `{ "deploy": "diff" \| "all" }`; `all` ignores the manifest and re-uploads everything. |
| POST | `/sites/:id/cache/invalidate` | **Force cache invalidation.** Body: `{ "scope": "graph" \| "working-copy" \| "manifest" \| "all", "paths"?: [...] }`. With `paths`, only those source paths are invalidated in the graph (or re-downloaded, for `working-copy`) and a pass runs. Without, the whole scope is dropped and rebuilt on the next pass. `manifest` triggers a sink reconciliation. |
| POST | `/sites/:id/sync` | Full source rescan (`list()` + diff), for when a change was missed. |
| POST | `/sites/:id/pause` / `resume` | Stop/start consuming source events (events are queued, not lost). Useful during bulk edits. |
| GET | `/sites/:id/log?since=` | Recent log lines (ring buffer). |

Mutating endpoints return `202 Accepted` with a job id; the job is the next
batch. `GET /sites/:id/jobs/:jobId` reports its outcome. They never run
concurrently with a batch: they're queued behind it.

## CLI

`ursa-server` is both the daemon and its client.

```bash
ursa-server start [config.yml]          # run the server (roles from config, or flags)
ursa-server start --watch --serve       # roles as flags
ursa-server status [--site id] [--json]
ursa-server rebuild [--site id] [--deploy all]
ursa-server invalidate [graph|working-copy|manifest|all] [paths...]
ursa-server sync
ursa-server pause | resume
ursa-server logs [--follow]
```

The client finds the server via `--url`, `URSA_SERVER_URL`, the socket path
in the config, or `http://127.0.0.1:7071`, in that order. Token from
`--token` or `URSA_SERVER_TOKEN`.

**Recommendation:** use yargs for the CLI (Ursa already does), and keep the
CLI a thin HTTP client: every command is one API call, so anything the CLI can
do, a script or a dashboard can do too.
