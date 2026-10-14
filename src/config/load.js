/**
 * Load and validate the config (docs/CONFIG.md).
 *
 * - YAML or JSON. Keys may be kebab-case or camelCase.
 * - `${VAR}` and `${VAR:-default}` are substituted from the environment in
 *   every string. An unset variable with no default is an error.
 * - Relative paths resolve against the config file's folder (or the working
 *   directory, for a config built from flags).
 * - Unknown keys are warned about; wrong types are errors naming the key path.
 */

import { readFile } from "fs/promises";
import { dirname, extname } from "path";
import YAML from "yaml";
import { resolvePath } from "../util/paths.js";

export class ConfigError extends Error {}

const SOURCE_TYPES = ["fs", "s3", "dropbox", "gdrive"];
const SINK_TYPES = ["fs", "s3", "rsync"];
const PORT_MAX = 65535;

/**
 * @param {string|null} path - Config file; null to build one from flags alone
 * @param {object} [flags] - CLI overrides: `source`, `output`, `meta`, `port`,
 *   `host`, `stateDir`, `watch`, `serve`, `controlPort`
 * @param {{ env?: object, warn?: (msg: string) => void, cwd?: string }} [opts]
 */
export async function loadConfig(path, flags = {}, { env = process.env, warn = (m) => console.warn(m), cwd = process.cwd() } = {}) {
  let raw = {};
  let base = cwd;
  if (path) {
    const text = await readFile(path, "utf8");
    base = dirname(resolvePath(path, cwd));
    try {
      raw = extname(path) === ".json" ? JSON.parse(text) : YAML.parse(text);
    } catch (e) {
      throw new ConfigError(`${path}: ${e.message}`);
    }
    raw ??= {};
  }
  const substituted = substituteEnv(raw, env, "config");
  // auth.roles and auth.scopes are keyed by role names and emails: data, not option names
  const auth = substituted?.auth;
  raw = camelize(substituted);
  if (auth && typeof auth === "object") {
    raw.auth = { ...raw.auth, roles: auth.roles, scopes: auth.scopes };
  }
  return normalize(raw, flags, { base, cwd, warn });
}

/** Validate and fill defaults. Exported for tests and for programmatic use. */
export function normalize(raw, flags = {}, { base = process.cwd(), cwd = process.cwd(), warn = (m) => console.warn(m) } = {}) {
  const v = new Validator(warn);
  v.object(raw, "config", ["stateDir", "roles", "server", "control", "sites", "auth", "editor"]);

  const stateDir = resolvePath(flags.stateDir ?? v.string(raw.stateDir, "stateDir") ?? ".ursa-server", flags.stateDir ? cwd : base);

  const rolesRaw = raw.roles ?? {};
  v.object(rolesRaw, "roles", ["watch", "serve", "edit"]);
  const roles = {
    watch: flags.watch ?? v.boolean(rolesRaw.watch, "roles.watch") ?? true,
    serve: flags.serve ?? v.boolean(rolesRaw.serve, "roles.serve") ?? false,
    edit: flags.edit ?? v.boolean(rolesRaw.edit, "roles.edit") ?? false,
  };
  if (roles.edit && !roles.serve) throw new ConfigError("roles.edit needs roles.serve: the editor is part of the served site");

  const editorRaw = raw.editor ?? {};
  v.object(editorRaw, "editor", ["maxUploadMb"]);
  const editor = { maxUploadMb: v.integer(editorRaw.maxUploadMb, "editor.max-upload-mb") ?? 50 };

  const serverRaw = raw.server ?? {};
  v.object(serverRaw, "server", ["host", "port", "site", "access"]);
  const server = {
    host: flags.host ?? v.string(serverRaw.host, "server.host") ?? "127.0.0.1",
    port: flags.port ?? v.port(serverRaw.port, "server.port") ?? 8080,
    site: v.string(serverRaw.site, "server.site") ?? null,
    access: v.oneOf(serverRaw.access, "server.access", ["public", "viewer", "editor", "admin"]) ?? "public",
  };

  const controlRaw = raw.control ?? {};
  v.object(controlRaw, "control", ["host", "port", "socket", "token", "enabled"]);
  const control = {
    enabled: v.boolean(controlRaw.enabled, "control.enabled") ?? true,
    host: v.string(controlRaw.host, "control.host") ?? "127.0.0.1",
    port: flags.controlPort ?? v.port(controlRaw.port, "control.port") ?? 7071,
    socket: controlRaw.socket ? resolvePath(v.string(controlRaw.socket, "control.socket"), base) : null,
    token: v.string(controlRaw.token, "control.token") || null,
  };
  if (!control.token && !isLoopback(control.host)) {
    throw new ConfigError(`control.host is ${control.host}, which is reachable from other machines: set control.token`);
  }

  let sitesRaw = raw.sites;
  if (flags.source) {
    if (sitesRaw?.length) throw new ConfigError("--source cannot be combined with a config that defines sites");
    sitesRaw = [{
      id: "default",
      ursa: flags.meta ? { meta: flags.meta } : {},
      source: { type: "fs", path: flags.source },
      sink: { type: "fs", path: flags.output ?? "output" },
    }];
    // Flag paths are relative to where the command was typed
    base = cwd;
  }
  if (!Array.isArray(sitesRaw) || sitesRaw.length === 0) {
    throw new ConfigError("no sites configured: give a config file with `sites`, or --source");
  }
  const ids = new Set();
  const sites = sitesRaw.map((s, i) => {
    const site = normalizeSite(s, `sites[${i}]`, v, base);
    if (ids.has(site.id)) throw new ConfigError(`sites[${i}].id: duplicate id "${site.id}"`);
    ids.add(site.id);
    return site;
  });
  if (server.site && !ids.has(server.site)) throw new ConfigError(`server.site: no site "${server.site}"`);

  const auth = raw.auth ? normalizeAuth(raw.auth, server, v) : null;
  if (auth?.provider.type === "mock") {
    // Anyone who can reach a mock sign-in can be anyone
    const baseHost = new URL(auth.baseUrl).hostname;
    if (!isLoopback(server.host) || !isLoopback(baseHost)) {
      throw new ConfigError(`auth.provider.type mock lets anyone sign in as anyone: only on server.host 127.0.0.1 (and a localhost base-url), not ${isLoopback(server.host) ? auth.baseUrl : server.host}`);
    }
  }
  if (server.access !== "public" && !auth) {
    throw new ConfigError(`server.access is "${server.access}", which needs an \`auth\` section`);
  }
  if (auth && server.access === "public" && roles.serve && auth.provider.type !== "mock") {
    warn("config: auth is configured but server.access is public, so the site is served without sign-in");
  }

  if (roles.edit && !auth && !isLoopback(server.host)) {
    throw new ConfigError(`roles.edit on ${server.host} without \`auth\` would let anyone who can reach it change the site: add auth, or use server.host: 127.0.0.1`);
  }
  if (roles.edit) {
    const s = sites.find((x) => x.id === (server.site ?? sites[0].id));
    if (s.source.type !== "fs") throw new ConfigError(`roles.edit: editing a "${s.source.type}" source isn't supported yet (fs only)`);
  }

  return { stateDir, roles, server, control, sites, auth, editor };
}

const MIN_SECRET = 32;
// Mock sign-in is loopback-only and lets anyone in, so a fixed secret costs nothing
// and keeps test sessions across restarts
const MOCK_SECRET = "ursa-server mock sign-in, for local testing only";

function normalizeAuth(a, server, v) {
  v.object(a, "auth", ["baseUrl", "sessionSecret", "sessionDays", "provider", "roles", "scopes"]);
  const p = a.provider;
  if (!p) throw new ConfigError("auth.provider: required");
  const type = v.oneOf(p.type, "auth.provider.type", ["oidc", "mock"]) ?? "oidc";
  const mock = type === "mock";
  const secret = v.string(a.sessionSecret, "auth.session-secret") ?? (mock ? MOCK_SECRET : undefined);
  if (!secret || secret.length < MIN_SECRET) {
    throw new ConfigError(`auth.session-secret: required, at least ${MIN_SECRET} characters (e.g. \`openssl rand -base64 48\`)`);
  }
  v.object(p, "auth.provider", mock ? ["type"] : ["type", "preset", "issuer", "domain", "clientId", "clientSecret", "scope", "region", "userPoolId", "connection"]);
  const preset = v.oneOf(p.preset, "auth.provider.preset", ["auth0", "google", "cognito"]) ?? null;
  if (!mock && !preset && !p.issuer) throw new ConfigError("auth.provider: give `preset` (auth0, google, cognito) or `issuer`");
  if (preset === "auth0" && !p.domain) throw new ConfigError("auth.provider.domain: required for auth0 (e.g. your-tenant.us.auth0.com)");
  for (const k of mock ? [] : ["clientId", "clientSecret"]) {
    if (!v.string(p[k], `auth.provider.${kebab(k)}`)) throw new ConfigError(`auth.provider.${kebab(k)}: required`);
  }

  const rolesRaw = a.roles ?? {};
  v.object(rolesRaw, "auth.roles", ["viewer", "editor", "admin"]);
  const roleRules = {};
  for (const r of ["viewer", "editor", "admin"]) {
    // An entry may hold several rules separated by commas or spaces, so one
    // environment variable can carry a whole list
    roleRules[r] = (v.stringArray(rolesRaw[r], `auth.roles.${r}`) ?? []).flatMap((e) => e.split(/[\s,]+/)).filter(Boolean);
  }
  // (mock: everyone picks a role at sign-in)
  if (!mock && !Object.values(roleRules).some((l) => l.length)) {
    throw new ConfigError("auth.roles: nobody has a role, so nobody could sign in (e.g. admin: [you@example.com])");
  }

  const host = server.host === "0.0.0.0" || server.host === "::" ? "localhost" : server.host;
  const baseUrl = (v.string(a.baseUrl, "auth.base-url") ?? `http://${host}:${server.port}`).replace(/\/$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new ConfigError(`auth.base-url: expected an http(s) URL (got "${baseUrl}")`);

  return {
    baseUrl,
    sessionSecret: secret,
    sessionDays: v.integer(a.sessionDays, "auth.session-days") ?? 14,
    provider: { type, preset, issuer: p.issuer ?? null, domain: p.domain ?? null, clientId: p.clientId, clientSecret: p.clientSecret, scope: p.scope ?? null, region: p.region, userPoolId: p.userPoolId, connection: v.string(p.connection, "auth.provider.connection") ?? null },
    roles: roleRules,
    scopes: a.scopes ?? {},
  };
}

function normalizeSite(s, at, v, base) {
  v.object(s, at, ["id", "ursa", "source", "sink"]);
  const id = v.string(s.id, `${at}.id`) ?? "default";
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new ConfigError(`${at}.id: use letters, digits, - and _ ("${id}")`);

  const u = s.ursa ?? {};
  v.object(u, `${at}.ursa`, ["meta", "whitelist", "exclude", "jsonOnly", "directoryJson", "directoryDepth", "concurrency", "explain"]);
  const depth = u.directoryDepth;
  const ursa = {
    meta: u.meta ? resolvePath(v.string(u.meta, `${at}.ursa.meta`), base) : null,
    whitelist: u.whitelist ? resolvePath(v.string(u.whitelist, `${at}.ursa.whitelist`), base) : null,
    exclude: Array.isArray(u.exclude) ? u.exclude.join(",") : v.string(u.exclude, `${at}.ursa.exclude`) ?? null,
    jsonOnly: v.boolean(u.jsonOnly, `${at}.ursa.json-only`) ?? false,
    directoryJson: v.boolean(u.directoryJson, `${at}.ursa.directory-json`) ?? true,
    directoryDepth: depth === "infinite" || depth === -1 || depth == null ? Infinity : v.integer(depth, `${at}.ursa.directory-depth`),
    concurrency: v.integer(u.concurrency, `${at}.ursa.concurrency`) ?? undefined,
    explain: v.boolean(u.explain, `${at}.ursa.explain`) ?? false,
  };

  const source = normalizeSource(s.source, `${at}.source`, v, base);
  const sink = normalizeSink(s.sink ?? { type: "fs" }, `${at}.sink`, v, base);
  return { id, ursa, source, sink };
}

function normalizeSource(src, at, v, base) {
  if (!src) throw new ConfigError(`${at}: required`);
  const type = v.oneOf(src.type, at + ".type", SOURCE_TYPES) ?? "fs";
  if (type === "fs") {
    v.object(src, at, ["type", "path"]);
    const path = v.string(src.path, `${at}.path`);
    if (!path) throw new ConfigError(`${at}.path: required`);
    return { type, path: resolvePath(path, base) };
  }
  // Remote sources are validated by their adapters when implemented
  return { ...src, type };
}

function normalizeSink(sink, at, v, base) {
  const type = v.oneOf(sink.type, at + ".type", SINK_TYPES) ?? "fs";
  if (type === "fs") {
    v.object(sink, at, ["type", "path"]);
    return { type, path: sink.path ? resolvePath(v.string(sink.path, `${at}.path`), base) : null };
  }
  if (type === "s3") {
    v.object(sink, at, ["type", "bucket", "prefix", "region", "endpoint", "forcePathStyle", "credentials", "cacheControl", "cloudfront"]);
    const bucket = v.string(sink.bucket, `${at}.bucket`);
    if (!bucket) throw new ConfigError(`${at}.bucket: required`);
    const cf = sink.cloudfront ?? null;
    if (cf) {
      v.object(cf, `${at}.cloudfront`, ["distributionId", "maxPaths"]);
      if (!v.string(cf.distributionId, `${at}.cloudfront.distribution-id`)) throw new ConfigError(`${at}.cloudfront.distribution-id: required`);
      v.integer(cf.maxPaths, `${at}.cloudfront.max-paths`);
    }
    const cc = sink.cacheControl ?? {};
    v.object(cc, `${at}.cache-control`, ["html", "json", "assets"]);
    const creds = sink.credentials ?? null;
    if (creds) v.object(creds, `${at}.credentials`, ["accessKeyId", "secretAccessKey", "sessionToken", "profile"]);
    return {
      type,
      bucket,
      prefix: normalizePrefix(v.string(sink.prefix, `${at}.prefix`) ?? ""),
      region: v.string(sink.region, `${at}.region`) ?? null,
      endpoint: v.string(sink.endpoint, `${at}.endpoint`) ?? null,
      forcePathStyle: v.boolean(sink.forcePathStyle, `${at}.force-path-style`) ?? false,
      credentials: creds,
      cacheControl: {
        html: v.string(cc.html, `${at}.cache-control.html`) ?? "public, max-age=0, must-revalidate",
        json: v.string(cc.json, `${at}.cache-control.json`) ?? "public, max-age=0, must-revalidate",
        assets: v.string(cc.assets, `${at}.cache-control.assets`) ?? "public, max-age=3600",
      },
      cloudfront: cf ? { distributionId: cf.distributionId, maxPaths: cf.maxPaths ?? 25 } : null,
    };
  }
  // rsync
  v.object(sink, at, ["type", "target", "sshKey", "port", "args"]);
  const target = v.string(sink.target, `${at}.target`);
  if (!target) throw new ConfigError(`${at}.target: required`);
  const remote = /^[^/]*:/.test(target);
  return {
    type,
    target: remote ? target.replace(/\/*$/, "/") : resolvePath(target, base).replace(/\/*$/, "/"),
    sshKey: sink.sshKey ? resolvePath(v.string(sink.sshKey, `${at}.ssh-key`), base) : null,
    port: v.port(sink.port, `${at}.port`) ?? null,
    args: v.stringArray(sink.args, `${at}.args`) ?? [],
  };
}

function normalizePrefix(p) {
  p = p.replace(/^\/+/, "");
  return p && !p.endsWith("/") ? p + "/" : p;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}

// ---------------------------------------------------------------------------

class Validator {
  constructor(warn) {
    this.warn = warn;
  }
  object(o, at, known) {
    if (o == null) return;
    if (typeof o !== "object" || Array.isArray(o)) throw new ConfigError(`${at}: expected an object`);
    for (const k of Object.keys(o)) if (!known.includes(k)) this.warn(`config: unknown key ${at}.${kebab(k)} (ignored)`);
  }
  string(x, at) {
    if (x == null) return undefined;
    if (typeof x === "number") return String(x);
    if (typeof x !== "string") throw new ConfigError(`${at}: expected a string`);
    return x;
  }
  boolean(x, at) {
    if (x == null) return undefined;
    if (typeof x !== "boolean") throw new ConfigError(`${at}: expected true or false`);
    return x;
  }
  integer(x, at) {
    if (x == null) return undefined;
    if (!Number.isInteger(x)) throw new ConfigError(`${at}: expected an integer`);
    return x;
  }
  port(x, at) {
    const n = this.integer(x, at);
    if (n !== undefined && (n < 0 || n > PORT_MAX)) throw new ConfigError(`${at}: not a port number`);
    return n;
  }
  oneOf(x, at, values) {
    const s = this.string(x, at);
    if (s !== undefined && !values.includes(s)) throw new ConfigError(`${at}: one of ${values.join(", ")} (got "${s}")`);
    return s;
  }
  stringArray(x, at) {
    if (x == null) return undefined;
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new ConfigError(`${at}: expected a list of strings`);
    return x;
  }
}

/** `${VAR}` / `${VAR:-default}` in every string. */
function substituteEnv(value, env, at) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, dflt) => {
      if (env[name] != null && env[name] !== "") return env[name];
      if (dflt !== undefined) return dflt;
      throw new ConfigError(`${at}: environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map((x, i) => substituteEnv(x, env, `${at}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, substituteEnv(x, env, `${at}.${k}`)]));
  }
  return value;
}

/** kebab-case keys → camelCase, recursively (role and auth email lists are values, untouched). */
function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), camelize(x)]));
  }
  return value;
}

function kebab(k) {
  return k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
