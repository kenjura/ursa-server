import { createHash } from "crypto";
import { createReadStream } from "fs";
import { readdir } from "fs/promises";
import { join, relative } from "path";

/**
 * MD5 of a file, hex. MD5 because it is what S3 reports as the ETag of an
 * object uploaded in one part, so a manifest can be checked against a bucket
 * listing without downloading anything.
 */
export function md5File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("md5");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Every file under `root`, as POSIX paths relative to it. */
export async function listFiles(root) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  await walk(root);
  return out.sort();
}
