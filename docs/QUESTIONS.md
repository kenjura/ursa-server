# Decisions and open questions

## Decided (2026-09-30)

| Question | Decision |
|---|---|
| Change Ursa? | Yes, on a version branch: `version/0.103.0` ([UPSTREAM.md](UPSTREAM.md)). |
| Where does it run? | An always-on machine: home server, EC2, VPS. Infra ships a systemd unit and a Dockerfile; no serverless. |
| Rsync sink? | Yes, built. |
| Primary deployment | Server holds credentials and pushes to an S3 bucket behind CloudFront; editors sign in with Auth0 and have no AWS credentials of their own. |
| Bundled auth | Auth0, as an `oidc` preset. |
| Passport | Adapter only; OIDC is the core. |
| License, git identity | Match Ursa: ISC; Andrew London. |
| Ursa dependency | npm, `^0.103.0`. For development, `pnpm run link-ursa` points it at `../ursa`. |
| Editor components | [pure-material-css](https://masquerade-circus.github.io/pure-material-css/) (the UI isn't React); a framework's Material set if that changes. |
| Language | Plain ESM JavaScript with JSDoc, matching Ursa. |
| HTTP framework | Express (Ursa's dev server is Express). |
| Editor (0.2.0) | Plain-text CodeMirror with live preview; saves write the file only (no git); conflicts resolved in a merge view. |
| Ursa account widget | Hidden on static sites; shown when ursa-server serves the page (it injects a config block), so S3 copies never show it. |

## Open

1. **One site or many per server?** Supported (sites build one after
   another), but is it needed? If not, the config could be simplified.

2. **Dropbox / Google Drive as sinks?** Neither hosts websites, so only as
   backups. *Recommendation:* no.

3. **WYSIWYG for `.md`?** The editor is plain text with live preview. A
   WYSIWYG mode could come later for Markdown only (MDX and wikitext don't
   round-trip well).

4. **Git commits per save?** The wiki's source is a git repo. Options: a
   commit per save (author = the signed-in user), a commit every N minutes,
   or leave it to you. Would give history and undo in the editor.
   *Recommendation:* commit per save, behind `editor.git: true`, pushed only
   if you ask for it.

5. **Google Docs in a Drive source:** ignore, or export to Markdown?
   *Recommendation:* ignore.

6. **Who edits?** *Assumed:* a few trusted people, optional per-folder scopes,
   user management in Auth0 rather than in the app.

7. **Ursa build stamp** (UPSTREAM.md #6): worth adding an option so forced
   rebuilds don't re-upload every page?

8. **Publishing ursa-server.** Ursa 0.103.0 is published. ursa-server
   publishes from `.github/workflows/npm-publish.yml` when a `v*` tag matching
   `package.json` is pushed on `main`; it needs an `NPM_TOKEN` secret.
