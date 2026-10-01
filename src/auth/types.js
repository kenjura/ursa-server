/**
 * Auth contracts. docs/AUTH.md.
 */

/**
 * @typedef {object} Identity
 * @property {string} provider
 * @property {string} subject
 * @property {string} [email]
 * @property {string} [name]
 * @property {object} claims
 * @property {object} [sourceCredentials] - pass-through credentials for source writes
 */

/**
 * @typedef {object} AuthProvider
 * @property {string} id
 * @property {(app: object) => void} registerRoutes
 * @property {(request: object) => Promise<Identity | null>} authenticate
 */

/** @typedef {"viewer" | "editor" | "admin"} Role */

export {};
