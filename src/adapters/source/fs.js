/**
 * `fs` source: a local folder. The folder is the working copy; changes come
 * from a recursive watch filtered as Ursa filters them (docs/WATCHER.md).
 */

import watch from "node-watch";

/**
 * @param {object} config - normalised `source` block ({ type: "fs", path })
 * @param {{ isIgnored: (absPath: string) => boolean, extraRoots?: string[] }} opts
 *   - extraRoots: further folders whose changes are build inputs (the meta folder)
 * @returns {import("../types.js").SourceAdapter}
 */
export function createFsSource(config, { isIgnored, extraRoots = [] }) {
  return {
    id: `fs:${config.path}`,
    workingCopy: config.path,
    async init() {},
    watch(onChanges) {
      const opts = { recursive: true, filter: (f, skip) => (isIgnored(f) ? skip : true) };
      const watchers = [config.path, ...extraRoots].map((root) => watch(root, opts, (evt, name) => onChanges([name])));
      return () => {
        for (const w of watchers) w.close();
      };
    },
    describe: () => config.path,
  };
}
