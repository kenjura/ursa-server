# Editor

A web UI for changing a site's source files without a local checkout or a
sync client.

## Principle: the editor is just another writer

The editor writes **through the source adapter**: a save to an S3-sourced site
is a `PutObject` to the source bucket; to a Dropbox-sourced site, a Dropbox
upload. It never writes to the working copy or the output directly. The
watcher then sees the change like any other and rebuilds.

Consequences:

- one path from "file changed" to "site updated", whoever changed it;
- editing from the UI and from a Dropbox desktop client at the same time
  behaves the same as two people editing in Dropbox;
- the editor works whether or not the watcher is running in the same process.

The cost is a round trip (write → notification → sync) before the preview
updates. To hide it, after a successful write the editor tells the runtime
"this path changed" directly, so the batch starts without waiting for the
source's notification. The notification still arrives later and is a no-op
(hash unchanged).

## Features

**MVP**

- File tree of the source (from the working copy's listing).
- Text editor (CodeMirror 6) for `.md`, `.mdx`, `.txt` (wikitext), `.yml`,
  `.css`, `.js`, `.json`, with Markdown and YAML frontmatter highlighting.
- Side-by-side preview: an iframe on the dev server's rendered page, which
  live-reloads after save.
- Create, rename, delete files and folders.
- Upload images and other assets (drag and drop into the editor inserts a
  link).
- Conflict detection: every save carries the hash the editor loaded
  (`If-Match`). If the file changed underneath, the save is rejected and the
  UI offers a three-way merge (Ursa already depends on `node-diff3`).

**Later**

- Draft preview: render unsaved text without writing it (needs an Ursa entry
  point that renders one document from a string with the site's context).
- Frontmatter form view.
- Link autocomplete from Ursa's `validPaths` / search index.
- Per-save commit messages and history, if the source is a git repo (see
  QUESTIONS.md).
- Presence ("someone else has this file open").

## API

Under `/edit/api`, all requiring an authenticated user with the `editor` role
(see [AUTH.md](AUTH.md)), optionally limited to path scopes.

| Method | Path | Does |
|---|---|---|
| GET | `/tree?path=` | Listing with hashes |
| GET | `/file?path=` | Content + `ETag` (hash) |
| PUT | `/file?path=` | Write. `If-Match` required for existing files; `If-None-Match: *` for create. `409` on mismatch with the current content in the body. |
| DELETE | `/file?path=` | Delete, `If-Match` required |
| POST | `/move` | `{ from, to }` |
| POST | `/upload` | Multipart asset upload |
| GET | `/me` | Current identity and roles |

Writes refuse paths under `.ursa/`, outside the source root, or matching the
deny-list Ursa ignores (they'd be invisible to the build anyway).

## UI delivery

Static files built by esbuild into `src/editor/ui/dist`, served at `/edit/`
(mounted on the dev server through `createDevServer({ mount })`). No
server-side rendering; the UI talks to the API only.

**Components:** [pure-material-css](https://masquerade-circus.github.io/pure-material-css/).
The UI is Preact and CodeMirror, not React, and pure-material-css is plain
CSS on native elements (`<button class="pure-material-button-contained">`,
checkboxes, switches, text fields, progress), so it needs no framework
bindings and adds no JavaScript. It covers form controls rather than
composite widgets, so the file tree, dialogs, menus and tabs are written here
in the same style (to be confirmed against its current component list when M4
starts). If the UI ever moves to React, swap it for a
Material component set for that framework (MUI, or Material Web).
