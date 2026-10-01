/**
 * Control API (docs/CONTROL.md): status, rebuild, cache invalidation, sync,
 * pause/resume, logs and an event stream, per site.
 *
 * Served on TCP (default 127.0.0.1:7071) and optionally a Unix socket. With a
 * token configured, every TCP request must carry it; the socket is trusted
 * (its file permissions are the access control).
 */

import express from "express";
import { createServer } from "http";
import { existsSync } from "fs";
import { unlink, chmod } from "fs/promises";
import { timingSafeEqual } from "crypto";

/**
 * @param {Map<string, object>} sites - site runtimes by id
 * @param {{ token?: string|null, trusted?: boolean, version?: string }} opts
 */
export function createControlApp(sites, { token = null, trusted = false, version = null } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (trusted || !token) return next();
    const given = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (given && safeEqual(given, token)) return next();
    res.status(401).json({ error: "missing or wrong token" });
  });

  const only = sites.size === 1 ? [...sites.values()][0] : null;
  const site = (req, res) => {
    const s = req.params.id ? sites.get(req.params.id) : only;
    if (!s) {
      res.status(404).json({ error: req.params.id ? `no site "${req.params.id}"` : `several sites: use /sites/:id/… (${[...sites.keys()].join(", ")})` });
      return null;
    }
    return s;
  };

  app.get("/status", (req, res) => {
    res.json({ version, sites: [...sites.values()].map((s) => s.status()) });
  });

  // Every site route also works without /sites/:id when there is one site
  const routes = express.Router({ mergeParams: true });

  routes.get("/status", (req, res) => {
    const s = site(req, res);
    if (s) res.json(s.status());
  });

  routes.post("/rebuild", (req, res) => {
    const s = site(req, res);
    if (!s) return;
    const mode = req.body?.deploy ?? "diff";
    if (!["diff", "all"].includes(mode)) return res.status(400).json({ error: 'deploy must be "diff" or "all"' });
    accepted(res, s.rebuild({ deploy: mode }));
  });

  routes.post("/cache/invalidate", (req, res) => {
    const s = site(req, res);
    if (!s) return;
    const { scope = "graph", paths = [] } = req.body ?? {};
    if (!["graph", "working-copy", "manifest", "all"].includes(scope)) return res.status(400).json({ error: "scope must be graph, working-copy, manifest or all" });
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) return res.status(400).json({ error: "paths must be a list of strings" });
    accepted(res, s.invalidate({ scope, paths }));
  });

  routes.post("/sync", (req, res) => {
    const s = site(req, res);
    if (s) accepted(res, s.sync());
  });

  routes.post("/pause", (req, res) => {
    const s = site(req, res);
    if (!s) return;
    s.pause();
    res.json(s.status());
  });

  routes.post("/resume", (req, res) => {
    const s = site(req, res);
    if (!s) return;
    s.resume();
    res.json(s.status());
  });

  routes.get("/jobs/:jobId", async (req, res) => {
    const s = site(req, res);
    if (!s) return;
    const job = s.job(req.params.jobId);
    if (!job) return res.status(404).json({ error: "no such job (only the last 100 are kept)" });
    res.json(job);
  });

  routes.get("/log", (req, res) => {
    const s = site(req, res);
    if (s) res.json(s.log.since(Number(req.query.since ?? 0)));
  });

  routes.get("/events", (req, res) => {
    const s = site(req, res);
    if (s) stream(req, res, [s]);
  });

  app.use("/sites/:id", routes);
  app.get("/events", (req, res) => stream(req, res, [...sites.values()]));
  app.use("/", routes);

  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

function accepted(res, job) {
  res.status(202).json({ id: job.id, type: job.type, state: job.state });
}

/** Server-sent events from the given sites until the client goes away. */
function stream(req, res, siteList) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const listener = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  for (const s of siteList) s.events.on("event", listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    for (const s of siteList) s.events.off("event", listener);
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Listen on TCP and, if configured, a Unix socket.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startControlApi(sites, config, { version = null, log = console.log } = {}) {
  const servers = [];
  const tcp = createServer(createControlApp(sites, { token: config.token, version }));
  await listen(tcp, config.port, config.host);
  servers.push(tcp);
  const port = tcp.address().port;
  log(`🎛  Control API on http://${config.host}:${port}${config.token ? " (token required)" : ""}`);

  if (config.socket) {
    if (existsSync(config.socket)) await unlink(config.socket);
    const sock = createServer(createControlApp(sites, { trusted: true, version }));
    await listen(sock, config.socket);
    await chmod(config.socket, 0o600);
    servers.push(sock);
    log(`🎛  Control socket at ${config.socket}`);
  }

  return {
    port,
    async close() {
      await Promise.all(servers.map((s) => new Promise((r) => {
        s.closeAllConnections?.();
        s.close(() => r());
      })));
      if (config.socket) await unlink(config.socket).catch(() => {});
    },
  };
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
