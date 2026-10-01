/**
 * Control API client for the CLI (docs/CONTROL.md). Talks HTTP over TCP or a
 * Unix socket.
 */

import { request } from "http";
import { request as httpsRequest } from "https";

export class ClientError extends Error {}

/**
 * @param {{ url?: string, socket?: string, token?: string }} target
 */
export function createClient({ url = null, socket = null, token = null }) {
  const base = socket ? null : new URL(url ?? "http://127.0.0.1:7071");
  const where = socket ? `socket ${socket}` : base.origin;

  function call(method, path, body, { stream = false } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: stream ? "text/event-stream" : "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const payload = body === undefined ? null : JSON.stringify(body);
      if (payload) headers["Content-Type"] = "application/json";
      const opts = socket
        ? { socketPath: socket, path, method, headers }
        : { hostname: base.hostname, port: base.port, path: base.pathname.replace(/\/$/, "") + path, method, headers };
      const req = (base?.protocol === "https:" ? httpsRequest : request)(opts, (res) => {
        if (stream && res.statusCode === 200) return resolve(res);
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { error: text };
          }
          if (res.statusCode >= 400) reject(new ClientError(data?.error ?? `HTTP ${res.statusCode}`));
          else resolve(data);
        });
      });
      req.on("error", (e) => reject(new ClientError(`cannot reach ursa-server at ${where}: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    where,
    get: (path) => call("GET", path),
    post: (path, body = {}) => call("POST", path, body),
    stream: (path) => call("GET", path, undefined, { stream: true }),

    /** Poll a job until it finishes. */
    async waitForJob(sitePath, jobId, { interval = 500 } = {}) {
      for (;;) {
        const job = await call("GET", `${sitePath}/jobs/${encodeURIComponent(jobId)}`);
        if (job.state !== "queued" && job.state !== "running") return job;
        await new Promise((r) => setTimeout(r, interval));
      }
    },
  };
}

/** Parse a server-sent event stream, calling `onEvent(type, data)` per event. */
export function readEvents(res, onEvent) {
  let buf = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let type = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) type = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) onEvent(type, JSON.parse(data));
    }
  });
  return new Promise((resolve) => res.on("end", resolve));
}
