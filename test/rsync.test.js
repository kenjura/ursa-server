import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { existsSync } from "fs";
import { readFile, unlink, mkdir } from "fs/promises";
import { execFileSync } from "child_process";
import { createRsyncSink } from "../src/adapters/sink/rsync.js";
import { tempDir, put } from "./helpers.js";

const hasRsync = (() => {
  try {
    execFileSync("rsync", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("rsync to a local folder: pushes changed files, deletes only the paths it is given", { skip: !hasRsync && "rsync not installed" }, async (t) => {
  const dir = await tempDir(t);
  const output = join(dir, "out");
  const target = join(dir, "www");
  await mkdir(target);
  await put(target, "not-ours.txt", "keep me");
  await put(output, "a.html", "A");
  await put(output, "sub/b.html", "B");

  const sink = createRsyncSink({ target: target + "/", args: [] });
  await sink.init({ output });
  await sink.sync(["a.html", "sub/b.html"]);
  assert.equal(await readFile(join(target, "sub/b.html"), "utf8"), "B");

  await unlink(join(output, "a.html"));
  await sink.sync(["a.html"]);
  assert.equal(existsSync(join(target, "a.html")), false);
  assert.equal(existsSync(join(target, "sub/b.html")), true);
  assert.equal(await readFile(join(target, "not-ours.txt"), "utf8"), "keep me");
});

test("rsync failures are reported with rsync's message", { skip: !hasRsync && "rsync not installed" }, async (t) => {
  const dir = await tempDir(t);
  const output = join(dir, "out");
  await put(output, "a.html", "A");
  const sink = createRsyncSink({ target: join(dir, "missing/deeper") + "/", args: [] });
  await sink.init({ output });
  await assert.rejects(sink.sync(["a.html"]), /rsync exited/);
});
