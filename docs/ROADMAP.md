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

## M4: Editor

- Edit API with conditional writes; `none` + `token` auth.
- CodeMirror + Preact UI styled with pure-material-css: tree, editor, preview
  iframe, upload, conflicts.

## M5: Auth

- Session layer, role/scope config.
- `oidc` provider + **Auth0 preset** (the bundled scheme; first).
- Dropbox / Google login with optional pass-through.
- AWS Identity Center / Cognito presets.
- Passport adapter.

## M6: Production hardening

- State snapshot to a bucket for hosts without a persistent disk.
- Metrics (Prometheus endpoint), structured logs.
- Terraform for the AWS side (bucket, CloudFront, IAM), if wanted.
