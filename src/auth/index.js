/**
 * Sign-in for the browser-facing parts of the server (the site preview now,
 * the editor later). docs/AUTH.md.
 *
 *   GET /auth/login?returnTo=/path   → the provider's sign-in page
 *   GET /auth/callback               ← the provider sends the browser back here
 *   GET /auth/logout                 → signs out here and at the provider
 *   GET /auth/me                     → { signedIn, name, email, roles }
 *
 * After sign-in the server keeps its own session in a signed cookie;
 * providers are only involved at sign-in and sign-out.
 */

import { sign, verify, parseCookies, cookie } from "./session.js";
import { rolesFor, hasRole } from "./roles.js";
import { createOidcProvider } from "./providers/oidc.js";

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
  provider ??= createOidcProvider(config.provider, { redirectUri: `${baseUrl}/auth/callback` });

  function userOf(req) {
    const s = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret);
    return s ? { sub: s.sub, name: s.name, email: s.email, roles: s.roles } : null;
  }

  /** Only same-site paths: never let returnTo send someone elsewhere. */
  function safeReturnTo(p) {
    return typeof p === "string" && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/\\") ? p : "/";
  }

  function page(res, status, title, body) {
    res.status(status).type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}a{color:#1a5fb4}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`);
  }

  return {
    provider,

    /** Add the /auth routes and attach `req.user` to every request. */
    mount(app) {
      app.use((req, res, next) => {
        req.user = userOf(req);
        next();
      });

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
        const roles = rolesFor(who, config.roles);
        if (roles.length === 0) {
          log(`sign-in refused: ${who.email ?? "(no email)"} [${who.sub}] has no role${who.email && !who.emailVerified ? " (email not verified, so email rules don't apply)" : ""}`);
          res.setHeader("Set-Cookie", clearTx);
          return page(res, 403, "No access", `<p>You signed in as <b>${esc(who.email ?? who.sub)}</b>${who.email && !who.emailVerified ? " (email not verified)" : ""}, which doesn't have access here.</p><p><a href="/auth/logout">Sign out</a></p>`);
        }
        const session = sign({ sub: who.sub, name: who.name, email: who.email, roles, exp: Date.now() + config.sessionDays * 86400_000 }, secret);
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
        res.json(req.user ? { signedIn: true, ...req.user } : { signedIn: false });
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
