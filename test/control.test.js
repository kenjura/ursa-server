import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { startControlApi } from "../src/control/api.js";
import { createClient, readEvents, ClientError } from "../src/cli/client.js";
import { tempDir, quiet } from "./helpers.js";
import { join } from "path";

/** A stand-in for a site runtime. */
function fakeSite(id) {
  const events = new EventEmitter();
  const jobs = new Map();
  let n = 0;
  const enqueue = (type, opts) => {
    const job = { id: `${id}-${++n}`, type, opts, state: "done", result: { written: 1 } };
    jobs.set(job.id, job);
    return job;
  };
  return {
    id,
    events,
    calls: [],
    log: { since: (s) => [{ seq: 1, at: new Date().toISOString(), level: "info", message: "hello" }].filter((l) => l.seq > s) },
    status: () => ({ id, state: "idle" }),
    rebuild(o) { this.calls.push(["rebuild", o]); return enqueue("rebuild", o); },
    invalidate(o) { this.calls.push(["invalidate", o]); return enqueue("invalidate", o); },
    sync() { return enqueue("sync"); },
    pause() { this.calls.push(["pause"]); },
    resume() {},
    job: (jid) => jobs.get(jid) ?? null,
  };
}

async function start(t, sites, config = {}) {
  const api = await startControlApi(new Map(sites.map((s) => [s.id, s])), { host: "127.0.0.1", port: 0, token: null, socket: null, ...config }, { log: quiet, version: "test" });
  t.after(() => api.close());
  return api;
}

test("one site: bare routes work; jobs are queued and pollable", async (t) => {
  const site = fakeSite("only");
  const api = await start(t, [site]);
  const c = createClient({ url: `http://127.0.0.1:${api.port}` });
  assert.deepEqual(await c.get("/status"), { version: "test", sites: [{ id: "only", state: "idle" }] });
  const accepted = await c.post("/rebuild", { deploy: "all" });
  assert.equal(accepted.type, "rebuild");
  assert.deepEqual(site.calls[0], ["rebuild", { deploy: "all" }]);
  const done = await c.waitForJob("", accepted.id);
  assert.equal(done.state, "done");
  await c.post("/cache/invalidate", { scope: "graph", paths: ["a.md"] });
  assert.deepEqual(site.calls[1], ["invalidate", { scope: "graph", paths: ["a.md"] }]);
  await assert.rejects(c.post("/cache/invalidate", { scope: "nope" }), /scope must be/);
  await assert.rejects(c.post("/rebuild", { deploy: "some" }), /deploy must be/);
  assert.equal((await c.get("/log"))[0].message, "hello");
});

test("several sites: bare routes ask for a site id", async (t) => {
  const api = await start(t, [fakeSite("a"), fakeSite("b")]);
  const c = createClient({ url: `http://127.0.0.1:${api.port}` });
  await assert.rejects(c.post("/sync"), /several sites/);
  assert.equal((await c.post("/sites/b/sync")).type, "sync");
  await assert.rejects(c.get("/sites/zzz/status"), /no site "zzz"/);
});

test("a token is required over TCP; the socket is trusted", async (t) => {
  const dir = await tempDir(t);
  const socket = join(dir, "control.sock");
  const api = await start(t, [fakeSite("s")], { token: "sekrit", socket });
  const url = `http://127.0.0.1:${api.port}`;
  await assert.rejects(createClient({ url }).get("/status"), (e) => e instanceof ClientError && /token/.test(e.message));
  await assert.rejects(createClient({ url, token: "wrong" }).get("/status"), /token/);
  assert.equal((await createClient({ url, token: "sekrit" }).get("/status")).version, "test");
  assert.equal((await createClient({ url }).get("/health")).ok, true);
  assert.equal((await createClient({ socket }).get("/status")).version, "test");
});

test("events stream site events", async (t) => {
  const site = fakeSite("s");
  const api = await start(t, [site]);
  const res = await createClient({ url: `http://127.0.0.1:${api.port}` }).stream("/events");
  const got = [];
  const ended = readEvents(res, (type, data) => {
    got.push([type, data.message]);
    res.destroy();
  });
  setTimeout(() => site.events.emit("event", { type: "log", message: "built" }), 50);
  await Promise.race([ended, new Promise((r) => res.on("close", r))]);
  assert.deepEqual(got, [["log", "built"]]);
});
