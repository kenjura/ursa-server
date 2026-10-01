/**
 * `fs` sink: the site is built straight into a local folder, so there is
 * nothing to deploy. docs/WATCHER.md#sink-modes.
 *
 * @returns {import("../types.js").SinkAdapter}
 */
export function createFsSink(config) {
  return {
    id: `fs:${config.path}`,
    inPlace: true,
    async init() {},
    async put() {},
    async remove() {},
    async list() {
      return null;
    },
    async commit() {},
    describe: () => config.path,
  };
}
