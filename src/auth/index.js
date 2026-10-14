/**
 * Sign-in for the browser-facing parts of the server (the site preview now,
 * the editor later). docs/AUTH.md.
 *
 *   GET /auth/login?returnTo=/path   → the provider's sign-in page
 *   GET /auth/callback               ← the provider sends the browser back here
 *   GET /auth/logout                 → signs out here and at the provider
 *   GET /auth/me                     → { signedIn, name, email, roles }
 *   GET /auth/profile                → who you are, your access, sign out,
 *                                      and (Auth0 passwords) a reset email
 *
 * After sign-in the server keeps its own session in a signed cookie;
 * providers are only involved at sign-in and sign-out.
 */

import { sign, verify, parseCookies, cookie } from "./session.js";
import { rolesFor, hasRole } from "./roles.js";
import { createOidcProvider } from "./providers/oidc.js";
import { createMockProvider } from "./providers/mock.js";

const SESSION_COOKIE = "ursa_session";
const TX_COOKIE = "ursa_auth_tx";
const TX_SECONDS = 10 * 60;

/**
 * @param {object} config - normalised `auth` block
 * @param {{ log?: (m: string) => void, provider?: object }} [opts] - provider: injected (tests)
 */
export function createAuth(config, { log = console.log, provider = null } = {}) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const secure = baseUrl.startsWith("https:");
  const baseHost = new URL(baseUrl).host;
  const secret = config.sessionSecret;
  provider ??= config.provider.type === "mock"
    ? createMockProvider()
    : createOidcProvider(config.provider, { redirectUri: `${baseUrl}/auth/callback` });

  function userOf(req) {
    const s = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret);
    return s ? { sub: s.sub, name: s.name, email: s.email, emailVerified: s.emailVerified ?? null, roles: s.roles, exp: s.exp } : null;
  }

  /** A same-site form POST: SameSite=Lax keeps cross-site cookies off, this keeps cross-site forms out. */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    return !origin || origin === baseUrl || origin === new URL(baseUrl).origin;
  }

  /** Only same-site paths: never let returnTo send someone elsewhere. */
  function safeReturnTo(p) {
    return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : "/";
  }

  function page(res, status, title, body) {
    res.status(status).type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1rem;color:#222;background:#fff}
a{color:#1a5fb4}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{color:#666}dd{margin:0}
button{font:inherit;padding:.4rem 1rem;border:1px solid #bbb;border-radius:4px;background:#f6f6f6;cursor:pointer}
input,select{font:inherit;padding:.3rem .5rem;border:1px solid #bbb;border-radius:4px;background:#fff;color:inherit}
.note{padding:.5rem .75rem;background:#eef6ee;border-radius:4px}.note.error{background:#fbeaea}.hint{color:#666;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#1c1c1c;color:#ddd}a{color:#8ab4f8}dt,.hint{color:#999}button,input,select{background:#2a2a2a;color:#ddd;border-color:#444}.note{background:#20321f}.note.error{background:#3a2020}}
</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`);
  }

  return {
    provider,

    /** The signed-in user for a raw request (e.g. a WebSocket upgrade), or null. */
    userOf,

    /** Add the /auth routes and attach `req.user` to every request. */
    mount(app) {
      app.use((req, res, next) => {
        req.user = userOf(req);
        next();
      });

      // Providers with pages of their own (mock's sign-in form)
      provider.mount?.(app, { page, esc });

      app.get("/auth/login", async (req, res) => {
        // Cookies belong to a host: sign in on the one the provider returns to
        if (req.headers.host && req.headers.host !== baseHost) {
          return res.redirect(302, `${baseUrl}/auth/login?returnTo=${encodeURIComponent(safeReturnTo(req.query.returnTo))}`);
        }
        try {
          const { url, checks } = await provider.begin();
          const tx = sign({ ...checks, returnTo: safeReturnTo(req.query.returnTo), exp: Date.now() + TX_SECONDS * 1000 }, secret);
          res.setHeader("Set-Cookie", cookie(TX_COOKIE, tx, { maxAge: TX_SECONDS, secure, path: "/auth" }));
          res.redirect(302, url);
        } catch (e) {
          log(`sign-in failed to start: ${e.message}`);
          page(res, 502, "Sign-in is unavailable", `<p>${esc(e.message)}</p>`);
        }
      });

      app.get("/auth/callback", async (req, res) => {
        const tx = verify(parseCookies(req.headers.cookie)[TX_COOKIE], secret);
        const clearTx = cookie(TX_COOKIE, "", { maxAge: 0, secure, path: "/auth" });
        if (!tx) {
          res.setHeader("Set-Cookie", clearTx);
          return page(res, 400, "Sign-in expired", `<p>That sign-in took too long or came from another browser. <a href="/auth/login">Try again</a>.</p>`);
        }
        if (req.query.error) {
          res.setHeader("Set-Cookie", clearTx);
          return page(res, 403, "Not signed in", `<p>${esc(req.query.error_description ?? req.query.error)}</p><p><a href="/auth/login">Try again</a></p>`);
        }
        let who;
        try {
          who = await provider.finish(baseUrl + req.originalUrl, tx);
        } catch (e) {
          log(`sign-in failed: ${e.message}`);
          res.setHeader("Set-Cookie", clearTx);
          return page(res, 400, "Sign-in failed", `<p>${esc(e.message)}</p><p><a href="/auth/login">Try again</a></p>`);
        }
        // The mock provider says which role was picked; real ones are looked up in auth.roles
        const roles = who.roles ?? rolesFor(who, config.roles);
        if (roles.length === 0) {
          log(`sign-in refused: ${who.email ?? "(no email)"} [${who.sub}] has no role${who.email && !who.emailVerified ? " (email not verified, so email rules don't apply)" : ""}`);
          res.setHeader("Set-Cookie", clearTx);
          return page(res, 403, "No access", `<p>You signed in as <b>${esc(who.email ?? who.sub)}</b>${who.email && !who.emailVerified ? " (email not verified)" : ""}, which doesn't have access here.</p><p><a href="/auth/logout">Sign out</a></p>`);
        }
        const session = sign({ sub: who.sub, name: who.name, email: who.email, emailVerified: who.emailVerified, roles, exp: Date.now() + config.sessionDays * 86400_000 }, secret);
        res.setHeader("Set-Cookie", [clearTx, cookie(SESSION_COOKIE, session, { maxAge: config.sessionDays * 86400, secure })]);
        log(`signed in: ${who.email ?? who.sub} (${roles.at(-1)})`);
        res.redirect(302, tx.returnTo);
      });

      app.get("/auth/logout", async (req, res) => {
        res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0, secure }));
        let target = `${baseUrl}/`;
        try {
          target = await provider.logoutUrl(target);
        } catch {
          // provider unreachable: signed out here, which is what matters
        }
        res.redirect(302, target);
      });

      app.get("/auth/me", (req, res) => {
        if (!req.user) return res.json({ signedIn: false });
        const { sub, name, email, roles } = req.user;
        res.json({ signedIn: true, sub, name, email, roles });
      });

      app.get("/auth/profile", (req, res) => {
        if (!req.user) return res.redirect(302, `/auth/login?returnTo=${encodeURIComponent("/auth/profile")}`);
        const u = req.user;
        const role = u.roles.at(-1) ?? "none";
        const canReset = Boolean(provider.passwordReset) && u.sub.startsWith("auth0|") && u.email;
        const note = req.query.reset === "sent" ? `<p class="note">Check ${esc(u.email)} for a link to set a new password.</p>`
          : req.query.reset === "failed" ? `<p class="note error">Couldn't send the reset email. Try again later.</p>` : "";
        page(res, 200, "Your account", `
<dl>
  <dt>Name</dt><dd>${esc(u.name ?? "")}</dd>
  <dt>Email</dt><dd>${esc(u.email ?? "(none)")}${u.email && u.emailVerified === false ? " <small>(not verified)</small>" : ""}</dd>
  <dt>Access</dt><dd>${esc(role)}</dd>
  <dt>Signed in until</dt><dd>${esc(new Date(u.exp).toUTCString())}</dd>
  <dt>Account id</dt><dd><code>${esc(u.sub)}</code></dd>
</dl>
${note}
<p>
  <a href="/">Back to the site</a>
  ${config.editUrl && (u.roles.includes("editor") || u.roles.includes("admin")) ? ` · <a href="${esc(config.editUrl)}">Edit the site</a>` : ""}
  · <a href="/auth/logout">Sign out</a>
</p>
${canReset ? `<form method="post" action="/auth/profile/password-reset"><button>Email me a password reset link</button></form>` : ""}
${config.provider.type === "mock"
  ? `<p class="hint">Test sign-in: sign out and in again to be someone else.</p>`
  : `<p class="hint">Your name, email and sign-in method are managed by ${esc(config.provider.preset === "auth0" ? "Auth0" : "your sign-in provider")}; changes there apply the next time you sign in.</p>`}`);
      });

      app.post("/auth/profile/password-reset", async (req, res) => {
        if (!req.user || !sameOrigin(req)) return res.status(403).end();
        try {
          await provider.passwordReset(req.user.email);
          log(`password reset email sent to ${req.user.email}`);
          res.redirect(303, "/auth/profile?reset=sent");
        } catch (e) {
          log(`password reset for ${req.user.email} failed: ${e.message}`);
          res.redirect(303, "/auth/profile?reset=failed");
        }
      });
    },

    /**
     * Middleware: require `role` (or let everyone through for "public").
     * Browsers asking for a page are sent to sign in; other requests get 401.
     */
    requireRole(role) {
      return (req, res, next) => {
        if (hasRole(req.user?.roles, role)) return next();
        if (req.user) return page(res, 403, "No access", `<p>Signed in as <b>${esc(req.user.email ?? req.user.sub)}</b>, which can't see this. <a href="/auth/logout">Sign out</a></p>`);
        const wantsPage = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
        if (wantsPage) return res.redirect(302, `/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
        res.status(401).json({ error: "sign in required" });
      };
    },
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
