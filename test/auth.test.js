import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import express from "express";
import { createServer } from "http";
import { createAuth } from "../src/auth/index.js";
import { rolesFor, hasRole } from "../src/auth/roles.js";
import { sign, verify } from "../src/auth/session.js";
import { normalize } from "../src/config/load.js";
import { startFakeIssuer } from "./fake-oidc.js";
import { quiet } from "./helpers.js";

const SECRET = "x".repeat(40);

test("roles: emails need verification; domains, subjects and wildcards; higher roles imply lower", () => {
  const rules = { admin: ["boss@example.com"], editor: ["*@team.org", "github|42"], viewer: ["*"] };
  assert.deepEqual(rolesFor({ sub: "a", email: "boss@example.com", emailVerified: true }, rules), ["viewer", "editor", "admin"]);
  assert.deepEqual(rolesFor({ sub: "a", email: "boss@example.com", emailVerified: false }, rules), ["viewer"]);
  assert.deepEqual(rolesFor({ sub: "b", email: "Pat@Team.org", emailVerified: true }, rules), ["viewer", "editor"]);
  assert.deepEqual(rolesFor({ sub: "github|42" }, rules), ["viewer", "editor"]);
  assert.deepEqual(rolesFor({ sub: "z", email: "x@evil.team.org.com", emailVerified: true }, { editor: ["*@team.org"] }), []);
  assert.deepEqual(rolesFor({ sub: "z" }, { viewer: ["sub:z"] }), ["viewer"]);
  assert.equal(hasRole(["viewer"], "editor"), false);
  assert.equal(hasRole([], "public"), true);
});

test("sessions: tampering and expiry are rejected", () => {
  const t = sign({ sub: "a", exp: Date.now() + 1000 }, SECRET);
  assert.equal(verify(t, SECRET).sub, "a");
  assert.equal(verify(t, "y".repeat(40)), null);
  assert.equal(verify(t.replace(/^./, "A"), SECRET), null);
  assert.equal(verify(sign({ sub: "a", exp: Date.now() - 1 }, SECRET), SECRET), null);
});

test("config: auth0 needs domain, client id/secret, a long secret, and someone with a role", () => {
  const base = { sites: [{ source: { path: "/s" } }], roles: { serve: true } };
  const auth = { sessionSecret: SECRET, provider: { preset: "auth0", domain: "t.us.auth0.com", clientId: "c", clientSecret: "s" }, roles: { viewer: ["*"] } };
  const ok = normalize({ ...base, server: { access: "viewer", port: 9000 }, auth }, {}, { warn: quiet });
  assert.equal(ok.auth.baseUrl, "http://127.0.0.1:9000");
  assert.equal(ok.auth.sessionDays, 14);
  assert.throws(() => normalize({ ...base, server: { access: "viewer" } }, {}, { warn: quiet }), /needs an `auth` section/);
  assert.throws(() => normalize({ ...base, auth: { ...auth, sessionSecret: "short" } }, {}, { warn: quiet }), /at least 32/);
  assert.throws(() => normalize({ ...base, auth: { ...auth, provider: { preset: "auth0", clientId: "c", clientSecret: "s" } } }, {}, { warn: quiet }), /domain: required/);
  assert.throws(() => normalize({ ...base, auth: { ...auth, roles: {} } }, {}, { warn: quiet }), /nobody has a role/);
});

/** An app guarded by auth, against the fake issuer; a tiny cookie-keeping browser. */
async function setup(t, { access = "viewer", roles = { viewer: ["*@example.com"] } } = {}) {
  const idp = await startFakeIssuer();
  t.after(() => idp.close());
  const app = express();
  const server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const auth = createAuth({
    baseUrl, sessionSecret: SECRET, sessionDays: 1, roles,
    provider: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
  }, { log: quiet });
  auth.mount(app);
  app.use(auth.requireRole(access));
  app.get("/secret/page", (req, res) => res.send(`hello ${req.user.name}`));

  const jar = new Map();
  async function go(url, opts = {}) {
    const headers = { Accept: "text/html", ...(opts.headers ?? {}) };
    const sameOrigin = url.startsWith(baseUrl);
    if (sameOrigin && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(url, { redirect: "manual", headers });
    if (sameOrigin) {
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(";");
        const [k, v] = kv.split("=");
        if (/Max-Age=0/.test(c)) jar.delete(k);
        else jar.set(k, v);
      }
    }
    return res;
  }
  /** Follow redirects, as a browser would. */
  async function browse(url) {
    let res = await go(url);
    res.hops = [];
    for (let i = 0; i < 10 && res.status === 302; i++) {
      const hops = [...res.hops, res.headers.get("location")];
      res = await go(new URL(res.headers.get("location"), url).href);
      res.hops = hops;
    }
    return res;
  }
  return { idp, baseUrl, go, browse, jar };
}

test("a guarded page sends the browser through sign-in and back", async (t) => {
  const { baseUrl, browse, go, idp } = await setup(t);
  const first = await go(`${baseUrl}/secret/page`);
  assert.equal(first.status, 302);
  assert.match(first.headers.get("location"), /^\/auth\/login\?returnTo=%2Fsecret%2Fpage/);

  const res = await browse(`${baseUrl}/secret/page`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello Me");
  assert.ok(idp.state.requests.includes("/oauth/token"));

  const me = await (await go(`${baseUrl}/auth/me`, { headers: { Accept: "application/json" } })).json();
  assert.deepEqual(me, { signedIn: true, sub: "auth0|1", name: "Me", email: "me@example.com", roles: ["viewer"] });
});

test("someone without a role is refused and gets no session", async (t) => {
  const { baseUrl, browse, jar, idp } = await setup(t);
  idp.state.user = { sub: "auth0|2", email: "stranger@else.com", email_verified: true, name: "S" };
  const res = await browse(`${baseUrl}/secret/page`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /stranger@else\.com.*doesn't have access/s);
  assert.equal(jar.has("ursa_session"), false);
});

test("an unverified email doesn't count", async (t) => {
  const { baseUrl, browse, idp } = await setup(t);
  idp.state.user = { sub: "auth0|3", email: "me@example.com", email_verified: false, name: "U" };
  const res = await browse(`${baseUrl}/secret/page`);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /not verified/);
});

test("non-page requests get 401; a forged returnTo stays on this site; logout clears the session", async (t) => {
  const { baseUrl, go, browse, jar } = await setup(t);
  const api = await go(`${baseUrl}/secret/page`, { headers: { Accept: "application/json" } });
  assert.equal(api.status, 401);

  const res = await browse(`${baseUrl}/auth/login?returnTo=//evil.example/x`);
  assert.equal(res.hops.at(-1), "/", "after the callback, back to this site's root");
  assert.ok(jar.has("ursa_session"));

  const out = await go(`${baseUrl}/auth/logout`);
  assert.equal(out.status, 302);
  assert.equal(jar.has("ursa_session"), false);
  assert.equal((await go(`${baseUrl}/secret/page`)).status, 302);
});

test("signing in from another host name moves to the configured one first", async (t) => {
  const { baseUrl, go } = await setup(t);
  const other = baseUrl.replace("127.0.0.1", "localhost");
  const res = await go(`${other}/auth/login?returnTo=/secret/page`);
  assert.equal(res.headers.get("location"), `${baseUrl}/auth/login?returnTo=%2Fsecret%2Fpage`);
});

test("a callback without the login cookie is rejected", async (t) => {
  const { baseUrl, go } = await setup(t);
  const res = await go(`${baseUrl}/auth/callback?code=x&state=y`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Sign-in expired/);
});
