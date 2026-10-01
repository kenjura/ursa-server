# Roadmap

Ordered so each milestone is usable on its own.

## M0: Scaffold (this commit)

Docs, directory layout, stub modules, infra skeleton.

## M1: Local loop

- Ursa upstream changes 1 and 2 ([UPSTREAM.md](UPSTREAM.md)).
- Config loading and validation.
- Site runtime with `fs` source and `fs` sink: effectively `ursa serve`
  driven as a library.
- Built-in server with live reload (reusing Ursa's).
- Control API: `status`, `rebuild`, `invalidate`, `health`; CLI client.

**Done when:** `ursa-server start` on a local folder behaves like
`ursa serve`, and `ursa-server status` / `rebuild` work against it.

## M2: Remote sinks

- Deploy manifest and reconciliation.
- `s3` sink (with MinIO in `infra/local` for tests), CloudFront invalidation.
- `rsync` sink (retires `ursa/deploy.sh`).

**Done when:** edit locally, site appears in a bucket, and a forced rebuild
uploads only files whose bytes changed.

## M3: Remote sources

- Working-copy sync and source cursors.
- `s3` source: polling, then SQS notifications.
- `dropbox` source.
- `gdrive` source.
- Ursa upstream change 3 (cache dir).

## M4: Editor

- Edit API with conditional writes; `none` + `token` auth.
- CodeMirror UI: tree, editor, preview iframe, upload, conflicts.

## M5: Auth

- Session layer, role/scope config.
- `oidc` provider + Auth0 preset (the bundled scheme).
- Dropbox / Google login with optional pass-through.
- AWS Identity Center / Cognito presets.
- Passport adapter.

## M6: Production hardening

- Terraform reference deployment ([infra/terraform](../infra/terraform)).
- State snapshot to bucket for ephemeral hosts.
- Multi-site.
- Metrics (Prometheus endpoint), structured logs.
