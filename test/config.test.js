import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { loadConfig, normalize, ConfigError } from "../src/config/load.js";
import { tempDir, put, quiet } from "./helpers.js";

test("a config built from --source is one fs site", async () => {
  const c = await loadConfig(null, { source: "docs" }, { cwd: "/work", warn: quiet });
  assert.equal(c.sites.length, 1);
  assert.deepEqual(c.sites[0].source, { type: "fs", path: "/work/docs" });
  assert.deepEqual(c.sites[0].sink, { type: "fs", path: "/work/output" });
  assert.equal(c.stateDir, "/work/.ursa-server");
  assert.equal(c.roles.watch, true);
  assert.equal(c.control.port, 7071);
});

test("YAML: kebab keys, env substitution, paths relative to the file", async (t) => {
  const dir = await tempDir(t);
  const file = await put(dir, "conf/ursa-server.yml", `
state-dir: ./state
control: { token: "\${TOKEN}" }
sites:
  - id: wiki
    ursa: { meta: ../meta, directory-depth: 2, exclude: [a, b] }
    source: { type: fs, path: ~/docs }
    sink:
      type: s3
      bucket: "\${BUCKET:-fallback}"
      prefix: /site
      cloudfront: { distribution-id: E1 }
auth:
  session-secret: "\${SECRET}"
  provider: { preset: auth0, domain: t.us.auth0.com, client-id: cid, client-secret: cs }
  roles:
    editor: ["first-last@example.com"]
  scopes:
    first-last@example.com: ["campaigns/**"]
`);
  const c = await loadConfig(file, {}, { env: { TOKEN: "t0k", SECRET: "s".repeat(40) }, warn: quiet });
  assert.equal(c.stateDir, join(dir, "conf/state"));
  assert.equal(c.control.token, "t0k");
  const s = c.sites[0];
  assert.equal(s.ursa.meta, join(dir, "meta"));
  assert.equal(s.ursa.directoryDepth, 2);
  assert.equal(s.ursa.exclude, "a,b");
  assert.equal(s.sink.bucket, "fallback");
  assert.equal(s.sink.prefix, "site/");
  assert.equal(s.sink.cloudfront.distributionId, "E1");
  assert.equal(s.sink.cloudfront.maxPaths, 25);
  assert.match(s.sink.cacheControl.html, /max-age=0/);
  // Role rules and scopes are data: emails used as keys are not camelized
  assert.deepEqual(c.auth.roles.editor, ["first-last@example.com"]);
  assert.deepEqual(c.auth.scopes, { "first-last@example.com": ["campaigns/**"] });
  assert.equal(c.auth.provider.clientId, "cid");
  assert.equal(c.auth.baseUrl, "http://127.0.0.1:8080");
});

test("an unset variable without a default is an error naming the key", async (t) => {
  const dir = await tempDir(t);
  const file = await put(dir, "c.yml", "sites: [{ source: { path: x }, sink: { type: s3, bucket: '${NOPE}' } }]\n");
  await assert.rejects(loadConfig(file, {}, { env: {}, warn: quiet }), /config\.sites\[0\]\.sink\.bucket: environment variable NOPE/);
});

test("validation", () => {
  const base = { sites: [{ source: { path: "/s" } }] };
  assert.throws(() => normalize({}, {}, { warn: quiet }), /no sites/);
  assert.throws(() => normalize({ sites: [{ source: { path: "/s" }, sink: { type: "ftp" } }] }, {}, { warn: quiet }), /sites\[0\]\.sink\.type: one of/);
  assert.throws(() => normalize({ sites: [{ source: { path: "/s" }, sink: { type: "s3" } }] }, {}, { warn: quiet }), /bucket: required/);
  assert.throws(() => normalize({ ...base, server: { port: "x" } }, {}, { warn: quiet }), /server\.port: expected an integer/);
  assert.throws(() => normalize({ sites: [{ id: "a", source: { path: "/s" } }, { id: "a", source: { path: "/t" } }] }, {}, { warn: quiet }), /duplicate id/);
  assert.throws(() => normalize({ ...base, control: { host: "0.0.0.0" } }, {}, { warn: quiet }), /set control\.token/);
  assert.throws(() => normalize(base, { source: "/x" }, { warn: quiet }), /cannot be combined/);

  const warnings = [];
  normalize({ ...base, colour: "red" }, {}, { warn: (m) => warnings.push(m) });
  assert.match(warnings[0], /unknown key config\.colour/);
});

test("rsync targets: remote kept as written, local resolved; both end in /", () => {
  const n = (target) => normalize({ sites: [{ source: { path: "/s" }, sink: { type: "rsync", target } }] }, {}, { base: "/cfg", warn: quiet }).sites[0].sink.target;
  assert.equal(n("me@host:/var/www"), "me@host:/var/www/");
  assert.equal(n("host:site"), "host:site/");
  assert.equal(n("./www"), "/cfg/www/");
});
