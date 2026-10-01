# Auth providers

Implemented: `oidc.js` (generic OpenID Connect, with the `auth0` preset that
is the bundled scheme, plus `google` and `cognito`).

The other files are placeholders for providers in docs/AUTH.md:
`token` (static bearer tokens), `dropbox` / `google` with source pass-through,
`aws` (per-user IAM), and a `passport` adapter.
