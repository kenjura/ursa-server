/**
 * Control API: /health, /status, /sites/:id/{status,events,rebuild,
 * cache/invalidate,sync,pause,resume,log,jobs/:id}. docs/CONTROL.md.
 *
 * @param {Map<string, object>} sites - site runtimes by id
 * @param {object} config - the `control` config block
 */
export async function startControlApi(sites, config) {
  throw new Error("not implemented");
}
