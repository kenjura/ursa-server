/**
 * The editor API against a real site: a local source, Ursa building it, the
 * dev server with auth, and a signed-in user via a session cookie.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { readFile, symlink } from "fs/promises";
import { existsSync } from "fs";
import { startServer } from "../src/core/server.js";
import { normalize } from "../src/config/load.js";
import { sign } from "../src/auth/session.js";
import { hashOf } from "../src/adapters/source/fs.js";
import { mayWrite } from "../src/editor/paths.js";
import { tempDir, put, quiet } from "./helpers.js";

const SECRET = "s".repeat(40);
const TEMPLATE = `<!DOCTYPE html><html><head><title>\${title}</title>\${styleLink}</head>
<body><nav>\${menu}</nav><article>\${body}</article><footer>\${footer}</footer>\${customScript}</body></html>`;

async function setup(t, { access = "viewer", edit = true } = {}) {
  const dir = await tempDir(t);
  const src = join(dir, "src");
  const meta = join(dir, "meta");
  await put(meta, "templates/default-template/index.html", TEMPLATE);
  await put(src, "index.md", "# Home\n\nHello.\n");
  await put(src, "rules/combat.md", "# Combat\n\nHit things.\n");
  await put(src, "campaigns/a.md", "# A\n");
  const config = normalize({
    stateDir: join(dir, "state"),
    roles: { serve: true, edit },
    server: { port: 0, access },
    control: { enabled: false },
    sites: [{ id: "t", ursa: { meta, directoryJson: false }, source: { path: src }, sink: { path: join(dir, "out") } }],
    auth: {
      baseUrl: "http://127.0.0.1",
      sessionSecret: SECRET,
      provider: { issuer: "https://issuer.invalid/", clientId: "c", clientSecret: "s" },
      roles: { viewer: ["*"] },
      scopes: { "scoped@x.com": ["campaigns/**"] },
    },
  }, {}, { warn: quiet });
  const server = await startServer(config, { print: quiet });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.devServer.port}`;
  const as = (roles, email = "ed@x.com") => `ursa_session=${encodeURIComponent(sign({ sub: `auth0|${email}`, name: email, email, roles, exp: Date.now() + 60_000 }, SECRET))}`;
  const editor = as(["viewer", "editor"]);
  async function call(method, path, { cookie = editor, body, headers = {} } = {}) {
    const h = { Accept: "application/json", Cookie: cookie, ...headers };
    if (method !== "GET" && !("X-Ursa-Editor" in headers)) h["X-Ursa-Editor"] = "1";
    const res = await fetch(base + path, { method, headers: h, body, redirect: "manual" });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  return { src, base, call, as, editor, server };
}

test("reading: tree, file with hash and page URL, resolving a page to its source", async (t) => {
  const { call } = await setup(t);
  const tree = await call("GET", "/edit/api/tree");
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.json.entries.map((e) => e.path), ["campaigns", "rules", "index.md"]);

  const f = await call("GET", "/edit/api/file?path=rules/combat.md");
  assert.equal(f.json.text, "# Combat\n\nHit things.\n");
  assert.equal(f.json.hash, hashOf(Buffer.from(f.json.text)));
  assert.equal(f.json.url, "/rules/combat");
  assert.equal(f.json.writable, true);

  assert.deepEqual((await call("GET", "/edit/api/resolve?page=/rules/combat")).json, { path: "rules/combat.md" });
  assert.deepEqual((await call("GET", "/edit/api/resolve?page=/")).json, { path: "index.md" });
  assert.deepEqual((await call("GET", "/edit/api/resolve?page=/campaigns/")).json, { dir: "campaigns" });
});

test("saving needs the hash you started from; a stale one gets 412 with the current hash", async (t) => {
  const { call, src, server } = await setup(t);
  const f = (await call("GET", "/edit/api/file?path=rules/combat.md")).json;

  const noBase = await call("PUT", "/edit/api/file?path=rules/combat.md", { body: "x" });
  assert.equal(noBase.status, 428);

  const ok = await call("PUT", "/edit/api/file?path=rules/combat.md", { body: "# Combat\n\nEdited.\n", headers: { "If-Match": `"${f.hash}"` } });
  assert.equal(ok.status, 200);
  assert.equal(await readFile(join(src, "rules/combat.md"), "utf8"), "# Combat\n\nEdited.\n");

  const stale = await call("PUT", "/edit/api/file?path=rules/combat.md", { body: "# Mine\n", headers: { "If-Match": `"${f.hash}"` } });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.current.hash, ok.json.hash);

  // The site rebuilds the page
  const site = server.sites.get("t");
  for (let i = 0; i < 100 && !/Edited/.test(await readFile(join(site.output, "rules/combat.html"), "utf8").catch(() => "")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(await readFile(join(site.output, "rules/combat.html"), "utf8"), /Edited/);
});

test("create, mkdir, move, delete", async (t) => {
  const { call, src } = await setup(t);
  assert.equal((await call("PUT", "/edit/api/file?path=new/page.md", { body: "# New\n", headers: { "If-None-Match": "*" } })).status, 201);
  assert.equal((await call("PUT", "/edit/api/file?path=new/page.md", { body: "again", headers: { "If-None-Match": "*" } })).status, 412);
  assert.equal((await call("POST", "/edit/api/mkdir", { body: JSON.stringify({ path: "empty" }), headers: { "Content-Type": "application/json" } })).status, 201);
  assert.equal((await call("POST", "/edit/api/move", { body: JSON.stringify({ from: "new/page.md", to: "new/renamed.md" }), headers: { "Content-Type": "application/json" } })).status, 200);
  assert.ok(existsSync(join(src, "new/renamed.md")));
  const moveOnto = await call("POST", "/edit/api/move", { body: JSON.stringify({ from: "new/renamed.md", to: "index.md" }), headers: { "Content-Type": "application/json" } });
  assert.equal(moveOnto.status, 412);

  const h = hashOf(Buffer.from("# New\n"));
  assert.equal((await call("DELETE", "/edit/api/file?path=new/renamed.md")).status, 412, "delete needs If-Match");
  assert.equal((await call("DELETE", "/edit/api/file?path=new/renamed.md", { headers: { "If-Match": `"${h}"` } })).status, 204);
  assert.equal(existsSync(join(src, "new/renamed.md")), false);
  assert.equal((await call("DELETE", "/edit/api/file?path=empty")).status, 204);
});

test("binary uploads round-trip", async (t) => {
  const { call, base, editor } = await setup(t);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await call("PUT", "/edit/api/file?path=img/a.png", { body: png, headers: { "If-None-Match": "*", "Content-Type": "image/png" } })).status, 201);
  const meta = (await call("GET", "/edit/api/file?path=img/a.png")).json;
  assert.equal(meta.binary, true);
  assert.equal(meta.text, null);
  const raw = await fetch(`${base}/edit/api/raw?path=img/a.png`, { headers: { Cookie: editor } });
  assert.equal(raw.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);
});

test("who may do what: viewers can't edit, scoped editors only within scope, admins anywhere", async (t) => {
  const { call, as } = await setup(t);
  const viewer = await call("GET", "/edit/api/tree", { cookie: as(["viewer"]) });
  assert.equal(viewer.status, 403);
  const anon = await call("GET", "/edit/api/tree", { cookie: "" });
  assert.equal(anon.status, 401);

  const scoped = as(["viewer", "editor"], "scoped@x.com");
  const tree = await call("GET", "/edit/api/tree", { cookie: scoped });
  assert.deepEqual(Object.fromEntries(tree.json.entries.map((e) => [e.path, e.writable])), { campaigns: true, rules: false, "index.md": false });
  assert.equal((await call("PUT", "/edit/api/file?path=index.md", { cookie: scoped, body: "x", headers: { "If-Match": '"x"' } })).status, 403);
  assert.equal((await call("PUT", "/edit/api/file?path=campaigns/b.md", { cookie: scoped, body: "# B\n", headers: { "If-None-Match": "*" } })).status, 201);
  assert.deepEqual((await call("GET", "/edit/api/me", { cookie: scoped })).json.scopes, ["campaigns/**"]);

  const admin = as(["viewer", "editor", "admin"], "boss@x.com");
  assert.equal((await call("PUT", "/edit/api/file?path=x.md", { cookie: admin, body: "# X\n", headers: { "If-None-Match": "*" } })).status, 201);
  assert.equal(mayWrite({ roles: ["viewer", "editor", "admin"], email: "scoped@x.com", sub: "s" }, "index.md", { "scoped@x.com": ["campaigns/**"] }), true);
});

test("paths can't escape the source or touch hidden files", async (t) => {
  const { call, src } = await setup(t);
  for (const p of ["../outside.md", "a/../../x.md", ".env", "rules/.secret", "a\\b.md"]) {
    const r = await call("PUT", `/edit/api/file?path=${encodeURIComponent(p)}`, { body: "x", headers: { "If-None-Match": "*" } });
    assert.equal(r.status, 400, p);
  }
  await symlink("/tmp", join(src, "escape"));
  const r = await call("PUT", "/edit/api/file?path=escape/x.md", { body: "x", headers: { "If-None-Match": "*" } });
  assert.notEqual(r.status, 201);
  assert.equal(existsSync("/tmp/x.md") && (await readFile("/tmp/x.md", "utf8")) === "x", false);
});

test("changes need the editor header (no cross-site form posts)", async (t) => {
  const { call } = await setup(t);
  const r = await call("PUT", "/edit/api/file?path=n.md", { body: "x", headers: { "If-None-Match": "*", "X-Ursa-Editor": undefined } });
  assert.equal(r.status, 403);
});

test("pages carry the ursa-server config block; the UI is served", async (t) => {
  const { base, editor, call } = await setup(t);
  const page = await (await fetch(`${base}/rules/combat`, { headers: { Cookie: editor } })).text();
  assert.match(page, /<script type="application\/json" id="ursa-server">\{"auth":"\/auth","profile":"\/auth\/profile","edit":"\/edit\/"\}<\/script>/);
  const ui = await call("GET", "/edit/", { headers: { Accept: "text/html" } });
  assert.equal(ui.status, 200);
  assert.match(ui.text, /<script src="editor.js">/);
  const profile = await call("GET", "/auth/profile", { headers: { Accept: "text/html" } });
  assert.match(profile.text, /Your account/);
  assert.match(profile.text, /Edit the site/);
});

test("config: editing without sign-in only on loopback; edit needs serve", () => {
  const base = { sites: [{ source: { path: "/s" } }] };
  assert.throws(() => normalize({ ...base, roles: { edit: true } }, {}, { warn: quiet }), /needs roles\.serve/);
  assert.throws(() => normalize({ ...base, roles: { serve: true, edit: true }, server: { host: "0.0.0.0" } }, {}, { warn: quiet }), /without `auth`/);
  assert.ok(normalize({ ...base, roles: { serve: true, edit: true } }, {}, { warn: quiet }).roles.edit);
});
