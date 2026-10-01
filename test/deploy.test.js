import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { unlink } from "fs/promises";
import { deploy, reconcile } from "../src/core/deploy.js";
import { DeployManifest } from "../src/core/manifest.js";
import { md5File } from "../src/util/files.js";
import { tempDir, put, fakeSink } from "./helpers.js";

async function setup(t, opts) {
  const dir = await tempDir(t);
  const output = join(dir, "out");
  const manifest = await new DeployManifest(join(dir, "deploy.json")).load();
  const sink = fakeSink(opts);
  return { dir, output, manifest, sink, ctx: { sink, manifest, output } };
}

test("uploads changed files, assets before pages, and records them", async (t) => {
  const { output, manifest, sink, ctx } = await setup(t);
  await put(output, "a.html", "A");
  await put(output, "public/x.css", "X");
  const r = await deploy(ctx, ["a.html", "public/x.css"]);
  assert.equal(r.uploaded, 2);
  assert.deepEqual(sink.puts(), ["public/x.css", "a.html"]);
  assert.equal(manifest.entries.get("a.html"), await md5File(join(output, "a.html")));
  assert.deepEqual(sink.calls.at(-1), ["commit", 2]);

  // Saved to disk
  const reloaded = await new DeployManifest(manifest.file).load();
  assert.equal(reloaded.entries.size, 2);
});

test("unchanged bytes are not uploaded again", async (t) => {
  const { output, sink, ctx } = await setup(t);
  await put(output, "a.html", "A");
  await deploy(ctx, ["a.html"]);
  sink.reset();
  await put(output, "a.html", "A"); // rewritten, same bytes
  const r = await deploy(ctx, ["a.html"]);
  assert.equal(r.uploaded, 0);
  assert.equal(r.unchanged, 1);
  assert.deepEqual(sink.calls, []);
});

test("deletes only files it deployed", async (t) => {
  const { output, sink, manifest, ctx } = await setup(t);
  await put(output, "a.html", "A");
  await deploy(ctx, ["a.html"]);
  await unlink(join(output, "a.html"));
  const r = await deploy(ctx, ["a.html", "never-deployed.html"]);
  assert.equal(r.removed, 1);
  assert.deepEqual(sink.removes(), ["a.html"]);
  assert.equal(manifest.entries.has("a.html"), false);
});

test("a failed upload stays pending and is retried", async (t) => {
  const { output, sink, manifest, ctx } = await setup(t);
  await put(output, "a.html", "A");
  await put(output, "b.html", "B");
  sink.failNext = 1;
  const r = await deploy(ctx, ["a.html", "b.html"]);
  assert.equal(r.failed.length, 1);
  assert.equal(manifest.pending.size, 1);
  const failedPath = r.failed[0].path;

  // Pending survives a restart
  const reloaded = await new DeployManifest(manifest.file).load();
  assert.deepEqual([...reloaded.pending], [failedPath]);

  const retry = await deploy(ctx, []);
  assert.equal(retry.uploaded, 1);
  assert.equal(manifest.pending.size, 0);
  assert.equal(sink.held.get(failedPath), failedPath === "a.html" ? "A" : "B");
});

test("reconcile: uploads what the manifest lacks, deletes what vanished, trusts a sink listing", async (t) => {
  const { output, sink, manifest, ctx } = await setup(t);
  await put(output, "a.html", "A");
  await put(output, "b.html", "B");
  manifest.entries.set("gone.html", "abc");
  sink.list = async () => new Map([["a.html", await md5File(join(output, "a.html"))]]);
  const r = await reconcile(ctx, { useSinkListing: true });
  assert.deepEqual(sink.puts(), ["b.html"]);
  assert.deepEqual(sink.removes(), ["gone.html"]);
  assert.equal(r.unchanged, 1);
  assert.deepEqual([...manifest.entries.keys()].sort(), ["a.html", "b.html"]);
});

test("a batched sink gets puts and deletes in one sync", async (t) => {
  const { output, manifest, ctx } = await setup(t);
  const synced = [];
  ctx.sink = { id: "b", inPlace: false, batched: true, async sync(rels) { synced.push(rels); }, async commit() { return null; } };
  await put(output, "a.html", "A");
  manifest.entries.set("old.html", "x");
  const r = await deploy(ctx, ["a.html", "old.html"]);
  assert.deepEqual(synced, [["a.html", "old.html"]]);
  assert.equal(r.uploaded, 1);
  assert.equal(r.removed, 1);
});

test("an in-place sink deploys nothing", async (t) => {
  const { output, ctx } = await setup(t);
  ctx.sink = { inPlace: true };
  await put(output, "a.html", "A");
  const r = await deploy(ctx, ["a.html"]);
  assert.equal(r.uploaded, 0);
});
