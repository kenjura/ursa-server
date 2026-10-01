import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";

export async function tempDir(t, prefix = "ursa-server-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function put(root, rel, contents) {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
  return full;
}

/** A sink that records what it is asked to do, and can be told to fail. */
export function fakeSink({ listing = null } = {}) {
  const sink = {
    id: "fake:1",
    inPlace: false,
    held: new Map(), // rel → content
    calls: [],
    failNext: 0,
    async init() {},
    async put(rel, abs) {
      if (sink.failNext > 0) {
        sink.failNext--;
        throw new Error("simulated failure");
      }
      const { readFile } = await import("fs/promises");
      sink.held.set(rel, await readFile(abs, "utf8"));
      sink.calls.push(["put", rel]);
    },
    async remove(rels) {
      for (const r of rels) sink.held.delete(r);
      sink.calls.push(["remove", ...rels]);
    },
    async list() {
      return listing;
    },
    async commit(changed) {
      sink.calls.push(["commit", changed.length]);
      return null;
    },
    describe: () => "fake",
    puts: () => sink.calls.filter((c) => c[0] === "put").map((c) => c[1]),
    removes: () => sink.calls.filter((c) => c[0] === "remove").flatMap((c) => c.slice(1)),
    reset() {
      sink.calls = [];
    },
  };
  return sink;
}

export const quiet = () => {};
