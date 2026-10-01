# Changes in Ursa

ursa-server wraps Ursa's incremental build. These are the changes in Ursa
that make that clean.

## Done in Ursa 0.103.0 (branch `version/0.103.0`)

ursa-server requires `@kenjura/ursa` ≥ 0.103.0. All of these are additive
except the hot-reload change, which is internal to `ursa serve`. See Ursa's
`docs/LIBRARY.md`.

1. **Written and deleted paths.** `createBuild({ onOutputWrite, onOutputDelete })`,
   and `writtenPaths` / `deletedPaths` in each pass's summary.
2. **Public entry point.** `@kenjura/ursa/build` exports `createBuild`,
   `createDevServer`, `createIgnoreFilter`, `resolveUrlToOutput`,
   `getUrsaVersion` (with an `exports` map that keeps every old path importable).
3. **`cacheDir`.** Graph, cache stamp, document-template bases and build id
   can live outside the docroot. An unstamped, non-empty `cacheDir` is refused
   rather than cleared.
4. **`build.invalidate(paths)`**, the watcher logic `ursa serve` used
   internally (directories and vanished paths rescan their subtree).
5. **`createDevServer`**: `ursa serve`'s HTTP + live-reload server as a
   module, with a `mount(app)` hook for extra routes. Its WebSocket moved from
   port+1 to `/__ursa/ws` on the same port, so it works behind a proxy.

## Done in Ursa 0.104.0 (branch `version/0.104.0`)

ursa-server 0.2.0 requires `@kenjura/ursa` ≥ 0.104.0.

- **Account widget:** hidden unless the page carries a `script#ursa-server`
  block; then sign in/out, profile and an edit pencil for editors.
- **`createDevServer({ headHtml, authorizeUpgrade })`:** add that block to
  served pages; refuse live-reload sockets without a session.
- **`outputPathFor`** exported.

## Still wanted

6. **Optional build stamp.** Every page's footer carries the build number and
   time, so a clean rebuild changes every page's bytes and ursa-server has to
   re-upload them all (and invalidate CloudFront `/*`). An option to omit the
   stamp (or to keep the previous build's stamp for pages whose other content
   didn't change) would make a forced rebuild deploy almost nothing.
7. **Clean-build deletions.** `clean: true` empties the output without
   reporting each file. ursa-server compensates by reconciling against its
   manifest after a rebuild; reporting them would make that unnecessary.
8. **Template reconciliation writes to the docroot.** Document-template
   reconciliation (`_templates/`) rewrites documents in the source. For
   remote sources (M3), those writes land in the working copy and must be
   pushed back to the source; an `onSourceWrite(path)` hook would let
   ursa-server do that.
9. **Render a draft** (`renderDraft(sourceRel, text)` → HTML without writing),
   for the editor's unsaved preview (M4+).
10. **Parallel builds per process.** Confirm or remove module-level state
    (parser pool, profiler) so two builds can run at once. Today sites in one
    process build one after another.

## Baseline note

`src/helper/build/__test__/graph.test.js` fails 3–5 tests on `main` as well,
varying run to run: they write same-sized content within the filesystem's
mtime resolution, so the size+mtime fast path sees no change. Not caused by
0.103.0.
