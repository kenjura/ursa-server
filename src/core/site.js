/**
 * Site runtime: source → working copy → Ursa pass → staging output → sink.
 * docs/WATCHER.md.
 *
 * One loop per site does all the work, one thing at a time (Ursa's single
 * writer rule): a batch of source changes, or a job from the control API
 * (rebuild, invalidate, sync, retry). Changes that arrive meanwhile wait for
 * the next turn; nothing is dropped.
 */

import { EventEmitter } from "events";
import { join, resolve, dirname } from "path";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { createBuild, createIgnoreFilter } from "@kenjura/ursa/build";
import { sources, sinks } from "../adapters/index.js";
import { DeployManifest } from "./manifest.js";
import { deploy, reconcile } from "./deploy.js";
import { createLogger } from "../util/log.js";
import { isInside } from "../util/paths.js";

const DEBOUNCE_QUIET_MS = 500;
const DEBOUNCE_MAX_MS = 2000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** Ursa's bundled templates, used when a site does not name its own meta folder. */
export function defaultMetaDir() {
  return join(dirname(fileURLToPath(import.meta.resolve("@kenjura/ursa/package.json"))), "meta");
}

/**
 * @param {object} config - one normalised entry of `sites`
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {boolean} [opts.watch] - follow source changes (default true); false builds once
 * @param {object} [opts.adapters] - { source, sink } instances to use instead of the configured ones (tests)
 * @param {(line: string) => void} [opts.print]
 */
export async function createSite(config, { stateDir, watch = true, adapters = {}, print } = {}) {
  const { id } = config;
  const events = new EventEmitter();
  const log = createLogger({ prefix: id, print, onLine: (entry) => events.emit("event", { type: "log", site: id, ...entry }) });

  const dir = join(stateDir, "sites", id);
  const cacheDir = join(dir, "cache");
  const meta = config.ursa.meta ?? defaultMetaDir();

  const sink = adapters.sink ?? sinks[config.sink.type](config.sink);
  const output = sink.inPlace && config.sink.path ? config.sink.path : join(dir, "out");

  const isIgnored = (() => {
    const base = createIgnoreFilter({ source: config.source.path ?? "", output, cacheDir });
    const state = resolve(stateDir);
    return (p) => base(p) || isInside(p, state);
  })();
  const source = adapters.source ?? sources[config.source.type](config.source, { isIgnored, extraRoots: [meta] });
  const workingCopy = source.workingCopy;
  if (isInside(output, workingCopy)) log.warn(`output ${output} is inside the source; it is ignored as an input, but consider moving it`);

  const manifest = new DeployManifest(join(dir, "deploy.json"));
  const ctx = () => ({ sink, manifest, output });

  // ---- state ---------------------------------------------------------------

  let build = null;
  let devServer = null;
  let stopWatching = null;
  let pending = new Set(); // absolute paths changed since the last batch
  let quietTimer = null;
  let maxTimer = null;
  let batchFirstEventAt = 0;
  const jobs = []; // queued jobs, run before the next batch
  const jobIndex = new Map(); // id → job record (recent)
  let jobSeq = 0;
  let running = false;
  let paused = false;
  let closing = false;
  let retryTimer = null;
  let retryDelay = RETRY_MIN_MS;

  const status = {
    id,
    state: "starting",
    paused: false,
    startedAt: new Date().toISOString(),
    source: { type: config.source.type, location: source.describe() },
    sink: { type: config.sink.type, location: sink.describe(), inPlace: sink.inPlace },
    output,
    passes: 0,
    lastBatch: null,
    lastDeploy: null,
    lastError: null,
  };

  function setState(state) {
    status.state = state;
    events.emit("event", { type: "state", site: id, state });
  }

  // ---- build ---------------------------------------------------------------

  async function openBuild({ clean = false } = {}) {
    if (build) await build.close();
    build = null;
    await mkdir(output, { recursive: true });
    build = await createBuild({
      source: workingCopy,
      meta,
      output,
      cacheDir,
      clean,
      whitelist: config.ursa.whitelist,
      exclude: config.ursa.exclude,
      jsonOnly: config.ursa.jsonOnly,
      explain: config.ursa.explain,
      directoryJson: config.ursa.directoryJson,
      directoryDepth: config.ursa.directoryDepth,
      concurrency: config.ursa.concurrency,
      log: (m) => log.info(m),
    });
  }

  async function pass(passOpts = {}) {
    setState("building");
    const summary = devServer ? await devServer.runPass(build, passOpts) : await build.runPass(passOpts);
    status.passes++;
    if (summary.failures.size > 0) {
      const [first, err] = summary.failures.entries().next().value;
      log.error(`${summary.failures.size} output(s) failed to build; first: ${first}: ${err.cause?.message ?? err.message}`);
    }
    return summary;
  }

  async function deployChanges(changed, how = {}) {
    if (sink.inPlace) return null;
    setState("deploying");
    const t0 = Date.now();
    const result = how.reconcile ? await reconcile(ctx(), { useSinkListing: how.useSinkListing }) : await deploy(ctx(), changed);
    const summary = { ...result, at: new Date().toISOString(), elapsed: Date.now() - t0 };
    status.lastDeploy = summary;
    if (result.uploaded || result.removed || result.failed.length) {
      log.info(`⬆  Deployed to ${sink.describe()}: ${result.uploaded} uploaded, ${result.removed} removed, ${result.unchanged} unchanged${result.failed.length ? `, ${result.failed.length} FAILED` : ""} (${summary.elapsed}ms)`);
    }
    if (result.invalidated) log.info(`   CDN invalidated: ${result.invalidated.slice(0, 5).join(", ")}${result.invalidated.length > 5 ? ", …" : ""}`);
    if (result.commitError) log.error(`CDN invalidation failed: ${result.commitError}`);
    for (const f of result.failed.slice(0, 5)) log.error(`deploy ${f.path}: ${f.error}`);
    events.emit("event", { type: "deploy", site: id, ...summary, failed: result.failed.length });
    scheduleRetry();
    return summary;
  }

  /** Pass, then deploy what it wrote and deleted. */
  async function passAndDeploy(passOpts, label, changes = 0) {
    const startedAt = Date.now();
    events.emit("event", { type: "batch-start", site: id, label, changes });
    const summary = await pass(passOpts);
    const changed = new Set([...summary.writtenPaths, ...summary.deletedPaths]);
    const deployed = await deployChanges(changed);
    status.lastBatch = {
      label,
      at: new Date(startedAt).toISOString(),
      changes,
      written: summary.written,
      deleted: summary.deleted,
      failures: summary.failures.size,
      buildMs: summary.elapsed,
      elapsed: Date.now() - startedAt,
    };
    events.emit("event", { type: "batch-end", site: id, ...status.lastBatch, deploy: deployed });
    return { summary, deployed };
  }

  // ---- retries -------------------------------------------------------------

  function scheduleRetry() {
    if (retryTimer || closing) return;
    if (manifest.pending.size === 0) {
      retryDelay = RETRY_MIN_MS;
      return;
    }
    log.warn(`${manifest.pending.size} path(s) not deployed; retrying in ${Math.round(retryDelay / 1000)}s`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      enqueue("retry");
    }, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  // ---- jobs ----------------------------------------------------------------

  const JOBS = {
    /** Discard the build cache and rebuild everything; deploy only what differs (or all). */
    async rebuild({ deploy: mode = "diff" } = {}) {
      log.info(`♻️  Full rebuild (deploy: ${mode})`);
      await openBuild({ clean: true });
      const summary = await pass({ rescan: true });
      if (mode === "all") manifest.clear();
      // A clean build empties the output without reporting what it removed
      const deployed = await deployChanges(null, { reconcile: true });
      return { written: summary.written, failures: summary.failures.size, deploy: deployed };
    },

    /**
     * scope "graph": the build cache (paths given: just those sources);
     * "working-copy": the local copy of a remote source; "manifest": what we
     * believe the sink holds; "all": everything.
     */
    async invalidate({ scope = "graph", paths = [] } = {}) {
      if (!["graph", "working-copy", "manifest", "all"].includes(scope)) throw new Error(`unknown scope "${scope}"`);
      if (scope === "graph" && paths.length > 0) {
        const abs = paths.map((p) => resolve(workingCopy, p));
        for (const p of abs) if (!isInside(p, workingCopy)) throw new Error(`${p} is outside the source`);
        log.info(`Invalidating ${abs.length} path(s)`);
        build.invalidate(abs);
        const { summary, deployed } = await passAndDeploy({}, "invalidate", abs.length);
        return { written: summary.written, deploy: deployed };
      }
      if (scope === "working-copy") {
        if (source.refresh) await source.refresh();
        return JOBS.sync();
      }
      if (scope === "manifest") {
        log.info("Discarding the deploy manifest; reconciling with the sink");
        manifest.clear();
        return { deploy: await deployChanges(null, { reconcile: true, useSinkListing: true }) };
      }
      if (scope === "all") {
        if (source.refresh) await source.refresh();
        manifest.clear();
        return JOBS.rebuild({ deploy: "diff" });
      }
      return JOBS.rebuild({ deploy: "diff" }); // graph, no paths
    },

    /** Re-check every source file (for missed events), then make sure the sink matches. */
    async sync() {
      if (source.refresh) await source.refresh();
      const { summary } = await passAndDeploy({ rescan: true }, "sync");
      const deployed = await deployChanges(null, { reconcile: true });
      return { written: summary.written, deploy: deployed };
    },

    async retry() {
      return { deploy: await deployChanges([]) };
    },
  };

  /**
   * Queue a job. Returns its record immediately; `done` settles when it has run.
   * @returns {{ id: string, type: string, state: string, done: Promise<object> }}
   */
  function enqueue(type, opts = {}) {
    if (!JOBS[type]) throw new Error(`unknown job "${type}"`);
    const job = { id: `${id}-${++jobSeq}`, type, opts, state: "queued", createdAt: new Date().toISOString(), result: null, error: null };
    job.done = new Promise((r) => (job.settle = r));
    jobs.push(job);
    jobIndex.set(job.id, job);
    if (jobIndex.size > 100) jobIndex.delete(jobIndex.keys().next().value);
    kick();
    return job;
  }

  // ---- the loop ------------------------------------------------------------

  function queueChange(absPaths) {
    if (closing) return;
    for (const p of absPaths) {
      if (isIgnored(p)) continue;
      if (pending.size === 0 && !running) {
        batchFirstEventAt = Date.now();
        devServer?.notifyUpdateStart();
      }
      pending.add(p);
    }
    if (pending.size === 0) return;
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(startBatch, DEBOUNCE_QUIET_MS);
    if (!maxTimer) maxTimer = setTimeout(startBatch, DEBOUNCE_MAX_MS);
  }

  function startBatch() {
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    quietTimer = maxTimer = null;
    kick();
  }

  function kick() {
    if (!running && build) setImmediate(loop);
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      while (!closing) {
        if (jobs.length > 0) {
          const job = jobs.shift();
          await runJob(job);
          continue;
        }
        if (pending.size > 0 && !paused && !quietTimer) {
          const paths = [...pending];
          pending = new Set();
          log.info(`🔄 ${paths.length} change(s) after ${Date.now() - batchFirstEventAt}ms: ${paths.slice(0, 5).map((p) => p.replace(workingCopy + "/", "")).join(", ")}${paths.length > 5 ? ", …" : ""}`);
          try {
            build.invalidate(paths);
            await passAndDeploy({}, "changes", paths.length);
            status.lastError = null;
          } catch (e) {
            fail(e);
            devServer?.notifyNoAffect();
          }
          continue;
        }
        break;
      }
    } finally {
      running = false;
      setState(paused ? "paused" : status.lastError ? "error" : "idle");
    }
  }

  async function runJob(job) {
    job.state = "running";
    job.startedAt = new Date().toISOString();
    events.emit("event", { type: "job-start", site: id, job: publicJob(job) });
    try {
      job.result = await JOBS[job.type](job.opts);
      job.state = "done";
      status.lastError = null;
    } catch (e) {
      job.state = "failed";
      job.error = e.message;
      fail(e);
    }
    job.finishedAt = new Date().toISOString();
    events.emit("event", { type: "job-end", site: id, job: publicJob(job) });
    job.settle(publicJob(job));
  }

  function fail(e) {
    status.lastError = { message: e.message, at: new Date().toISOString() };
    log.error(e.stack ?? e.message);
  }

  // ---- public --------------------------------------------------------------

  return {
    id,
    events,
    log,
    get output() {
      return output;
    },
    get workingCopy() {
      return workingCopy;
    },

    /** Route passes through a dev server so browsers are told when to reload. */
    attachDevServer(dev) {
      devServer = dev;
    },

    /**
     * Warm (or cold) start: load caches, build, make the sink match the
     * output, then follow source changes.
     */
    async start() {
      await mkdir(dir, { recursive: true });
      await manifest.load();
      const sinkChanged = manifest.loaded && manifest.sinkId !== sink.id;
      if (sinkChanged) {
        log.warn(`Sink changed (${manifest.sinkId} → ${sink.id}); discarding the deploy manifest`);
        manifest.clear();
      }
      const firstDeploy = !manifest.loaded || sinkChanged;
      manifest.sinkId = sink.id;
      await sink.init({ output });
      await source.init();
      await openBuild();

      log.info(`Source: ${source.describe()}`);
      log.info(`Sink:   ${sink.describe()}${sink.inPlace ? "" : ` (staging in ${output})`}`);

      running = true;
      try {
        const { summary } = await passAndDeploy({}, "startup");
        // Catch anything built but not deployed before the last shutdown, and on
        // a first deploy, find out what the sink already holds
        if (!sink.inPlace) await deployChanges(null, { reconcile: true, useSinkListing: firstDeploy });
        log.info(`✅ Ready: ${summary.written} written, ${summary.deleted} deleted in ${summary.elapsed}ms`);
      } catch (e) {
        fail(e);
      } finally {
        running = false;
      }
      if (watch) stopWatching = source.watch((paths) => queueChange(paths));
      setState(status.lastError ? "error" : "idle");
      kick();
    },

    /** Mark source paths (absolute) as changed, as a watcher event would. */
    notifyChanged(absPaths) {
      queueChange(absPaths);
    },

    enqueue,
    rebuild: (opts) => enqueue("rebuild", opts),
    invalidate: (opts) => enqueue("invalidate", opts),
    sync: () => enqueue("sync"),
    job: (jobId) => (jobIndex.has(jobId) ? publicJob(jobIndex.get(jobId)) : null),

    pause() {
      paused = true;
      status.paused = true;
      if (!running) setState("paused");
      log.info("⏸  Paused: changes are queued, not built");
    },
    resume() {
      paused = false;
      status.paused = false;
      log.info("▶️  Resumed");
      if (!running) setState("idle");
      kick();
    },

    status() {
      const g = build?.graph?.getStats?.() ?? null;
      return {
        ...status,
        backlog: {
          pendingChanges: pending.size,
          queuedJobs: jobs.length,
          undeployed: manifest.pending.size,
        },
        cache: {
          graph: g,
          deployedFiles: manifest.entries.size,
        },
        jobs: [...jobIndex.values()].slice(-10).map(publicJob),
      };
    },

    /** Stop watching, let the current work finish, release resources. */
    async close() {
      closing = true;
      stopWatching?.();
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      clearTimeout(retryTimer);
      for (let i = 0; running && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
      for (const job of jobs.splice(0)) {
        job.state = "cancelled";
        job.settle(publicJob(job));
      }
      await manifest.save().catch(() => {});
      await build?.close();
      setState("stopped");
    },
  };
}

function publicJob(job) {
  const { id, type, opts, state, createdAt, startedAt, finishedAt, result, error } = job;
  return { id, type, opts, state, createdAt, startedAt, finishedAt, result, error };
}
