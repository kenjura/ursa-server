/**
 * Per-site logger: prints with a site prefix, keeps the last lines for
 * `GET /sites/:id/log`, and reports each line to listeners (`logs --follow`).
 */

const KEEP = 1000;

/**
 * @param {object} opts
 * @param {string} opts.prefix
 * @param {(line: string) => void} [opts.print] - default: console
 * @param {(entry: { level: string, message: string, at: string, seq: number }) => void} [opts.onLine]
 */
export function createLogger({ prefix, print = null, onLine = null }) {
  const lines = [];
  let seq = 0;
  const emit = (level, message) => {
    const entry = { seq: ++seq, at: new Date().toISOString(), level, message: String(message) };
    lines.push(entry);
    if (lines.length > KEEP) lines.shift();
    const text = `[${prefix}] ${entry.message}`;
    if (print) print(text);
    else if (level === "error") console.error(text);
    else if (level === "warn") console.warn(text);
    else console.log(text);
    onLine?.(entry);
  };
  return {
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
    /** Lines after `since` (a seq number). */
    since: (since = 0) => lines.filter((l) => l.seq > since),
  };
}
