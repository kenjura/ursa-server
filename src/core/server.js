/**
 * The process: one runtime per site, plus the roles the config turns on —
 * the dev server (`serve`) and the control API. docs/ARCHITECTURE.md.
 */

import { readFileSync } from "fs";
import { createDevServer } from "@kenjura/ursa/build";
import { createSite } from "./site.js";
import { startControlApi } from "../control/api.js";
import { createAuth } from "../auth/index.js";

export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/**
 * @param {object} config - output of loadConfig()
 * @param {{ print?: (line: string) => void }} [opts]
 * @returns {Promise<{ sites: Map<string, object>, devServer: object|null, control: object|null, close: () => Promise<void> }>}
 */
export async function startServer(config, { print } = {}) {
  const out = print ?? ((l) => console.log(l));
  if (config.roles.edit) out("⚠️  roles.edit: the editor is not implemented yet (docs/ROADMAP.md M4); ignoring");

  const auth = config.auth ? createAuth(config.auth, { log: out }) : null;

  const sites = new Map();
  for (const sc of config.sites) {
    sites.set(sc.id, await createSite(sc, { stateDir: config.stateDir, watch: config.roles.watch, print }));
  }

  // The dev server serves one site's staging output, with live reload
  let devServer = null;
  if (config.roles.serve) {
    const site = sites.get(config.server.site ?? config.sites[0].id);
    const access = config.server.access;
    devServer = createDevServer({
      outputDir: site.output,
      port: config.server.port,
      host: config.server.host,
      log: out,
      mount: auth
        ? (app) => {
            auth.mount(app);
            app.use(auth.requireRole(access));
          }
        : null,
    });
    site.attachDevServer(devServer);
    await devServer.listen();
    out(`🌐 Serving ${site.id} at http://${config.server.host}:${devServer.port}/${access === "public" ? "" : ` (sign-in required: ${access}; ${config.auth.provider.preset ?? config.auth.provider.issuer})`}`);
  }

  const control = config.control.enabled ? await startControlApi(sites, config.control, { version: VERSION, log: out }) : null;

  // Sites start in turn; each runs its first build and deploy before watching
  for (const site of sites.values()) await site.start();

  return {
    sites,
    devServer,
    control,
    async close() {
      await control?.close();
      for (const site of sites.values()) await site.close();
      await devServer?.close();
    },
  };
}
