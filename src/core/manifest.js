/**
 * Deploy manifest (docs/WATCHER.md#persistent-cache): what the sink holds,
 * as output path → MD5, plus paths whose deploy failed and must be retried.
 *
 * Written atomically after every change so a crash never leaves a half-file.
 */

import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { dirname } from "path";

export class DeployManifest {
  /** @param {string} file - path of deploy.json */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, string>} path → md5 the sink holds */
    this.entries = new Map();
    /** @type {Set<string>} paths to (re)deploy on the next attempt */
    this.pending = new Set();
    this.sinkId = null;
    this.loaded = false;
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      this.entries = new Map(Object.entries(data.entries ?? {}));
      this.pending = new Set(data.pending ?? []);
      this.sinkId = data.sinkId ?? null;
      this.loaded = true;
    } catch (e) {
      if (e.code !== "ENOENT") console.warn(`Could not read ${this.file} (${e.message}); starting with an empty manifest`);
      this.loaded = false;
    }
    return this;
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = {
      sinkId: this.sinkId,
      entries: Object.fromEntries([...this.entries].sort(([a], [b]) => (a < b ? -1 : 1))),
      pending: [...this.pending].sort(),
    };
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.file);
  }

  clear() {
    this.entries.clear();
    this.pending.clear();
  }
}
