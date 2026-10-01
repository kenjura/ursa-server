# Watcher

The watcher keeps a sink equal to an Ursa build of a source, continuously:
watch for changes, build the delta, deploy the delta.

## Adapters

Sources and sinks are independent. Any source can feed any sink: edit in
Dropbox, publish to S3; edit locally, publish over rsync.

### Source adapter interface

```js
/** @interface SourceAdapter */
{
  id,                                  // "fs" | "s3" | "dropbox" | "gdrive"
  async init(state),                   // restore cursor from source.json
  async list(),                        // → [{ path, hash, size, mtime }] full listing
  async read(path),                    // → Buffer
  async write(path, bytes, { ifMatch }), // editor writes; ifMatch = expected hash
  async remove(path, { ifMatch }),
  async rename(from, to),
  watch(onChanges),                    // onChanges([{ path, kind }]); returns stop()
  async cursor(),                      // → serialisable position, saved to source.json
  capabilities,                        // { push: bool, conditionalWrite: bool, rename: bool }
}
```

Paths are POSIX, relative to the source root. Like Ursa, the runtime **does not
trust event kinds**: an event means "look at this path", and the adapter's
`sync(path)` step establishes the truth (download, delete from working copy,
or nothing if the hash is unchanged).

### Source modes

| Mode | How changes are detected | Notes |
|---|---|---|
| **fs** | Native recursive watch (same library and deny-list as Ursa). | Working copy = the source; no mirror. The default and the simplest. |
| **s3** (and S3-compatible: R2, B2, MinIO) | **Recommended:** S3 Event Notifications → SQS, long-polled. **Fallback:** periodic `ListObjectsV2` diffed by ETag. | SQS gives seconds of latency at near-zero cost. Polling is fine for small sites and for stores without notifications; the default interval is 30 s. R2 has its own event notifications (to Queues); MinIO supports webhook/AMQP targets. |
| **dropbox** | `files/list_folder/longpoll` + `list_folder/continue` with a persisted cursor. | Close to an ideal fit: the cursor makes restarts resumable and longpoll is cheap. App-folder scope recommended. |
| **gdrive** | `changes.list` with a persisted `startPageToken`; optionally `changes.watch` push notifications. | Push needs a public HTTPS endpoint and channel renewal (channels expire); polling every 30-60 s is the default. **Google Docs are not files**: only real files (`.md` etc.) are synced; native Docs are ignored (or exported; see QUESTIONS.md). |

Third-party sources have quirks the adapter has to absorb:
case-insensitive paths (Dropbox), duplicate names in one folder and
multiple parents (Drive), conflicted copies created by desktop clients. The
adapter normalises these before anything reaches Ursa.

### Sink adapter interface

```js
/** @interface SinkAdapter */
{
  id,                                  // "fs" | "s3" | "rsync" | …
  async init(),
  async put(path, bytes, { contentType, cacheControl }),
  async remove(path),
  async list(),                        // → [{ path, hash }] for reconciliation
  async commit(changedPaths),          // after a batch: e.g. CDN invalidation
}
```

### Sink modes

| Mode | Notes |
|---|---|
| **fs** | Staging output = sink. Nothing to deploy. |
| **s3** | `PutObject` / `DeleteObjects` with `Content-Type` and `Cache-Control` set per path (HTML short or `no-cache`; `?v=`-busted assets long). `commit()` optionally issues a CloudFront invalidation for changed HTML paths. Works for R2/B2/MinIO. |
| **rsync / ssh** | Recommended addition: `ursa/deploy.sh` already rsyncs `output/` to a server, so this mode replaces that script. Pushes the changed paths only (`--files-from`). |
| **dropbox / gdrive** | Possible (same adapters, write side) but neither hosts a website, so the use is a backup/export. Low priority; see QUESTIONS.md. |

Writes to remote sinks are ordered so a reader never sees a page whose assets
aren't there yet: **assets first, then pages, then deletions**. Ursa's
`?v=<content hash>` cache busting means a new asset never overwrites an old
URL a cached page still points to.

## The delta pipeline

A **batch** is one debounce window of source events.

1. **Sync:** for each changed path, the source adapter updates the working
   copy (download / delete). Unchanged hashes are dropped here.
2. **Build:** `graph.invalidatePath()` for each synced path, then `runPass()`.
   Ursa rebuilds the minimal set and reports written and deleted output paths.
3. **Diff:** for each written path, hash the file and compare with the deploy
   manifest; drop paths whose bytes match what the sink already holds.
4. **Deploy:** `put` the remainder (assets, then pages), `remove` the
   deletions, `commit()`. Update the manifest as each operation succeeds.
5. **Persist:** save the source cursor and the manifest.

Steps run one batch at a time (Ursa's single-writer rule). Events arriving
during a batch go into the next one.

**Failure handling:** a failed `put` leaves the manifest entry unchanged, so
the path is retried in the next batch (and on a timer with backoff). A failed
source sync leaves the cursor unadvanced, so the change is seen again. Status
reports the backlog.

## Persistent cache

Three pieces of state make restarts cheap; all live in `stateDir`:

| Piece | Avoids | If lost |
|---|---|---|
| Working copy | Re-downloading the whole source | Full download |
| Ursa build graph (`.ursa/graph.json`) | Rebuilding pages whose inputs didn't change | Cold build (Ursa reruns everything) |
| Deploy manifest (`deploy.json`) | Re-uploading files the sink already has | Reconciliation: `sink.list()` and compare hashes, upload only differences |

The manifest is what makes "force total rebuild" affordable: Ursa's output is
deterministic (content-hash cache busting, no per-build timestamps in pages),
so a clean rebuild produces mostly identical bytes, and the manifest filters
them out before they reach the network.

**Ephemeral hosts** (containers without a volume): the state dir can be
snapshotted to the sink bucket (or a separate one) as a tarball after each
batch that changed it, and restored on start. Optional, off by default.

### Warm start sequence

1. Load source cursor, manifest, Ursa graph.
2. Ask the source for changes since the cursor (all adapters support this:
   SQS retains messages, Dropbox/Drive cursors replay). If the cursor is
   missing or expired, do a full `list()` and diff against the working copy.
3. One pass, one deploy. Then start watching.

## Status model

The runtime exposes, per site:

- `state`: `starting | syncing | building | deploying | idle | error`
- last batch: when, how many source changes, outputs written/deleted, uploads, duration
- backlog: queued source events, failed sink operations awaiting retry
- cache: graph node/leaf counts, working-copy size, manifest entry count
- source/sink health: last successful contact, last error

This is what `GET /sites/:id/status` returns; see [CONTROL.md](CONTROL.md).
