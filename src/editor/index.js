/**
 * The editor: UI at /edit/, API at /edit/api (docs/EDITOR.md).
 */

import express from "express";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { createEditorApi } from "./api.js";

export const UI_DIR = fileURLToPath(new URL("./ui/dist/", import.meta.url));

/**
 * @param {import("express").Express} app
 * @param {object} opts
 * @param {object} opts.site - the site being edited
 * @param {object|null} opts.auth - createAuth() result, or null for local, sign-in-free use
 * @param {object} [opts.scopes] - auth.scopes
 * @param {(m: string) => void} [opts.log]
 */
export function mountEditor(app, { site, auth, scopes = {}, maxUploadBytes, log }) {
  if (!existsSync(UI_DIR + "index.html")) {
    throw new Error(`the editor UI isn't built (${UI_DIR}): run \`pnpm run build:ui\` in ursa-server`);
  }
  if (auth) {
    app.use("/edit", auth.requireRole("editor"));
  } else {
    // No sign-in: only allowed on a loopback-only server (checked in config), as the local admin
    app.use("/edit", (req, res, next) => {
      req.user = { sub: "local", name: "Local editor", email: null, roles: ["viewer", "editor", "admin"] };
      next();
    });
  }
  app.use("/edit/api", createEditorApi(site, { scopes, maxUploadBytes, log }));
  app.use("/edit", express.static(UI_DIR, { index: "index.html" }));
}
