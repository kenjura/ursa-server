/**
 * Adapter contracts. docs/WATCHER.md#adapters.
 *
 * Paths are POSIX and relative to the source/sink root.
 */

/**
 * @typedef {object} SourceEntry
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} mtime
 */

/**
 * @typedef {object} SourceAdapter
 * @property {string} id
 * @property {{ push: boolean, conditionalWrite: boolean, rename: boolean }} capabilities
 * @property {(state: object | null) => Promise<void>} init - restore cursor
 * @property {() => Promise<SourceEntry[]>} list
 * @property {(path: string) => Promise<Buffer>} read
 * @property {(path: string, bytes: Buffer, opts?: { ifMatch?: string }) => Promise<SourceEntry>} write
 * @property {(path: string, opts?: { ifMatch?: string }) => Promise<void>} remove
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(onChanges: (events: { path: string }[]) => void) => () => void} watch - returns stop()
 * @property {() => Promise<object>} cursor - serialisable position for source.json
 */

/**
 * @typedef {object} SinkAdapter
 * @property {string} id
 * @property {() => Promise<void>} init
 * @property {(path: string, bytes: Buffer, opts: { contentType: string, cacheControl?: string }) => Promise<void>} put
 * @property {(path: string) => Promise<void>} remove
 * @property {() => Promise<{ path: string, hash: string }[]>} list
 * @property {(changedPaths: string[]) => Promise<void>} commit - e.g. CDN invalidation
 */

export {};
