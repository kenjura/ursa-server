/**
 * Editor path rules: what a request may name, and what a user may change.
 */

/**
 * Normalise a client-supplied source path, or throw. Accepts "a/b.md",
 * "/a/b.md"; refuses "..", empty segments' tricks, backslashes, NUL, and
 * dot-files (never build inputs; also keeps .git and .env out of reach).
 * @param {string} p
 * @param {{ allowRoot?: boolean }} [opts]
 */
export function cleanPath(p, { allowRoot = false } = {}) {
  if (typeof p !== "string") throw new BadPath("path is required");
  if (/[\\\0]/.test(p)) throw new BadPath("invalid characters in path");
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  for (const s of parts) {
    if (s === "..") throw new BadPath("path may not contain ..");
    if (s.startsWith(".")) throw new BadPath("hidden files and folders can't be edited");
  }
  const clean = parts.join("/");
  if (!clean && !allowRoot) throw new BadPath("path is required");
  return clean;
}

export class BadPath extends Error {}

/**
 * Whether a user may change `rel`. Admins may change anything; an editor
 * whose identity has `auth.scopes` entries only paths matching one of them.
 * @param {{ roles: string[], email?: string, sub: string }} user
 * @param {Record<string, string[]>} scopes - identity (email or sub) → globs
 */
export function mayWrite(user, rel, scopes = {}) {
  if (!user) return false;
  if (user.roles.includes("admin")) return true;
  if (!user.roles.includes("editor")) return false;
  const globs = scopesFor(user, scopes);
  return globs === null || globs.some((g) => globMatch(g, rel));
}

/** The globs limiting a user, or null if unlimited. */
export function scopesFor(user, scopes = {}) {
  const keys = [user.sub, user.email?.toLowerCase()].filter(Boolean);
  for (const [k, globs] of Object.entries(scopes)) {
    if (keys.includes(k) || keys.includes(k.toLowerCase())) return [].concat(globs);
  }
  return null;
}

/** `**` any number of segments, `*` within a segment, `?` one character. */
export function globMatch(glob, path) {
  const re = glob
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
    .join("/")
    .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
  return new RegExp(`^${re}$`).test(path);
}
