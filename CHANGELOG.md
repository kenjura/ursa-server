# 0.2.0
2026-10-01

The editor ([docs/EDITOR.md](docs/EDITOR.md)). Requires `@kenjura/ursa` 0.104.0.

- **Edit the site in the browser** at `/edit/` (`roles.edit: true` or `--edit`): file tree, CodeMirror editor with live preview, new page/folder, upload by drag and drop, rename/move, delete. Ctrl/Cmd+S saves straight into the source folder and the page rebuilds within a second.
- **No lost work:** every save names the version it started from. If someone changed the file meanwhile, a side-by-side merge view opens instead of overwriting.
- **Who may edit:** the `editor` and `admin` roles. `auth.scopes` limits an editor to some paths (`campaigns/**`); the rest is read-only for them. Without `auth`, the editor only runs on localhost.
- **On the site:** with Ursa 0.104.0, pages show an account button (who's signed in, profile, sign out) and, for editors, a pencil that opens the page in the editor.
- **Profile page** at `/auth/profile`, with an Auth0 password-reset email for username/password accounts (`auth.provider.connection` to name another connection).
- **Live reload is behind sign-in** like the rest of the site.
- Sign-in refusals in the log say why (unverified email) and give the account id.

# 0.1.0
2026-10-01

First release: watch a local folder, rebuild incrementally with Ursa, deploy changed files to a folder, S3 (+ CloudFront invalidation) or rsync; a control API and CLI; Auth0/OIDC sign-in for the served site.
