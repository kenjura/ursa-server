/**
 * `rsync` sink: push changed files to a folder on another machine over SSH
 * (or to a local folder). docs/WATCHER.md#sink-modes.
 *
 * One rsync run per deploy: the changed and deleted paths go in a
 * --files-from list; --delete-missing-args removes the deleted ones on the
 * receiver. Only paths ursa-server built are ever deleted — never anything
 * else in the target folder. Needs rsync >= 3.1 on both ends, and the target
 * folder must exist.
 */

import { spawn } from "child_process";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

/** @returns {import("../types.js").SinkAdapter} */
export function createRsyncSink(config, { rsyncPath = "rsync" } = {}) {
  let outputDir = null;

  function sshCommand() {
    const parts = ["ssh", "-o", "BatchMode=yes"];
    if (config.sshKey) parts.push("-i", config.sshKey, "-o", "IdentitiesOnly=yes");
    if (config.port) parts.push("-p", String(config.port));
    return parts.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ");
  }

  async function run(rels) {
    if (rels.length === 0) return;
    const dir = await mkdtemp(join(tmpdir(), "ursa-rsync-"));
    const list = join(dir, "files");
    try {
      await writeFile(list, rels.join("\0") + "\0");
      const args = [
        "-a", "--from0", `--files-from=${list}`, "--delete-missing-args",
        ...(/^[^/]*:/.test(config.target) ? ["-z", "-e", sshCommand()] : []),
        ...config.args,
        outputDir.replace(/\/*$/, "/"),
        config.target,
      ];
      await new Promise((resolve, reject) => {
        const p = spawn(rsyncPath, args, { stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`rsync exited ${code}: ${err.trim()}`))));
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return {
    id: `rsync:${config.target}`,
    inPlace: false,
    batched: true,
    async init({ output }) {
      outputDir = output;
    },
    /** Puts and deletes in one transfer: rsync decides by what exists locally. */
    async sync(rels) {
      await run(rels);
    },
    async list() {
      return null;
    },
    async commit() {
      return null;
    },
    describe: () => config.target,
  };
}
