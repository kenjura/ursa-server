/**
 * Deploy manifest: output path → content hash of what the sink holds.
 * Filters unchanged writes out of a deploy. docs/WATCHER.md#persistent-cache.
 */
export class DeployManifest {
  /** @param {string} file - path of deploy.json */
  constructor(file) {
    this.file = file;
    /** @type {Map<string, string>} */
    this.entries = new Map();
  }
}
