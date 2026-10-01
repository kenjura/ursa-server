# Editor

A web UI for changing a site's source files, at `/edit/` on the served site.

**Status:** implemented in 0.2.0 for `fs` sources. Remote sources (S3,
Dropbox, Drive) come with M3.

## Turning it on

```yaml
roles:
  serve: true
  edit: true          # or: ursa-server start --edit

server:
  access: viewer      # who can see the site; the editor always needs editor/admin

auth: …               # docs/AUTH.md
```

- With `auth`, only signed-in users with the **editor** or **admin** role get
  in. Others are sent to sign in, or shown "no access".
- Without `auth`, the editor is allowed only when the server listens on
  localhost (`server.host: 127.0.0.1`), and everyone who can reach it is
  admin. Listening anywhere else without `auth` is a config error.
- Optional: `editor.max-upload-mb` (default 50).

## Getting there

- From any page of the site: the pencil in Ursa's topbar, or "Edit this page"
  in the account panel. Both need Ursa ≥ 0.104.0 and the editor role. They go
  to `/edit/?page=<url>`, which opens the source file the page is built from.
  A generated folder index (no source file) opens the folder instead.
- Directly: `/edit/` (pick a file), or `/edit/?path=rules/combat.md`.

## What it does

- **File tree** of the source (what the build sees: dot-files and Ursa's
  own folders are hidden). New page, new folder, upload, rename/move and
  delete work on the selected folder, or the open file's folder.
- **Text editor** (CodeMirror 6): Markdown, MDX, wikitext (`.txt`, highlighted
  as Markdown), YAML, CSS, JS, JSON and HTML. Ctrl/Cmd+S saves. Leaving with
  unsaved changes asks first.
- **Live preview** beside the editor: the built page, which reloads itself
  when the save has been rebuilt (Ursa's live reload). Toggle it with the eye.
  Hidden on narrow screens.
- **Images and other files:** drop files onto the editor to upload them next
  to the open file and insert a link (`![name](name)` for images). Spaces in
  names become `-`. Opening an image shows it.
- **Conflicts:** every save says which version it started from. If the file
  changed since (another editor, a sync client, a `git pull`), the save is
  refused and a side-by-side merge view opens: your version on the left
  (editable), the saved one on the right, with arrows to copy their changes
  in. Then save the combination, or discard yours.
- **Read-only files:** editors limited by `auth.scopes` see everything but can
  only change what their globs allow (`campaigns/**`); the rest opens
  read-only and is greyed in the tree.

Saves are written atomically (temp file, then rename) straight into the
source folder. The watcher rebuilds the page like any other change, usually
within a second.

**Not included (yet):** history or undo after saving, git commits per save,
WYSIWYG, previewing unsaved text, presence ("someone else is editing").
For history, keep the source in git and commit from time to time; see
QUESTIONS.md for the per-save commit idea.

## Principle: the editor is just another writer

The editor writes **through the source adapter**: for an `fs` source, the
file in the folder. It never writes to the output. The watcher sees the change
like any other and rebuilds, so editing in the browser, in a text editor on
the server, and through a sync client all behave the same. After a save the
editor also tells the site about the change directly, so the rebuild doesn't
wait for the filesystem watcher.

## API

Under `/edit/api`, behind the same role check. Changing requests must send
`X-Ursa-Editor: 1`; a page on another site can't add that header without a
CORS preflight, which this API never grants. Together with `SameSite=Lax`
session cookies, that keeps other sites from making changes as you.

| Method | Path | Does |
|---|---|---|
| GET | `/me` | Site id, current user, their scope globs (or null) |
| GET | `/tree?dir=` | One folder's entries: name, path, type, size, mtime, writable |
| GET | `/file?path=` | `{ path, hash, size, binary, text, url, writable }`; `ETag` is the hash |
| GET | `/raw?path=` | The bytes, with their content type |
| PUT | `/file?path=` | Body = the new content (any type). `If-Match: "<hash>"` to replace, `If-None-Match: *` to create. `412` with `{ current: { hash } }` if the file moved on; `428` if neither header is sent |
| DELETE | `/file?path=` | `If-Match` required for files; folders must be empty |
| POST | `/move` | `{ from, to }`; never overwrites |
| POST | `/mkdir` | `{ path }` |
| GET | `/resolve?page=/url` | `{ path }` for a document, `{ dir }` for a generated index, `{ path: null }` otherwise |

Paths are relative to the source folder. Refused: `..`, backslashes, NUL,
dot-files and dot-folders (which also keeps `.git` and `.env` out of reach),
and anything reached through a symlink pointing outside the source folder.

Every change is logged with who made it: `✏️  ed@example.com saved rules/combat.md`.

## UI delivery

Preact + htm + CodeMirror, bundled by esbuild (`pnpm run build:ui`, also run
by `prepack` and the tests) into `src/editor/ui/dist`, served at `/edit/`.

**Components:** [pure-material-css](https://masquerade-circus.github.io/pure-material-css/)
(Apache-2.0, vendored in `src/editor/ui/vendor/`; it isn't on npm). It styles
plain HTML through data attributes: buttons, dialogs, lists, drawers,
snackbars. Two things to know when changing the UI:

- it sets `html { font-size: 1px }` (its sizes are `16rem` = 16px), so the
  editor's own CSS uses px, never rem/em;
- it styles every `<button>`, `nav`, `section`, and any class containing
  "icon", so the editor's own buttons opt out (`.tool`, `.tree-item`) and its
  icons are `.glyph`.

If the UI ever moves to React, swap it for a Material component set for that
framework (MUI, or Material Web).
