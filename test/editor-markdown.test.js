import { test } from "node:test";
import assert from "node:assert/strict";
import { splitFrontMatter, resolveSourcePath, isMarkdown } from "../src/editor/ui/src/markdown.js";

test("front matter is split off whole, and only at the very start", () => {
  assert.deepEqual(splitFrontMatter("---\ntitle: A\n---\n# A\n"), ["---\ntitle: A\n---\n", "# A\n"]);
  assert.deepEqual(splitFrontMatter("---\r\na: 1\r\n...\r\nbody"), ["---\r\na: 1\r\n...\r\n", "body"]);
  assert.deepEqual(splitFrontMatter("---\n---\nbody"), ["---\n---\n", "body"]);
  assert.deepEqual(splitFrontMatter("# A\n\n---\nnot: front matter\n---\n"), ["", "# A\n\n---\nnot: front matter\n---\n"]);
  assert.deepEqual(splitFrontMatter("---\nnever closed\n"), ["", "---\nnever closed\n"]);
});

test("image links resolve to source paths; off-site ones don't", () => {
  assert.equal(resolveSourcePath("rules", "map.png"), "rules/map.png");
  assert.equal(resolveSourcePath("rules/combat", "../img/a%20b.png?v=2#x"), "rules/img/a b.png");
  assert.equal(resolveSourcePath("rules", "/img/a.png"), "img/a.png");
  assert.equal(resolveSourcePath("", "../../a.png"), "a.png");
  for (const src of ["https://x.com/a.png", "//cdn/a.png", "data:image/png;base64,xx", "#top", ""]) {
    assert.equal(resolveSourcePath("rules", src), null, src);
  }
});

test("the visual editor is for .md only", () => {
  assert.equal(isMarkdown("a/b.md"), true);
  assert.equal(isMarkdown("a/B.MD"), true);
  assert.equal(isMarkdown("a/b.mdx"), false);
  assert.equal(isMarkdown("a/b.txt"), false);
});
