// Build the editor UI into src/editor/ui/dist (served at /edit/).
import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile, rm, readdir } from "fs/promises";
import { dirname, join, resolve } from "path";

const ui = new URL("../src/editor/ui/", import.meta.url);
const dist = new URL("dist/", ui);
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: ["chrome115", "firefox115", "safari17"],
  legalComments: "none",
  metafile: true,
  logLevel: "info",
};

// The editor: Preact, CodeMirror
const main = await build({
  ...common,
  entryPoints: [new URL("src/main.js", ui).pathname],
  format: "iife",
  outfile: new URL("editor.js", dist).pathname,
});

// The visual Markdown editor (Gravity UI, React), loaded on first use. ESM so
// its rarely used parts (code highlighting, date locales) split into chunks.
// Its markdown-it dependencies expect a bundler that stubs Node's built-ins.
const nodeStubs = {
  name: "node-stubs",
  setup(b) {
    b.onResolve({ filter: /^(fs|path|url)$/ }, (a) => ({ path: a.path, namespace: "node-stub" }));
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
  },
};
const wysiwyg = await build({
  ...common,
  logLevel: "warning",
  entryPoints: [new URL("src/wysiwyg.js", ui).pathname],
  format: "esm",
  splitting: true,
  outdir: new URL("wysiwyg/", dist).pathname,
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  alias: { punycode: "punycode/", process: "process/browser.js" },
  define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file", ".png": "file" },
  plugins: [nodeStubs],
});

// Licences of everything bundled (MIT and friends ask for their notices to travel with the code)
const packages = new Map();
for (const input of [...Object.keys(main.metafile.inputs), ...Object.keys(wysiwyg.metafile.inputs)]) {
  const m = input.replace(/^\([a-z]+\):/, "").match(/^(.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+))\//);
  if (m) packages.set(m[2], resolve(m[1]));
}
const notices = [];
for (const [name, dir] of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const file = (await readdir(dir)).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const text = file ? await readFile(join(dir, file), "utf8") : `License: ${pkg.license ?? "unknown"}`;
  notices.push(`${name}@${pkg.version} (${pkg.license ?? "?"})\n\n${text.trim()}\n`);
}
await writeFile(new URL("THIRD_PARTY_LICENSES.txt", dist), notices.join("\n" + "-".repeat(72) + "\n\n"));

// pure-material first, so the editor's own rules win
const css = (await readFile(new URL("vendor/pure-material.css", ui), "utf8")) + "\n" + (await readFile(new URL("editor.css", ui), "utf8"));
await writeFile(new URL("editor.css", dist), css);
await copyFile(new URL("index.html", ui), new URL("index.html", dist));
await copyFile(new URL("wysiwyg.html", ui), new URL("wysiwyg/index.html", dist));
await copyFile(new URL("vendor/LICENSE-pure-material", ui), new URL("LICENSE-pure-material.txt", dist));
const kb = (r) => Math.round(Object.values(r.metafile.outputs).reduce((n, o) => n + o.bytes, 0) / 1024);
console.log(`editor UI built in ${dist.pathname} (editor ${kb(main)} KB, visual editor ${kb(wysiwyg)} KB loaded on demand)`);
