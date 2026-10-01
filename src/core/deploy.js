/**
 * Getting built files to the sink (docs/WATCHER.md#the-delta-pipeline).
 *
 * The manifest records what the sink holds. A deploy considers a set of
 * output paths — those a pass wrote or deleted, plus any whose last deploy
 * failed — and for each decides by what is on disk now:
 *
 * - exists, and its MD5 differs from the manifest → upload;
 * - exists, same MD5 → nothing (a clean rebuild that reproduces the same bytes
 *   costs no uploads);
 * - gone, and the manifest has it → delete from the sink;
 * - gone, never deployed → nothing.
 *
 * Paths are marked pending before anything is sent and cleared one by one as
 * the sink confirms, so a failure or a crash is retried rather than lost.
 */

import { existsSync } from "fs";
import { join } from "path";
import { md5File, listFiles } from "../util/files.js";

const PUT_CONCURRENCY = 8;

/**
 * @param {object} ctx
 * @param {import("../adapters/types.js").SinkAdapter} ctx.sink
 * @param {import("./manifest.js").DeployManifest} ctx.manifest
 * @param {string} ctx.output - staging output folder
 * @param {Iterable<string>} changed - output paths (relative) that may differ from the sink
 * @param {{ remote?: Map<string, string> }} [opts] - what the sink is known to hold
 *   (from sink.list()); matching files are recorded instead of uploaded
 * @returns {Promise<DeployResult>}
 *
 * @typedef {object} DeployResult
 * @property {number} uploaded
 * @property {number} removed
 * @property {number} unchanged
 * @property {{ path: string, error: string }[]} failed
 * @property {string[] | null} invalidated - CDN paths invalidated
 * @property {string | null} commitError
 */
export async function deploy({ sink, manifest, output }, changed, { remote = null } = {}) {
  const result = { uploaded: 0, removed: 0, unchanged: 0, failed: [], invalidated: null, commitError: null };
  if (sink.inPlace) return result;

  const candidates = new Set([...changed, ...manifest.pending]);
  const puts = [];
  const deletes = [];
  for (const rel of [...candidates].sort()) {
    const abs = join(output, rel);
    if (existsSync(abs)) {
      const md5 = await md5File(abs);
      if (manifest.entries.get(rel) === md5 || remote?.get(rel) === md5) {
        manifest.entries.set(rel, md5);
        manifest.pending.delete(rel);
        result.unchanged++;
      } else {
        puts.push({ rel, abs, md5 });
      }
    } else if (manifest.entries.has(rel)) {
      deletes.push(rel);
    } else {
      manifest.pending.delete(rel);
    }
  }
  if (puts.length === 0 && deletes.length === 0) {
    await manifest.save();
    return result;
  }

  for (const p of puts) manifest.pending.add(p.rel);
  for (const d of deletes) manifest.pending.add(d);
  await manifest.save();

  const done = [];
  if (sink.batched) {
    try {
      await sink.sync([...puts.map((p) => p.rel), ...deletes]);
      for (const p of puts) settlePut(p);
      for (const d of deletes) settleDelete(d);
    } catch (e) {
      for (const p of [...puts.map((x) => x.rel), ...deletes]) result.failed.push({ path: p, error: e.message });
    }
  } else {
    // Assets before pages, so a page never points at an asset not there yet
    const assets = puts.filter((p) => !p.rel.endsWith(".html"));
    const pages = puts.filter((p) => p.rel.endsWith(".html"));
    for (const group of [assets, pages]) {
      await pool(group, PUT_CONCURRENCY, async (p) => {
        try {
          await sink.put(p.rel, p.abs);
          settlePut(p);
        } catch (e) {
          result.failed.push({ path: p.rel, error: e.message });
        }
      });
    }
    if (deletes.length > 0) {
      try {
        await sink.remove(deletes);
        for (const d of deletes) settleDelete(d);
      } catch (e) {
        for (const d of deletes) result.failed.push({ path: d, error: e.message });
      }
    }
  }
  await manifest.save();

  if (done.length > 0) {
    try {
      result.invalidated = await sink.commit(done);
    } catch (e) {
      result.commitError = e.message;
    }
  }
  return result;

  function settlePut(p) {
    manifest.entries.set(p.rel, p.md5);
    manifest.pending.delete(p.rel);
    result.uploaded++;
    done.push(p.rel);
  }
  function settleDelete(rel) {
    manifest.entries.delete(rel);
    manifest.pending.delete(rel);
    result.removed++;
    done.push(rel);
  }
}

/**
 * Bring the sink in line with the whole output folder: every local file, and
 * every file the manifest says was deployed. Used at startup (catches a crash
 * between a build and its deploy), after clean rebuilds (whose deletions Ursa
 * does not report) and when the manifest is reset.
 *
 * @param {object} ctx - as deploy()
 * @param {{ useSinkListing?: boolean }} [opts] - ask the sink what it holds,
 *   so files already there are not uploaded again (first run, lost manifest)
 */
export async function reconcile(ctx, { useSinkListing = false } = {}) {
  if (ctx.sink.inPlace) return deploy(ctx, []);
  const local = await listFiles(ctx.output);
  const remote = useSinkListing ? await ctx.sink.list() : null;
  return deploy(ctx, new Set([...local, ...ctx.manifest.entries.keys()]), { remote });
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
