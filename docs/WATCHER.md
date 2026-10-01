# Watcher

The watcher keeps a sink equal to an Ursa build of a source, continuously:
watch for changes, build the delta, deploy the delta.

## Adapters

Sources and sinks are independent. Any source can feed any sink: edit in
Dropbox, publish to S3; edit locally, publish over rsync.

### Source adapter interface

The contract is in `src/adapters/types.js`. Implemented today (`fs`):

```js
{
  id,
  workingCopy,          // absolute folder Ursa builds from (for fs: the source itself)
  async init(),         // restore cursor, bring the working copy up to date
  watch(onChanges),     // onChanges(absPaths); returns stop()
  async refresh(),      // optional: full rescan of the remote into the working copy
  describe(),
}
```

Remote sources (M3) add what the editor needs: `read`, `write(path, bytes,
{ ifMatch })`, `remove`, `rename`, and a persisted `cursor`.

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
{
  id,                       // identifies the destination; if it changes, the deploy manifest is discarded
  inPlace,                  // true: the site is built straight into the destination (fs)
  batched,                  // true: one sync(rels) per deploy (rsync) instead of put/remove
  async init({ output }),
  async put(rel, absPath),  // content type and cache headers are the sink's business
  async remove(rels),
  async sync(rels),         // batched sinks: rels that exist locally are sent, the rest deleted
  async list(),             // → Map(rel → MD5) the destination holds, or null if it can't tell
  async commit(changedRels),// after a deploy: CDN invalidation
  describe(),
}
```

### Sink modes

| Mode | Notes |
|---|---|
| **fs** | Staging output = sink. Nothing to deploy. |
| **s3** | **Implemented.** `PutObject` / `DeleteObjects` with `Content-Type` and `Cache-Control` per kind (HTML and JSON revalidate every time; other assets `max-age=3600` by default). With `cloudfront`, `commit()` invalidates every URL form of each changed file (`/a.html`, `/a`, and `/dir/` for an index), collapsing to `/*` past `max-paths` (default 25). All CloudFront invalidations count against its free monthly allowance by path; `/*` counts as one. Works for R2/B2/MinIO via `endpoint`. Credentials: the AWS default chain (env, `~/.aws` profile, instance role) or `credentials` in the config. Minimal IAM policy: [infra/aws/iam-policy.json](../infra/aws/iam-policy.json). |
| **rsync / ssh** | **Implemented.** Replaces `ursa/deploy.sh`. One rsync run per deploy with the changed paths in `--files-from`; `--delete-missing-args` deletes the removed ones. Only paths ursa-server deployed are ever deleted. SSH runs with `BatchMode=yes`, so a key (`ssh-key`) or agent is required. Needs rsync ≥ 3.1 on both ends, and the target folder must exist. |
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

The manifest is what makes "force total rebuild" affordable: Ursa's assets
are deterministic (content-hash cache busting), so a clean rebuild reproduces
them byte for byte and the manifest filters them out before they reach the
network. **Pages are the exception:** every page's footer carries the build
number and time, so a clean rebuild re-uploads every page (and, with
CloudFront, invalidates `/*` once past `max-paths`). Incremental passes don't have this problem;
Ursa only stamps pages it rebuilds anyway. See UPSTREAM.md for an optional
Ursa change that would remove it.

**Ephemeral hosts** (containers without a volume): the state dir can be
snapshotted to the sink bucket (or a separate one) as a tarball after each
batch that changed it, and restored on start. Optional, off by default.

### Warm start sequence

1. Load source cursor, manifest, Ursa graph.
2. Ask the source for changes since the cursor (all adapters support this:
   SQS retains messages, Dropbox/Drive cursors replay). If the cursor is
   missing or expired, do a full `list()` and diff against the working copy.
   (For `fs`, Ursa's warm start re-checks every known file.)
3. One pass, one deploy.
4. **Reconcile** the whole staging output against the manifest (local
   hashing only). This catches files built but not deployed before a crash.
   On the first deploy to a sink (no manifest, or the sink changed), the
   sink is asked what it already holds (`list()`) so a bucket that already
   has the site isn't uploaded again.
5. Start watching.

## Status model

The runtime exposes, per site:

- `state`: `starting | syncing | building | deploying | idle | error`
- last batch: when, how many source changes, outputs written/deleted, uploads, duration
- backlog: queued source events, failed sink operations awaiting retry
- cache: graph node/leaf counts, working-copy size, manifest entry count
- source/sink health: last successful contact, last error

This is what `GET /sites/:id/status` returns; see [CONTROL.md](CONTROL.md).
