// Markdown helpers shared by the editor UI and its tests (no DOM, no React).

const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Which files the visual editor may open: plain Markdown (not MDX, not wikitext). */
export const isMarkdown = (path) => /\.md$/i.test(path);

/**
 * Split YAML front matter off a page, so the visual editor never sees (and
 * never rewrites) it: `[frontMatter, body]`, frontMatter "" when there is none.
 */
export function splitFrontMatter(text) {
  const m = text.match(FRONT_MATTER);
  return m ? [m[0], text.slice(m[0].length)] : ["", text];
}

/** Resolve a link in a page (`../img/a.png`) to a source path, or null if it points off-site. */
export function resolveSourcePath(dir, src) {
  if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null;
  let clean = src.split(/[?#]/)[0];
  try {
    clean = decodeURI(clean);
  } catch {
    // keep it as written
  }
  const parts = clean.startsWith("/") ? [] : dir.split("/").filter(Boolean);
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
