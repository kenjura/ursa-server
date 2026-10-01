/**
 * `fs` source: a local folder. The folder is the working copy; changes come
 * from a recursive watch filtered as Ursa filters them (docs/WATCHER.md).
 *
 * The editor reads and writes through `files` (docs/EDITOR.md). Writes are
 * conditional on the content hash the editor last saw, so two people editing
 * the same file can't silently overwrite each other.
 */

import watch from "node-watch";
import { createHash, randomBytes } from "crypto";
import { readFile, writeFile, rename, unlink, mkdir, readdir, stat, realpath, rmdir } from "fs/promises";
import { dirname, join } from "path";

export class PreconditionFailed extends Error {
  constructor(message, current) {
    super(message);
    this.current = current; // { hash } of what is there now, or null if nothing
  }
}

export const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

/**
 * @param {object} config - normalised `source` block ({ type: "fs", path })
 * @param {{ isIgnored: (absPath: string) => boolean, extraRoots?: string[] }} opts
 *   - extraRoots: further folders whose changes are build inputs (the meta folder)
 * @returns {import("../types.js").SourceAdapter}
 */
export function createFsSource(config, { isIgnored, extraRoots = [] }) {
  const root = config.path;
  const abs = (rel) => (rel ? join(root, rel) : root);

  async function current(rel) {
    try {
      const bytes = await readFile(abs(rel));
      return { bytes, hash: hashOf(bytes) };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  /** Refuse to follow a symlink out of the source folder. */
  async function assertContained(rel) {
    let dir = dirname(abs(rel));
    for (;;) {
      try {
        const real = await realpath(dir);
        const realRoot = await realpath(root);
        if (real !== realRoot && !real.startsWith(realRoot + "/")) throw new Error(`${rel}: outside the source folder`);
        return;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        if (dir === root) return;
        dir = dirname(dir); // not created yet: check the nearest existing parent
      }
    }
  }

  /** Write via a temporary file and rename, so a reader never sees half a file. */
  async function writeAtomic(rel, bytes) {
    const target = abs(rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.ursa-tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  return {
    id: `fs:${root}`,
    workingCopy: root,
    async init() {},
    watch(onChanges) {
      const opts = { recursive: true, filter: (f, skip) => (isIgnored(f) ? skip : true) };
      const watchers = [root, ...extraRoots].map((r) => watch(r, opts, (evt, name) => onChanges([name])));
      return () => {
        for (const w of watchers) w.close();
      };
    },
    describe: () => root,

    files: {
      /** Entries of one folder (relative path), minus what the build ignores. */
      async list(dirRel = "") {
        await assertContained(join(dirRel, "x"));
        const entries = await readdir(abs(dirRel), { withFileTypes: true });
        const out = [];
        for (const e of entries) {
          const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
          if (isIgnored(abs(rel)) || !(e.isFile() || e.isDirectory())) continue;
          const s = await stat(abs(rel)).catch(() => null);
          if (!s) continue;
          out.push({ name: e.name, path: rel, type: e.isDirectory() ? "dir" : "file", size: s.size, mtime: s.mtimeMs });
        }
        return out.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
      },

      /** { bytes, hash } or null if there is no such file. */
      async read(rel) {
        await assertContained(rel);
        return current(rel);
      },

      /**
       * Write a file. `ifMatch`: the hash the writer last saw (the file must
       * still have it). `ifNoneMatch: true`: the file must not exist yet.
       */
      async write(rel, bytes, { ifMatch = null, ifNoneMatch = false } = {}) {
        await assertContained(rel);
        const now = await current(rel);
        if (ifNoneMatch && now) throw new PreconditionFailed(`${rel} already exists`, { hash: now.hash });
        if (ifMatch && (!now || now.hash !== ifMatch)) throw new PreconditionFailed(`${rel} changed since you opened it`, now && { hash: now.hash });
        if (!ifMatch && !ifNoneMatch && now) throw new PreconditionFailed(`${rel} exists; say which version you are replacing`, { hash: now.hash });
        await writeAtomic(rel, bytes);
        return { hash: hashOf(bytes) };
      },

      async remove(rel, { ifMatch = null } = {}) {
        await assertContained(rel);
        const s = await stat(abs(rel)).catch(() => null);
        if (!s) throw new PreconditionFailed(`${rel} doesn't exist`, null);
        if (s.isDirectory()) {
          await rmdir(abs(rel)).catch((e) => {
            throw e.code === "ENOTEMPTY" ? new PreconditionFailed(`${rel} isn't empty`, null) : e;
          });
          return;
        }
        const now = await current(rel);
        if (!ifMatch || now.hash !== ifMatch) throw new PreconditionFailed(`${rel} changed since you opened it`, { hash: now.hash });
        await unlink(abs(rel));
      },

      async rename(from, to) {
        await assertContained(from);
        await assertContained(to);
        if (!(await stat(abs(from)).catch(() => null))) throw new PreconditionFailed(`${from} doesn't exist`, null);
        if (await stat(abs(to)).catch(() => null)) throw new PreconditionFailed(`${to} already exists`, null);
        await mkdir(dirname(abs(to)), { recursive: true });
        await rename(abs(from), abs(to));
      },

      async mkdir(rel) {
        await assertContained(join(rel, "x"));
        if (await stat(abs(rel)).catch(() => null)) throw new PreconditionFailed(`${rel} already exists`, null);
        await mkdir(abs(rel), { recursive: true });
      },

      absolute: abs,
    },
  };
}
