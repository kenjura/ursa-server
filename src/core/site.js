/**
 * Site runtime: source adapter → working copy → Ursa runPass() → staging
 * output → sink adapter. One batch at a time. docs/WATCHER.md.
 *
 * @param {object} siteConfig
 * @param {{ stateDir: string }} opts
 * @returns {Promise<{
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   status(): object,
 *   rebuild(opts?: { deploy?: "diff" | "all" }): Promise<string>,
 *   invalidate(opts: { scope: "graph" | "working-copy" | "manifest" | "all", paths?: string[] }): Promise<string>,
 *   sync(): Promise<string>,
 *   notifyChanged(paths: string[]): void,
 * }>}
 */
export async function createSite(siteConfig, { stateDir }) {
  throw new Error("not implemented");
}
