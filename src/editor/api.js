/**
 * Editor API, mounted at /edit/api (docs/EDITOR.md). Reads and writes the
 * site's source through its source adapter, so the watcher rebuilds edited
 * files like any other change.
 *
 *   GET    /me                      who you are and what you may change
 *   GET    /tree?dir=               one folder's entries
 *   GET    /file?path=              { path, hash, text | binary, size, url }
 *   GET    /raw?path=               the bytes (images in the editor)
 *   PUT    /file?path=              body = new content. Header If-Match: "<hash>"
 *                                   to replace, If-None-Match: * to create.
 *                                   412 + { current } if the file has moved on.
 *   DELETE /file?path=              If-Match required (files); folders must be empty
 *   POST   /move   { from, to }     rename; refuses to overwrite
 *   POST   /mkdir  { path }
 *   GET    /resolve?page=/url       { path } or { dir } for the page at that URL
 *
 * Every request needs the `editor` role (or `admin`), checked by the caller.
 * Changing requests also need `X-Ursa-Editor: 1`: a cross-site page can't
 * send that header without a CORS preflight, which this API never grants.
 */

import express from "express";
import mime from "mime-types";
import { cleanPath, mayWrite, scopesFor, BadPath } from "./paths.js";
import { PreconditionFailed } from "../adapters/source/fs.js";

const TEXT_EXTENSIONS = /\.(md|mdx|txt|ya?ml|json|css|js|mjs|html?|xml|svg|csv|tsv)$/i;

/**
 * @param {object} site - site runtime (createSite)
 * @param {{ scopes?: Record<string, string[]>, maxUploadBytes?: number, log?: (m: string) => void }} opts
 */
export function createEditorApi(site, { scopes = {}, maxUploadBytes = 50 * 1024 * 1024, log = () => {} } = {}) {
  const files = site.source.files;
  if (!files) throw new Error(`source type "${site.source.id}" can't be edited yet`);
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.method !== "GET" && req.get("x-ursa-editor") !== "1") {
      return res.status(403).json({ error: "missing X-Ursa-Editor header" });
    }
    next();
  });

  const who = (req) => req.user?.email ?? req.user?.sub ?? "local";
  const guardWrite = (req, rel) => {
    if (!mayWrite(req.user, rel, scopes)) {
      const e = new Error(`you can't change ${rel}`);
      e.status = 403;
      throw e;
    }
  };
  const ifMatch = (req) => (req.get("if-match") ?? "").replace(/^W\//, "").replace(/"/g, "").trim() || null;
  const changed = (...rels) => site.notifyChanged(rels.map((r) => files.absolute(r)));

  router.get("/me", (req, res) => {
    const u = req.user;
    res.json({
      site: site.id,
      user: u ? { name: u.name, email: u.email, roles: u.roles } : null,
      scopes: u ? scopesFor(u, scopes) : null,
    });
  });

  router.get("/tree", wrap(async (req, res) => {
    const dir = cleanPath(req.query.dir ?? "", { allowRoot: true });
    const entries = await files.list(dir);
    res.json({
      dir,
      // A folder is writable if something inside it may be changed
      entries: entries.map((e) => ({ ...e, writable: mayWrite(req.user, e.type === "dir" ? `${e.path}/x` : e.path, scopes) })),
    });
  }));

  router.get("/file", wrap(async (req, res) => {
    const rel = cleanPath(req.query.path);
    const f = await files.read(rel);
    if (!f) return res.status(404).json({ error: `${rel} doesn't exist` });
    const text = TEXT_EXTENSIONS.test(rel) && isUtf8(f.bytes);
    res.set("ETag", `"${f.hash}"`).json({
      path: rel,
      hash: f.hash,
      size: f.bytes.length,
      binary: !text,
      text: text ? f.bytes.toString("utf8") : null,
      url: site.pageUrl(rel),
      writable: mayWrite(req.user, rel, scopes),
    });
  }));

  router.get("/raw", wrap(async (req, res) => {
    const rel = cleanPath(req.query.path);
    const f = await files.read(rel);
    if (!f) return res.status(404).end();
    res.set("Content-Type", mime.contentType(rel.split("/").pop()) || "application/octet-stream");
    res.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.set("ETag", `"${f.hash}"`).send(f.bytes);
  }));

  router.put("/file", express.raw({ type: () => true, limit: maxUploadBytes }), wrap(async (req, res) => {
    const rel = cleanPath(req.query.path);
    guardWrite(req, rel);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const creating = req.get("if-none-match") === "*";
    const base = ifMatch(req);
    if (!creating && !base) return res.status(428).json({ error: "If-Match (the hash you started from) or If-None-Match: * is required" });
    const { hash } = await files.write(rel, body, { ifMatch: base, ifNoneMatch: creating });
    log(`✏️  ${who(req)} ${creating ? "created" : "saved"} ${rel}`);
    changed(rel);
    res.status(creating ? 201 : 200).set("ETag", `"${hash}"`).json({ path: rel, hash, url: site.pageUrl(rel) });
  }));

  router.delete("/file", wrap(async (req, res) => {
    const rel = cleanPath(req.query.path);
    guardWrite(req, rel);
    await files.remove(rel, { ifMatch: ifMatch(req) });
    log(`🗑  ${who(req)} deleted ${rel}`);
    changed(rel);
    res.status(204).end();
  }));

  router.post("/move", express.json(), wrap(async (req, res) => {
    const from = cleanPath(req.body?.from);
    const to = cleanPath(req.body?.to);
    guardWrite(req, from);
    guardWrite(req, to);
    await files.rename(from, to);
    log(`↪️  ${who(req)} moved ${from} → ${to}`);
    changed(from, to);
    res.json({ from, to });
  }));

  router.post("/mkdir", express.json(), wrap(async (req, res) => {
    const rel = cleanPath(req.body?.path);
    guardWrite(req, rel + "/x");
    await files.mkdir(rel);
    log(`📁 ${who(req)} created ${rel}/`);
    res.status(201).json({ path: rel });
  }));

  router.get("/resolve", (req, res) => {
    const page = typeof req.query.page === "string" ? req.query.page : "/";
    res.json(site.pageSource(page) ?? { path: null });
  });

  router.use((err, req, res, next) => {
    if (err instanceof BadPath) return res.status(400).json({ error: err.message });
    if (err instanceof PreconditionFailed) return res.status(412).json({ error: err.message, current: err.current });
    if (err.type === "entity.too.large") return res.status(413).json({ error: `larger than ${Math.round(maxUploadBytes / 1048576)} MB` });
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (err.code === "ENOENT") return res.status(404).json({ error: "not found" });
    if (err.code === "ENOTDIR") return res.status(400).json({ error: "not a folder" });
    log(`editor error: ${err.stack ?? err.message}`);
    res.status(500).json({ error: err.message });
  });

  return router;
}

function wrap(fn) {
  return (req, res, next) => fn(req, res).catch(next);
}

function isUtf8(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}
