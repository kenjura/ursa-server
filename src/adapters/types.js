/**
 * Adapter contracts. docs/WATCHER.md#adapters.
 *
 * Paths are POSIX and relative to the source/sink root.
 */

/**
 * A source keeps a local folder (the working copy) equal to wherever the
 * site's files live, and reports changes in it. For `fs` the working copy is
 * the source itself.
 *
 * @typedef {object} SourceAdapter
 * @property {string} id
 * @property {string} workingCopy - absolute path Ursa builds from
 * @property {() => Promise<void>} init - restore cursor, bring the working copy up to date
 * @property {(onChanges: (absPaths: string[]) => void) => () => void} watch - returns stop()
 * @property {() => Promise<void>} [refresh] - full rescan of the remote into the working copy
 * @property {() => string} describe
 */

/**
 * A sink receives the built site. Either `put`/`remove` per file, or (when
 * `batched`) one `sync` per deploy that decides by what exists locally.
 *
 * @typedef {object} SinkAdapter
 * @property {string} id - identifies the destination; a changed id discards the deploy manifest
 * @property {boolean} inPlace - the site is built straight into the destination; nothing to deploy
 * @property {boolean} [batched]
 * @property {(ctx: { output: string }) => Promise<void>} init
 * @property {(rel: string, absPath: string) => Promise<void>} [put]
 * @property {(rels: string[]) => Promise<void>} [remove]
 * @property {(rels: string[]) => Promise<void>} [sync]
 * @property {() => Promise<Map<string, string> | null>} list - path → MD5 the destination holds, if it can tell
 * @property {(changedRels: string[]) => Promise<string[] | null>} commit - after a deploy (CDN invalidation)
 * @property {() => string} describe
 */

export {};
