# Roadmap

Ordered so each milestone is usable on its own.

## M0: Scaffold ✅

Docs, layout, infra skeleton.

## M1: Local loop ✅

- Ursa 0.103.0: written/deleted paths, `cacheDir`, `invalidate`, exported
  build and dev server ([UPSTREAM.md](UPSTREAM.md)).
- Config loading and validation.
- Site runtime with `fs` source and `fs` sink; the build cache lives in the
  state dir, not the source.
- Dev server with live reload (Ursa's).
- Control API (TCP + Unix socket, token auth) and CLI: status, rebuild,
  invalidate, sync, pause/resume, logs, events.

## M2: Remote sinks ✅

- Deploy manifest, pending/retry, startup and post-rebuild reconciliation.
- `s3` sink with CloudFront invalidation (works with R2/B2/MinIO).
- `rsync` sink (retires `ursa/deploy.sh`).

**Not yet verified against real AWS or a real SSH host:** the S3 sink is
tested with a stubbed client and rsync against a local folder. The first real
deploy is the next thing to try; `infra/local` has MinIO for a closer test.

## M3: Remote sources

- Working-copy sync and source cursors.
- `s3` source: polling, then SQS notifications.
- `dropbox` source.
- `gdrive` source.
- Push template-reconciliation writes back to the source (UPSTREAM.md #8).

## M4: Editor ✅ (0.2.0)

- Edit API with conditional writes, path safety, per-user scopes, CSRF guard.
- CodeMirror + Preact UI styled with pure-material-css: tree, editor, live
  preview, uploads by drag and drop, rename/move/delete, merge view for
  conflicts.
- Ursa 0.104.0: the account widget and edit pencil on pages ursa-server
  serves; live reload behind sign-in.
- Next for the editor: per-save git commits (QUESTIONS.md), previewing
  unsaved text (UPSTREAM.md #9), editing remote sources (with M3).

## M5: Auth (mostly done)

- ✅ Session layer (signed cookies), role rules.
- ✅ `oidc` provider + **Auth0 preset**; gates the dev server (`server.access`).
- ✅ Path scopes enforced by the editor; live reload gated (Ursa 0.104.0).
- ✅ Profile page, Auth0 password reset, Ursa's account widget.
- Admin sessions for the control API.
- Dropbox / Google login with optional pass-through.
- AWS Identity Center / Cognito presets.
- Passport adapter.

## M6: Production hardening

- State snapshot to a bucket for hosts without a persistent disk.
- Metrics (Prometheus endpoint), structured logs.
- Terraform for the AWS side (bucket, CloudFront, IAM), if wanted.
