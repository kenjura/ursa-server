# Changes needed in Ursa

ursa-server wraps Ursa's incremental build. A few small changes in Ursa make
that clean instead of fragile. All are additive; `ursa generate` / `serve`
behave the same.

## 1. Report written and deleted paths (required)

`runPass()` returns counts (`written`, `deleted`) but not paths. The delta
deploy needs the paths.

- `createBuild({ onOutputWrite(rel), onOutputDelete(rel) })`, called from the
  existing `onWrite` hook in `pass.js` and from `deleteOutputs`, **or**
- `runPass()` returns `{ written: string[], deleted: string[] }` alongside the
  counts.

Fallback without it: hash the whole output directory after every pass and
diff against the manifest. Correct, but O(site) per edit.

## 2. Export the build and server entry points (required)

`createBuild` (in `src/helper/build/pass.js`) and `serveFiles` / the
live-reload notifier (in `src/serve.js`) aren't exported from
`lib/index.js`. Importing internal paths would break on any refactor.
Proposal: `import { createBuild, createDevServer } from "@kenjura/ursa/build"`
with an `exports` map in `package.json`.

## 3. Cache directory outside the docroot (recommended)

The graph lives in `<docroot>/.ursa/` and `.ursa.json`. With a remote source
that's in the working copy, which is fine. But with a **local-FS source**, it
means the server writes into the user's folder (a Dropbox-synced folder would
upload it), and a read-only source can't be built at all. Proposal: a
`cacheDir` option on `createBuild`, defaulting to today's location. (Graph leaf
ids are already docroot-relative, so moving the cache is cheap.)

## 4. Public `invalidatePath` / `rescan` (nice to have)

Today `serve.js` reaches into the graph to mark paths stale. A documented
`build.invalidate(paths)` and `build.runPass({ rescan: true })` (the latter
already exists) would be the contract ursa-server relies on.

## 5. Render one document from a string (later, for draft preview)

`renderDraft(sourceRel, text)` → HTML using the site's current graph
(templates, menus, bundles), without writing anything. Only needed for the
editor's unsaved-preview feature.

## 6. Multiple builds per process (later, for multi-site)

Confirm or remove module-level state (`parserPool`, profiler singleton) so two
`createBuild()` instances don't interfere. Otherwise ursa-server runs one
worker thread per site.
