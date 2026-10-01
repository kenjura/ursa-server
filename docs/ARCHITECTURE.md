# Architecture

## The one big decision: reuse Ursa's build graph

Ursa 0.97+ already solves the hardest part of this project. `ursa serve`
watches a docroot, records every file each output reads, and on a change
rebuilds only the outputs whose inputs actually changed, persisting the graph
in `<docroot>/.ursa/graph.json` so a restart only has to re-check what moved
(see `ursa/docs/SERVE.md`). Its invariants are exactly what this server needs:

- **Convergence:** after any sequence of edits the output equals a clean build.
- **Minimality:** an output is rewritten only if an input it consumed changed.
- **Viewer first:** pages a browser is looking at are rebuilt before the rest.

So ursa-server **does not reimplement watching-and-rebuilding**. It wraps
Ursa's `createBuild()` / `runPass()` (`ursa/src/helper/build/pass.js`) and adds
what Ursa doesn't do: remote sources, remote sinks, a control plane, and an
editor.

The constraint this brings: Ursa's graph reads the docroot through
`tracedFs`, which is the local filesystem. Everything below follows from that.

## Pipeline

```
source adapter ──events──▶ working copy (local dir) ──▶ runPass() ──▶ staging output (local dir)
                                                                            │
                                                         changed paths ◀────┘
                                                                │
                                                         sink adapter (delta)
```

1. **Source adapter** reports changes and keeps a local **working copy** of the
   sources in step. For a local-FS source the working copy *is* the source;
   no copying happens.
2. The site runtime (`src/core/site.js`) collects the changed paths into a
   batch (same debounce as Ursa: 500 ms quiet / 2000 ms max), invalidates them
   in the graph and calls `runPass()`.
3. Ursa writes into a local **staging output** directory and reports which
   output paths it wrote and deleted (this needs a small upstream change;
   see [UPSTREAM.md](UPSTREAM.md)).
4. **Sink adapter** pushes exactly those paths. A **deploy manifest**
   (output path → content hash of what the sink holds) filters out writes whose
   bytes didn't change, so a forced full rebuild deploys almost nothing.

For a local-FS sink, the staging output is the sink and step 4 is a no-op.

### Why a local working copy for remote sources

Alternatives considered:

- **Teach Ursa's `tracedFs` to read remote storage.** Every `stat`, existence
  probe and directory listing in a pass would become a network call. A warm
  start re-checks every leaf; on S3 that's thousands of HEAD requests per pass.
  Rejected.
- **Mount the bucket (s3fs, rclone mount).** Works without code, but the mount
  generates poor change events, has odd consistency, and hides failures.
  Supported by accident (it's just a local folder) but not recommended.
- **Local mirror, synced by the adapter.** The adapter downloads a changed
  object once, then Ursa reads it from disk as often as it likes. Disk cost is
  the size of the sources, which for a wiki is small. **Chosen.**

## Processes and roles

One Node process hosts any combination of the three roles. Each role is a
module that receives the shared **site runtime**:

| Module | Needs |
|---|---|
| `core/site.js` (always) | config, source adapter, sink adapter, Ursa build |
| `server/` | staging output dir; live-reload hooks from the runtime |
| `editor/` | source adapter (to write), auth, the runtime (for status/preview) |
| `control/` | the runtime; auth (admin) |

Recommended split in production: run `watch` and `edit` together, and let a CDN
serve the sink. The built-in server is for dev and previews (see
[SERVER.md](SERVER.md)).

## Multi-site

The config takes a list of `sites`, each with its own source, sink, working
copy, cache and build. The MVP runs one; the shape is plural from day one so
the control API's URLs (`/sites/:id/...`) don't change later.

Ursa's build uses module-level state in a few places (the parser pool, the
profiler), so multiple sites in one process may need to be **one worker
thread per site**. To be verified when multi-site is built.

## State on disk

All under a single state directory (`stateDir`, default `./.ursa-server/`):

```
.ursa-server/
  sites/<id>/
    work/          working copy (remote sources only)
    work/.ursa/    Ursa's build graph (lives in the docroot today; see UPSTREAM.md)
    out/           staging output
    deploy.json    deploy manifest: what the sink currently holds
    source.json    source cursor: S3 queue position / Dropbox cursor / Drive page token
```

This directory is the "persistent Ursa cache". Losing it is safe: the next
start is a cold build and a full manifest reconciliation (see
[WATCHER.md](WATCHER.md#persistent-cache)), which costs time, not correctness.

## Tech choices (recommended)

- **Node 24, plain ESM JavaScript with JSDoc types**, matching Ursa. Ursa is
  imported as a library (`@kenjura/ursa`), not shelled out to.
- **HTTP:** Fastify for the control and editor APIs (schemas, good plugin
  story for auth). Ursa already uses Express for `serve`; the static server
  can reuse Ursa's directly (see [SERVER.md](SERVER.md)).
- **Storage SDKs:** `@aws-sdk/client-s3` (+ `client-sqs`) for any
  S3-compatible store (AWS, R2, B2, MinIO), `dropbox`, `googleapis`.
- **Editor UI:** CodeMirror 6 plus a small amount of Preact, built with
  esbuild (already a dependency of Ursa). No SPA framework.
