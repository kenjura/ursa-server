import { homedir } from "os";
import { isAbsolute, resolve } from "path";

/** Resolve a config path: `~` is the home folder, relative paths are against `base`. */
export function resolvePath(p, base) {
  if (p == null) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** True when `child` is `parent` or inside it. */
export function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}
