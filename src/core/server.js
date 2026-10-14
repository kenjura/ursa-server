/**
 * The process: one runtime per site, plus the roles the config turns on —
 * the dev server (`serve`) and the control API. docs/ARCHITECTURE.md.
 */

import { readFileSync } from "fs";
import { createDevServer } from "@kenjura/ursa/build";
import { createSite } from "./site.js";
import { startControlApi } from "../control/api.js";
import { createAuth } from "../auth/index.js";
import { hasRole } from "../auth/roles.js";
import { mountEditor } from "../editor/index.js";

export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/**
 * @param {object} config - output of loadConfig()
 * @param {{ print?: (line: string) => void }} [opts]
 * @returns {Promise<{ sites: Map<string, object>, devServer: object|null, control: object|null, close: () => Promise<void> }>}
 */
export async function startServer(config, { print } = {}) {
  const out = print ?? ((l) => console.log(l));
  const editing = config.roles.edit;
  const auth = config.auth ? createAuth({ ...config.auth, editUrl: editing ? "/edit/" : null }, { log: out }) : null;

  const sites = new Map();
  for (const sc of config.sites) {
    sites.set(sc.id, await createSite(sc, { stateDir: config.stateDir, watch: config.roles.watch, print }));
  }

  // The dev server serves one site's staging output, with live reload
  let devServer = null;
  if (config.roles.serve) {
    const site = sites.get(config.server.site ?? config.sites[0].id);
    const access = config.server.access;
    // Tells Ursa's account.js where to sign in and edit (docs/AUTH.md)
    const pageConfig = {
      ...(auth ? { auth: "/auth", profile: "/auth/profile" } : {}),
      ...(editing ? { edit: "/edit/" } : {}),
    };
    devServer = createDevServer({
      outputDir: site.output,
      port: config.server.port,
      host: config.server.host,
      log: out,
      headHtml: Object.keys(pageConfig).length
        ? `<script type="application/json" id="ursa-server">${JSON.stringify(pageConfig).replace(/</g, "\\u003c")}</script>`
        : "",
      // Live reload is for people who may see the site
      authorizeUpgrade: auth && access !== "public" ? (req) => hasRole(auth.userOf(req)?.roles, access) : null,
      mount: (app) => {
        if (auth) auth.mount(app);
        if (editing) {
          mountEditor(app, {
            site,
            auth,
            scopes: config.auth?.scopes ?? {},
            maxUploadBytes: config.editor.maxUploadMb * 1024 * 1024,
            log: (m) => site.log.info(m),
          });
        }
        if (auth) app.use(auth.requireRole(access));
      },
    });
    site.attachDevServer(devServer);
    await devServer.listen();
    const provider = config.auth?.provider;
    const signIn = provider?.type === "mock" ? "test sign-in: any name, no password" : provider?.preset ?? provider?.issuer;
    out(`🌐 Serving ${site.id} at http://${config.server.host}:${devServer.port}/${access === "public" ? "" : ` (sign-in required: ${access}; ${signIn})`}`);
    if (editing) out(`✏️  Editor at http://${config.server.host}:${devServer.port}/edit/${auth ? " (editors and admins)" : " (no sign-in: this machine only)"}`);
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
