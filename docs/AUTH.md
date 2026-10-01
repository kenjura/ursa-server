# Auth

Who may use the editor (and, remotely, the control API).

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
  providers: [oidc]
  roles:
    admin:  ["andrew@kenjura.com"]
    editor: ["*@kenjura.com", "github|12345"]
  scopes:                       # optional per-user path limits
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

### Bundled scheme: Auth0 (recommended), via the OIDC provider

The bundled scheme is an `oidc` **preset**: the user creates an application in
the vendor's dashboard and pastes three values:

```yaml
auth:
  providers:
    - preset: auth0
      domain: kenjura.us.auth0.com
      clientId: ...
      clientSecret: ${AUTH0_CLIENT_SECRET}
```

**Auth0** because it's standard OIDC (no SDK needed, so it stays a preset, not
a dependency), its free tier comfortably covers a personal or small-team wiki,
and it gives Google/GitHub/email login without configuring each. **Clerk**
is the close alternative with nicer UI components, but its strengths are in
its front-end SDK, which an OIDC-only integration doesn't use. Cognito is
cheapest if you're already all-in on AWS, but it's the least pleasant to set
up. Check current free-tier limits before choosing; they change.

This is an open question; see QUESTIONS.md.

### IAM for bucket sources

"Use IAM" can mean two things, and they differ a lot in effort:

1. **Login via the cloud's identity:** AWS IAM Identity Center or Cognito, both
   of which are OIDC, so this is the `oidc` provider with a preset. Cheap.
2. **Per-user cloud permissions on writes:** the user's own AWS credentials
   (from Identity Center / Cognito identity pool, via
   `AssumeRoleWithWebIdentity`) are used for the `PutObject`, so bucket
   policies decide what each user can edit. More work; same shape as
   Dropbox/Google pass-through (`Identity.sourceCredentials`).

Recommended: (1) in the first auth milestone, (2) later if wanted.

## Control API auth

Loopback/socket access needs nothing. Remote access needs a `token` or an
`admin` role session. The CLI uses tokens.
