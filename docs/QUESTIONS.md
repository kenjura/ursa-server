# Open questions

Each has a recommendation; the docs are written assuming it. Answer, or
accept the default.

## Scope and deployment

1. **Where will this run?** An always-on VM (like the box `ursa/deploy.sh`
   targets), a container platform (Fly, ECS/Fargate, Cloud Run), or
   serverless?
   *Recommendation:* always-on container or VM with a persistent volume. The
   watchers long-poll and the cache wants a disk; serverless fights both.
   This decides what goes in `infra/`.

2. **One site or many per server?**
   *Recommendation:* config is plural from day one, MVP runs one.

3. **Are Dropbox / Google Drive needed as *sinks*?** Neither can host a
   website, so they'd only be backups/exports.
   *Recommendation:* sources only for now; `rsync` and `s3` as the remote
   sinks.

## Ursa

4. **OK to make the changes in [UPSTREAM.md](UPSTREAM.md) to Ursa?** Items 1-2
   are needed for a clean M1; the alternative is importing Ursa's internal
   files, which breaks on any refactor.
   *Recommendation:* yes, as a minor Ursa release before M1.

5. **How should ursa-server depend on Ursa:** the published
   `@kenjura/ursa` from npm, or a local link while both change together?
   *Recommendation:* `file:../ursa` link during M1-M2, npm semver range after.

## Editor

6. **Plain-text editor, or WYSIWYG?** MDX and wikitext make WYSIWYG hard to
   do faithfully.
   *Recommendation:* CodeMirror source editor with live preview. Revisit
   WYSIWYG for `.md` only, later.

7. **Git?** If a source is a git repo (a local folder, or a mirror), should
   editor saves become commits, and should the editor show history?
   *Recommendation:* not in MVP; design the write path so a `git` source
   adapter (commit on write, pull on watch) can be added as a source type.

8. **Google Docs in a Drive source:** ignore native Docs, or export them
   to Markdown?
   *Recommendation:* ignore in MVP (only real files are sources).

9. **Who edits?** Just you, a few trusted people, or a broader group needing
   per-folder permissions?
   *Recommendation:* design for a few trusted people with optional path
   scopes (already in [AUTH.md](AUTH.md)); no in-app user management.

## Auth

10. **Bundled scheme: Auth0 or Clerk** (or something else)?
    *Recommendation:* Auth0 through a generic OIDC provider; see
    [AUTH.md](AUTH.md#bundled-scheme-auth0-recommended-via-the-oidc-provider).

11. **Passport:** core, or adapter only?
    *Recommendation:* adapter only; OIDC is the core.

## Implementation

12. **JavaScript or TypeScript?**
    *Recommendation:* plain ESM JavaScript with JSDoc, matching Ursa. The
    scaffold is written that way.

13. **License?** Ursa is ISC. *Recommendation:* ISC. Scaffold uses it.
