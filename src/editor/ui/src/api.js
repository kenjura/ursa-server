// Client for /edit/api (src/editor/api.js).

const BASE = new URL("api/", document.baseURI).pathname;

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, { query, body, headers = {}, raw = false } = {}) {
  const url = new URL(BASE + path, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, v);
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (method !== "GET") init.headers["X-Ursa-Editor"] = "1";
  if (body !== undefined) {
    if (body instanceof Blob || typeof body === "string" || body instanceof ArrayBuffer) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
  }
  const res = await fetch(url, init);
  if (res.status === 401) {
    // Session ended: sign in again and come back here
    location.href = `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, { error: "signed out" });
  }
  if (raw) return res;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  me: () => call("GET", "me"),
  tree: (dir = "") => call("GET", "tree", { query: { dir } }),
  file: (path) => call("GET", "file", { query: { path } }),
  rawUrl: (path) => `${BASE}raw?path=${encodeURIComponent(path)}`,
  resolve: (page) => call("GET", "resolve", { query: { page } }),
  save: (path, content, hash) =>
    call("PUT", "file", { query: { path }, body: content, headers: { "If-Match": `"${hash}"`, "Content-Type": "text/plain; charset=utf-8" } }),
  create: (path, content, type = "text/plain; charset=utf-8") =>
    call("PUT", "file", { query: { path }, body: content, headers: { "If-None-Match": "*", "Content-Type": type } }),
  remove: (path, hash) => call("DELETE", "file", { query: { path }, headers: hash ? { "If-Match": `"${hash}"` } : {} }),
  move: (from, to) => call("POST", "move", { body: { from, to } }),
  mkdir: (path) => call("POST", "mkdir", { body: { path } }),
};
