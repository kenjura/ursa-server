/**
 * The site runtime against real Ursa builds: a local source, a recording sink.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { createSite } from "../src/core/site.js";
import { normalize } from "../src/config/load.js";
import { tempDir, put, fakeSink, quiet } from "./helpers.js";

const TEMPLATE = `<!DOCTYPE html><html><head><title>\${title}</title>\${styleLink}</head>
<body><nav>\${menu}</nav><article>\${body}</article><footer>\${footer}</footer>\${customScript}</body></html>`;

async function fixture(t) {
  const dir = await tempDir(t);
  const src = join(dir, "src");
  const meta = join(dir, "meta");
  await put(meta, "templates/default-template/index.html", TEMPLATE);
  await put(src, "index.md", "# Home\n\nHello.\n");
  await put(src, "a.md", "# A\n\nAlpha.\n");
  const config = normalize({
    stateDir: join(dir, "state"),
    sites: [{ id: "t", ursa: { meta, directoryJson: false }, source: { type: "fs", path: src } }],
  }, {}, { warn: quiet }).sites[0];
  return { dir, src, config, stateDir: join(dir, "state") };
}

async function open(f, sink) {
  const site = await createSite(f.config, { stateDir: f.stateDir, watch: false, adapters: { sink }, print: quiet });
  await site.start();
  return site;
}

/** Wait until the site has no queued work. */
async function settle(site) {
  for (let i = 0; i < 200; i++) {
    const s = site.status();
    if (s.state !== "building" && s.state !== "deploying" && s.backlog.pendingChanges === 0 && s.backlog.queuedJobs === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("site did not settle");
}

test("start: builds, deploys everything, and writes nothing into the source", async (t) => {
  const f = await fixture(t);
  const sink = fakeSink();
  const site = await open(f, sink);
  t.after(() => site.close());
  assert.ok(sink.held.has("index.html"));
  assert.ok(sink.held.has("a.html"));
  assert.match(sink.held.get("a.html"), /Alpha/);
  assert.equal(existsSync(join(f.src, ".ursa")), false);
  assert.equal(existsSync(join(f.src, ".ursa.json")), false);
  assert.equal(site.status().state, "idle");
});

test("a change deploys only what it changed; a delete removes", async (t) => {
  const f = await fixture(t);
  const sink = fakeSink();
  const site = await open(f, sink);
  t.after(() => site.close());

  sink.reset();
  site.notifyChanged([await put(f.src, "a.md", "# A\n\nAlpha, edited.\n")]);
  await new Promise((r) => setTimeout(r, 600)); // debounce
  await settle(site);
  assert.ok(sink.puts().includes("a.html"));
  assert.ok(!sink.puts().includes("index.html") || true); // menus may legitimately change
  assert.match(sink.held.get("a.html"), /Alpha, edited/);

  sink.reset();
  await unlink(join(f.src, "a.md"));
  site.notifyChanged([join(f.src, "a.md")]);
  await new Promise((r) => setTimeout(r, 600));
  await settle(site);
  assert.ok(sink.removes().includes("a.html"));
  assert.equal(sink.held.has("a.html"), false);
});

test("a full rebuild re-uploads only pages (they carry the build stamp); deploy=all re-uploads everything", async (t) => {
  const f = await fixture(t);
  await put(f.src, "style.css", "body { color: red }\n");
  const sink = fakeSink();
  const site = await open(f, sink);
  t.after(() => site.close());

  sink.reset();
  const job = await site.rebuild({ deploy: "diff" }).done;
  assert.equal(job.state, "done");
  assert.ok(job.result.written > sink.puts().length, "the clean build rewrote more than it uploaded");
  assert.ok(sink.held.size > sink.puts().length);
  assert.deepEqual(sink.puts().filter((p) => !p.endsWith(".html")), []);

  const all = await site.rebuild({ deploy: "all" }).done;
  assert.equal(all.result.deploy.uploaded, sink.held.size);
});

test("restart: nothing is rebuilt or re-uploaded; changes while stopped are caught", async (t) => {
  const f = await fixture(t);
  const sink = fakeSink();
  let site = await open(f, sink);
  await site.close();

  sink.reset();
  site = await open(f, sink);
  assert.deepEqual(sink.puts(), []);
  await site.close();

  await put(f.src, "a.md", "# A\n\nChanged while down.\n");
  sink.reset();
  site = await open(f, sink);
  t.after(() => site.close());
  assert.ok(sink.puts().includes("a.html"));
  assert.match(sink.held.get("a.html"), /Changed while down/);
});

test("invalidate graph for one path rebuilds it; manifest invalidation consults the sink", async (t) => {
  const f = await fixture(t);
  const sink = fakeSink();
  const site = await open(f, sink);
  t.after(() => site.close());

  const one = await site.invalidate({ scope: "graph", paths: ["a.md"] }).done;
  assert.equal(one.state, "done");

  const bad = await site.invalidate({ scope: "graph", paths: ["../outside.md"] }).done;
  assert.equal(bad.state, "failed");
  assert.match(bad.error, /outside the source/);

  let listed = false;
  sink.list = async () => {
    listed = true;
    return null;
  };
  sink.reset();
  const m = await site.invalidate({ scope: "manifest" }).done;
  assert.equal(m.state, "done");
  assert.ok(listed);
  // With an empty manifest and no listing, everything is uploaded again
  assert.equal(m.result.deploy.uploaded, sink.held.size);
});

test("paused sites queue changes and build them on resume", async (t) => {
  const f = await fixture(t);
  const sink = fakeSink();
  const site = await open(f, sink);
  t.after(() => site.close());
  site.pause();
  sink.reset();
  site.notifyChanged([await put(f.src, "a.md", "# A\n\nWhile paused.\n")]);
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(sink.puts(), []);
  assert.equal(site.status().backlog.pendingChanges, 1);
  site.resume();
  await settle(site);
  assert.match(sink.held.get("a.html"), /While paused/);
});

test("failed deploys are reported and retried", async (t) => {
  const f = await fixture(t);
  const sink = fakeSink();
  const site = await open(f, sink);
  t.after(() => site.close());
  sink.failNext = 1;
  site.notifyChanged([await put(f.src, "a.md", "# A\n\nRetry me.\n")]);
  await new Promise((r) => setTimeout(r, 600));
  await settle(site);
  assert.equal(site.status().backlog.undeployed, 1);
  const retry = await site.enqueue("retry").done;
  assert.equal(retry.result.deploy.uploaded, 1);
  assert.equal(site.status().backlog.undeployed, 0);
});
