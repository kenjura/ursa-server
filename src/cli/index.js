/**
 * `ursa-server` CLI. `start` runs the server; every other command is one call
 * to the control API of a running server (docs/CONTROL.md).
 */

import { existsSync } from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, ConfigError } from "../config/load.js";
import { startServer, VERSION } from "../core/server.js";
import { createClient, readEvents, ClientError } from "./client.js";

const DEFAULT_CONFIGS = ["ursa-server.yml", "ursa-server.yaml", "ursa-server.json"];

/** @param {string[]} argv */
export async function main(argv) {
  const cli = yargs(argv)
    .scriptName("ursa-server")
    .version(VERSION)
    .strict()
    .demandCommand(1, "")
    .option("config", { alias: "c", type: "string", describe: "Config file (default: ./ursa-server.yml if present)" })
    .option("url", { type: "string", describe: "Control API URL [env URSA_SERVER_URL]" })
    .option("token", { type: "string", describe: "Control API token [env URSA_SERVER_TOKEN]" })
    .option("site", { type: "string", describe: "Site id, when the server has several" })
    .option("json", { type: "boolean", describe: "Print raw JSON" })

    .command(
      "start [config]",
      "Run the server",
      (y) => y
        .positional("config", { type: "string", describe: "Config file" })
        .option("source", { type: "string", describe: "Watch this folder (no config file needed)" })
        .option("output", { type: "string", describe: "With --source: build into this folder (default ./output)" })
        .option("meta", { type: "string", describe: "With --source: templates folder (default: Ursa's own)" })
        .option("serve", { type: "boolean", describe: "Serve the site with live reload" })
        .option("watch", { type: "boolean", describe: "Follow source changes (--no-watch builds once)" })
        .option("port", { type: "number", describe: "Dev server port" })
        .option("host", { type: "string", describe: "Dev server interface" })
        .option("control-port", { type: "number", describe: "Control API port" })
        .option("state-dir", { type: "string", describe: "Where caches and deploy state live" }),
      start,
    )
    .command("status", "Show what the server is doing", {}, run(status))
    .command(
      "rebuild",
      "Discard the build cache and rebuild everything",
      (y) => y
        .option("deploy", { choices: ["diff", "all"], default: "diff", describe: "diff: upload only files whose bytes changed; all: re-upload everything" })
        .option("wait", { type: "boolean", default: true, describe: "Wait for the rebuild to finish" }),
      run(async (c, a) => job(c, a, "/rebuild", { deploy: a.deploy })),
    )
    .command(
      "invalidate [scope] [paths..]",
      "Drop a cache (graph, working-copy, manifest, all)",
      (y) => y
        .positional("scope", { choices: ["graph", "working-copy", "manifest", "all"], default: "graph" })
        .positional("paths", { type: "string", array: true, describe: "Source paths, relative to the source root (graph only)" })
        .option("wait", { type: "boolean", default: true }),
      run(async (c, a) => job(c, a, "/cache/invalidate", { scope: a.scope, paths: a.paths ?? [] })),
    )
    .command(
      "sync",
      "Re-check every source file and make the sink match",
      (y) => y.option("wait", { type: "boolean", default: true }),
      run(async (c, a) => job(c, a, "/sync", {})),
    )
    .command("pause", "Stop building (changes are queued)", {}, run(async (c, a) => print(a, await c.post(sitePath(a) + "/pause"), summarize)))
    .command("resume", "Resume building", {}, run(async (c, a) => print(a, await c.post(sitePath(a) + "/resume"), summarize)))
    .command(
      "logs",
      "Show recent log lines",
      (y) => y.option("follow", { alias: "f", type: "boolean", describe: "Keep printing new lines" }),
      run(logs),
    )
    .help()
    .wrap(Math.min(110, process.stdout.columns ?? 80));

  try {
    await cli.parseAsync();
  } catch (e) {
    if (e instanceof ConfigError || e instanceof ClientError) {
      console.error(`ursa-server: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------

function configPath(a) {
  if (a.config) return a.config;
  return DEFAULT_CONFIGS.find((f) => existsSync(f)) ?? null;
}

async function start(a) {
  const path = a.source ? a.config ?? null : configPath(a);
  const config = await loadConfig(path, {
    source: a.source,
    output: a.output,
    meta: a.meta,
    serve: a.serve,
    watch: a.watch,
    port: a.port,
    host: a.host,
    controlPort: a.controlPort,
    stateDir: a.stateDir,
  });
  const server = await startServer(config);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) process.exit(1); // second Ctrl+C: don't wait
    stopping = true;
    console.log(`\n${signal}: finishing current work and stopping…`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

/** Wrap a client command: find the server from flags, env or the config file. */
function run(fn) {
  return async (a) => {
    let socket = null;
    let token = a.token ?? process.env.URSA_SERVER_TOKEN ?? null;
    let url = a.url ?? process.env.URSA_SERVER_URL ?? null;
    if (!url) {
      const path = configPath(a);
      if (path) {
        const config = await loadConfig(path, {}, { warn: () => {} });
        if (config.control.socket && existsSync(config.control.socket)) socket = config.control.socket;
        else url = `http://${config.control.host}:${config.control.port}`;
        token ??= config.control.token;
      }
    }
    await fn(createClient({ url, socket, token }), a);
  };
}

const sitePath = (a) => (a.site ? `/sites/${encodeURIComponent(a.site)}` : "");

async function status(c, a) {
  if (a.site) return print(a, await c.get(`${sitePath(a)}/status`), summarize);
  const all = await c.get("/status");
  if (a.json) return console.log(JSON.stringify(all, null, 2));
  console.log(`ursa-server ${all.version} at ${c.where}`);
  for (const s of all.sites) console.log("\n" + summarize(s));
}

async function job(c, a, path, body) {
  const accepted = await c.post(sitePath(a) + path, body);
  if (!a.wait) return print(a, accepted, (j) => `queued ${j.type} (job ${j.id})`);
  if (!a.json) console.log(`${accepted.type}: queued as ${accepted.id}, waiting…`);
  const done = await c.waitForJob(sitePath(a), accepted.id);
  print(a, done, (j) => `${j.type}: ${j.state}${j.error ? ` — ${j.error}` : ""}\n${describeResult(j.result)}`);
  if (done.state !== "done") process.exitCode = 1;
}

async function logs(c, a) {
  const lines = await c.get(`${sitePath(a)}/log`);
  for (const l of lines) console.log(formatLine(l));
  if (!a.follow) return;
  const res = await c.stream(`${sitePath(a)}/events`);
  await readEvents(res, (type, e) => {
    if (type === "log") console.log(formatLine(e));
  });
}

function formatLine(l) {
  return `${l.at.slice(11, 19)} ${l.site ? `[${l.site}] ` : ""}${l.level === "info" ? "" : l.level.toUpperCase() + " "}${l.message}`;
}

function print(a, data, human) {
  console.log(a.json ? JSON.stringify(data, null, 2) : human(data));
}

function summarize(s) {
  const lines = [
    `${s.id}: ${s.state}${s.paused ? " (paused)" : ""}`,
    `  source   ${s.source.type} ${s.source.location}`,
    `  sink     ${s.sink.type} ${s.sink.location}`,
  ];
  if (s.lastBatch) {
    const b = s.lastBatch;
    lines.push(`  last     ${b.label} at ${b.at}: ${b.changes} change(s), ${b.written} written, ${b.deleted} deleted, ${b.elapsed}ms${b.failures ? `, ${b.failures} FAILED` : ""}`);
  }
  if (s.lastDeploy) {
    const d = s.lastDeploy;
    lines.push(`  deploy   ${d.uploaded} uploaded, ${d.removed} removed, ${d.unchanged} unchanged${d.failed.length ? `, ${d.failed.length} failed` : ""}`);
  }
  if (s.backlog) {
    lines.push(`  backlog  ${s.backlog.pendingChanges} change(s), ${s.backlog.queuedJobs} job(s), ${s.backlog.undeployed} undeployed`);
  }
  if (s.cache) {
    const g = s.cache.graph;
    lines.push(`  cache    ${g ? `${g.derivedNodes} nodes, ${g.leaves} leaves, ${g.owned} outputs` : "(not loaded)"}${s.sink.inPlace ? "" : `; ${s.cache.deployedFiles} file(s) deployed`}`);
  }
  if (s.lastError) lines.push(`  error    ${s.lastError.message} (${s.lastError.at})`);
  return lines.join("\n");
}

function describeResult(r) {
  if (!r) return "";
  const parts = [];
  if (r.written != null) parts.push(`${r.written} written`);
  const d = r.deploy;
  if (d) parts.push(`deploy: ${d.uploaded} uploaded, ${d.removed} removed, ${d.unchanged} unchanged${d.failed?.length ? `, ${d.failed.length} failed` : ""}`);
  return parts.length ? "  " + parts.join("; ") : "";
}
