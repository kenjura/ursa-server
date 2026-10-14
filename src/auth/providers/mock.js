/**
 * `mock` provider, for trying a site locally (`ursa-server dev`): its sign-in
 * page asks for a name and a role, and no password. Anyone who can reach it
 * can be anyone, so the config only allows it on a loopback server.
 * docs/AUTH.md.
 *
 *   GET /auth/mock?state=…   the sign-in form; it submits to /auth/callback
 */

import { randomBytes } from "crypto";
import { ROLES } from "../roles.js";

export function createMockProvider() {
  return {
    id: "mock",

    async begin() {
      const state = randomBytes(16).toString("base64url");
      return { url: `/auth/mock?state=${state}`, checks: { state } };
    },

    /** The callback carries what the form asked for. A name with an @ is also a verified email. */
    async finish(callbackUrl, checks) {
      const q = new URL(callbackUrl).searchParams;
      if (q.get("state") !== checks.state) throw new Error("this sign-in form is out of date");
      const name = (q.get("name") ?? "").trim();
      if (!name) throw new Error("give a name");
      const role = q.get("role");
      if (!ROLES.includes(role)) throw new Error(`no role "${role}"`);
      const email = name.includes("@") ? name.toLowerCase() : null;
      return {
        sub: `mock|${name}`,
        name,
        email,
        emailVerified: Boolean(email),
        // The role is chosen, not looked up in auth.roles
        roles: ROLES.slice(0, ROLES.indexOf(role) + 1),
      };
    },

    passwordReset: null,

    async logoutUrl(returnTo) {
      return returnTo;
    },

    /** The sign-in form. */
    mount(app, { page, esc }) {
      app.get("/auth/mock", (req, res) => {
        const state = typeof req.query.state === "string" ? req.query.state : "";
        if (!state) return res.redirect(302, "/auth/login");
        page(res, 200, "Sign in (testing)", `
<p class="hint">This server is for local testing: pick any name and role, no password.</p>
<form method="get" action="/auth/callback">
  <input type="hidden" name="state" value="${esc(state)}">
  <dl>
    <dt><label for="name">Name</label></dt>
    <dd><input id="name" name="name" required autofocus autocomplete="username" placeholder="pat, or pat@example.com"></dd>
    <dt><label for="role">Role</label></dt>
    <dd><select id="role" name="role">${ROLES.map((r) => `<option${r === "admin" ? " selected" : ""}>${r}</option>`).join("")}</select></dd>
  </dl>
  <p><button>Sign in</button></p>
</form>
<p class="hint">A name with an @ also counts as a verified email, for trying <code>auth.scopes</code>.</p>`);
      });
    },
  };
}
