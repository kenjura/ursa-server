# Auth

Who may see the site preview, use the editor, and (remotely) the control API.

**Implemented:** sign-in with any OpenID Connect provider, Auth0 preset
first; signed session cookies; role rules; the site (and its live reload)
gated by `server.access`; the editor gated to editors and admins, with
per-path scopes; a profile page; Ursa's account widget. **Not yet:** the
other providers below, admin sessions for the control API.

## Setting up Auth0

1. In the Auth0 dashboard: **Applications → Create Application → Regular Web
   Application**. (Not "Single Page": the server keeps the client secret.)
2. On its **Settings** tab, copy **Domain**, **Client ID** and **Client
   Secret** into your `.env` as `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
   `AUTH0_CLIENT_SECRET`.
3. Still on Settings, under **Application URIs**, for each address people
   will use (your `auth.base-url`):
   - **Allowed Callback URLs:** `http://localhost:8080/auth/callback`
   - **Allowed Logout URLs:** `http://localhost:8080/`

   Comma-separate several (e.g. add `https://wiki-dev.example.com/auth/callback`
   later). Web Origins and CORS settings aren't needed. Save.
4. **Connections** tab: choose how people sign in (Google, username/password,
   …). If anyone can reach your Auth0 login page, consider **Authentication →
   Database → Disable Sign Ups**. Strangers who sign up still get no access
   (roles decide), but they won't clutter your user list.
5. Make a session secret: `openssl rand -base64 48` → `URSA_SESSION_SECRET`.
6. In the config, `auth.roles` says who gets in (below). Email rules only
   match **verified** emails: Google sign-ins are verified; username/password
   users must click Auth0's verification email first. To admit someone
   regardless, use their Auth0 user id (e.g. `auth0|65f…`, shown in **User
   Management → Users**).

Then `ursa-server start`, open `http://localhost:8080/` (the same host name
as `base-url`; cookies don't carry between `localhost` and `127.0.0.1`), and
you're sent to Auth0. `/auth/me` shows who you're signed in as and your
roles; `/auth/logout` signs out here and at Auth0.

## Mock sign-in for local testing

`ursa-server dev` uses a `mock` provider: its sign-in page asks for a name
and a role (viewer, editor, admin) and nothing else. A name with an `@` is
also treated as a verified email, so `auth.scopes` can be tried too. To use it
from a config file:

```yaml
server: { host: 127.0.0.1 }
auth:
  provider: { type: mock }   # no client id, secret or roles needed
```

Anyone who can reach it can sign in as anyone, so the config refuses it unless
the server listens on loopback (`127.0.0.1`, `::1`, `localhost`) and
`auth.base-url` is a localhost URL. Without `auth.session-secret` it uses a
fixed one, so test sessions survive restarts.

## On the site: the account widget

With Ursa ≥ 0.104.0, pages served by ursa-server show an account button in
the topbar (static copies of the site, e.g. on S3, don't). Its panel shows
who is signed in, with links to the profile page and to sign out. Editors and
admins also get a pencil in the topbar that opens the current page in the
editor. ursa-server turns this on by adding a small JSON block to each page
it serves (`script#ursa-server`; see Ursa's docs/LIBRARY.md).

## Profile page

`/auth/profile` shows your name, email, access level, how long you stay
signed in, and your account id (handy for `auth.roles`). For Auth0
username/password accounts it has **Email me a password reset link**, which
asks Auth0 to send its reset email. That uses the
`Username-Password-Authentication` connection unless
`auth.provider.connection` names another. Names, emails and sign-in methods
are managed in Auth0 itself.

Sign-out at Auth0 uses its OIDC end-session endpoint when the tenant
advertises one, otherwise `/v2/logout`. Both need the Allowed Logout URL.

## Config

```yaml
server:
  access: viewer                  # public | viewer | editor | admin

auth:
  base-url: http://localhost:8080 # default: http://<server.host>:<server.port>
  session-secret: ${URSA_SESSION_SECRET}
  session-days: 14
  provider:
    preset: auth0                 # or: issuer: https://… for any OIDC provider
    domain: ${AUTH0_DOMAIN}
    client-id: ${AUTH0_CLIENT_ID}
    client-secret: ${AUTH0_CLIENT_SECRET}
  roles:
    admin:  ["${SITE_ADMIN_EMAIL}"]
    editor: ["*@example.com"]
    viewer: ["friend@example.com", "google-oauth2|1234567890"]
```

An entry can hold several rules separated by commas or spaces, so a list can
come from one variable: `viewer: ["${WIKI_VIEWERS:-}"]` with
`WIKI_VIEWERS=a@x.com,b@y.com` in `.env`. Useful when the config is in a
public repo.

Rule forms: `"*"` (anyone who signs in), `"*@domain"` (verified email at a
domain), an exact verified email, a provider user id (anything containing
`|`), or `"sub:<id>"`. Roles nest: admin ⊃ editor ⊃ viewer. Someone matching
no rule is refused at sign-in and gets no session. Sessions are stateless
(signed cookies): changing `session-secret` signs everyone out, and role
changes apply at the next sign-in.

The live-reload WebSocket (`/__ursa/ws`) follows `server.access` too: a
browser without a qualifying session can't connect.

**Scopes** limit what an editor may change (admins are never limited):

```yaml
auth:
  scopes:
    friend@example.com: ["campaigns/bertball/**"]
    auth0|65f0c1: ["campaigns/**", "index.md"]
```

`**` matches any number of folders, `*` part of one name. Keys are verified
emails or account ids. An editor without an entry may change everything.

## Requirements

- Support several schemes, none of them mandatory.
- If the source is a bucket, optionally use the cloud's identity (IAM).
- If the source is Dropbox/Drive, optionally use that service's login.
- Ship one bundled scheme that is cheap and easy to set up.
- Something off-the-shelf for everything else.

## Design

### Provider interface

```js
/** @interface AuthProvider */
{
  id,
  registerRoutes(app),          // e.g. /auth/<id>/login, /auth/<id>/callback
  async authenticate(request),  // → Identity | null
}

/** Identity */
{ provider, subject, email?, name?, claims, sourceCredentials? }
```

After login the server issues **its own session** (signed, HTTP-only,
`SameSite=Lax` cookie). Providers only handle the login handshake; the rest of
the server sees one identity type.

### Authorization is separate from authentication

Providers say *who*; the config says *what they may do*:

```yaml
auth:
  roles:
    admin:  ["andrew@kenjura.com"]
    editor: ["*@kenjura.com", "github|12345"]
  scopes:                       # optional per-user path limits for editors
    "friend@example.com": ["campaigns/bertball/**"]
```

Roles: `viewer` (preview only), `editor` (edit API), `admin` (control API).
Matching is on email or `provider|subject`.

## Providers

| Provider | Use | Recommendation |
|---|---|---|
| `none` | Localhost dev. Refuses to start if bound to a non-loopback address. | Default for `--edit` on localhost. |
| `token` | Static bearer tokens / a shared password. For scripts, CI and the CLI. | Always available alongside others. |
| `oidc` | **Generic OpenID Connect**, via `openid-client`. Covers Auth0, Clerk, Cognito, Google, Microsoft, Okta, Keycloak, Authentik, Zitadel… | **The workhorse.** Every hosted auth service speaks OIDC, so one provider plus a preset per vendor covers most needs without vendor SDKs. |
| `dropbox` / `google` | OAuth with the source's own service. | Optional. With **pass-through** on, the user's own token is used for writes (`Identity.sourceCredentials`), so the service's sharing permissions decide who can edit what, and the server needs no write credentials of its own. |
| `aws` (IAM) | Bucket sources. | See below. |
| `passport` | Adapter that wraps any Passport strategy. | Escape hatch for SAML, LDAP, etc. Not the core. |

### Recommendation: OIDC core, Passport as an adapter

Passport is the obvious off-the-shelf choice, but I'd recommend against
building on it:

- Its model is Express middleware with session serialisation baked in, and
  its strategy ecosystem is large but mostly unmaintained.
- Nearly everything worth integrating today is OIDC, so one well-maintained
  OIDC client (`openid-client`) covers more real providers with less code
  and fewer dependencies.
- Wrapping Passport behind the provider interface keeps the long tail
  available without making it the architecture.

### Bundled scheme: Auth0, via the OIDC provider

**Decided:** Auth0 for the first build. The expected setup is editors who sign
in through Auth0 and have no cloud credentials of their own; the server holds
the credentials for the bucket it deploys to.

The bundled scheme is an `oidc` **preset**: you create an application in
the vendor's dashboard and paste three values (see
[Setting up Auth0](#setting-up-auth0)).

**Auth0** because it's standard OIDC (no SDK needed, so it stays a preset, not
a dependency), its free tier comfortably covers a personal or small-team wiki,
and it gives Google/GitHub/email login without configuring each. **Clerk**
is the close alternative with nicer UI components, but its strengths are in
its front-end SDK, which an OIDC-only integration doesn't use. Cognito is
cheapest if you're already all-in on AWS, but it's the least pleasant to set
up. Check current free-tier limits before choosing; they change.

Clerk, Cognito and others remain available as `oidc` presets.

### IAM for bucket sources

"Use IAM" can mean two things, and they differ a lot in effort:

1. **Login via the cloud's identity:** AWS IAM Identity Center or Cognito, both
   of which are OIDC, so this is the `oidc` provider with a preset. Cheap.
2. **Per-user cloud permissions on writes:** the user's own AWS credentials
   (from Identity Center / Cognito identity pool, via
   `AssumeRoleWithWebIdentity`) are used for the `PutObject`, so bucket
   policies decide what each user can edit. More work; same shape as
   Dropbox/Google pass-through (`Identity.sourceCredentials`).

Recommended: (1) in the first auth milestone, (2) later if wanted. Given the
Auth0 decision, (2) is low priority.

## Control API auth (implemented)

- The Unix socket (`control.socket`, mode 0600) is trusted: file permissions
  are the access control.
- Over TCP, if `control.token` is set, **every** request needs
  `Authorization: Bearer <token>` (except `/health`), even from loopback,
  because a reverse proxy on the same machine makes remote requests look
  local.
- Binding to a non-loopback address without a token is a config error.
- Later: an `admin` role session from the editor's auth works too.
