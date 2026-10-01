// Build the editor UI into src/editor/ui/dist (served at /edit/).
import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile, rm, readdir } from "fs/promises";
import { dirname, join, resolve } from "path";

const ui = new URL("../src/editor/ui/", import.meta.url);
const dist = new URL("dist/", ui);
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const options = {
  entryPoints: [new URL("src/main.js", ui).pathname],
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  format: "iife",
  target: ["chrome115", "firefox115", "safari17"],
  outfile: new URL("editor.js", dist).pathname,
  legalComments: "none",
  metafile: true,
  logLevel: "info",
};
const result = await build(options);

// Licences of everything bundled (MIT and friends ask for their notices to travel with the code)
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = input.match(/^(.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+))\//);
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
await copyFile(new URL("vendor/LICENSE-pure-material", ui), new URL("LICENSE-pure-material.txt", dist));
console.log(`editor UI built in ${dist.pathname}`);
