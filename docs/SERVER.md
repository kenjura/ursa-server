# Server

Serves the built site. Deliberately simple: an Ursa site is static files, and
anything (`npx http-server`, nginx, a CDN in front of a bucket) can serve it.

## Purpose

- **Development and previews.** Watching a bucket or Dropbox and seeing the
  result locally with live reload.
- **Editor preview.** The editor shows rendered pages from this server.
- **Small self-hosted sites,** where one box does everything. Fine, but not
  the primary target.

For production, publish to a sink and let a CDN serve it.

## What it serves

The **staging output** (the local build), not the sink. That means:

- it's up to date as soon as the build finishes, before the deploy does;
- it works with sinks that can't be read back (rsync to a server you can't
  reach from here).

## Behaviour

- Ursa's URL resolution (`/foo` → `foo.html` or `foo/index.html`; see
  `ursa/src/helper/build/precedence.js` `resolveUrlToOutput`), so URLs match
  what the sink serves.
- **Live reload over WebSocket**, using Ursa's existing protocol: the page
  reports the URL it's viewing, the runtime passes viewed URLs to `runPass()`
  as `viewedOutputs` so those pages build first, and the client reloads when
  its page changes.
- `Cache-Control: no-store` (as Ursa's serve does).
- Optionally behind sign-in: `server.access: viewer` (or editor/admin) with
  an `auth` section. See [AUTH.md](AUTH.md).

## Implementation: Ursa's own server

Ursa 0.103.0 exports `createDevServer` from `@kenjura/ursa/build` (Express +
compression + live reload). ursa-server creates one over the served site's
staging output and routes that site's passes through it, so browsers viewing
a page get it rebuilt first and reload when it changes. The live-reload
WebSocket is at `/__ursa/ws` on the same port, so one reverse-proxy rule
covers both.

Config: `roles.serve: true` (or `--serve`), `server.host`, `server.port`, and
`server.site` to pick which site to serve (default: the first).

Mounted on the same server, ahead of the site: `/auth/*` (sign-in, profile)
when `auth` is set, and the editor at `/edit/` when `roles.edit` is on. Pages
get a `script#ursa-server` block (Ursa's `headHtml` option) telling Ursa's
account widget where those are; the live-reload WebSocket checks the session
(Ursa's `authorizeUpgrade` option).
