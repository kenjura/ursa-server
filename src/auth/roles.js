/**
 * Who may do what (docs/AUTH.md). Providers say who someone is; the config's
 * `auth.roles` says what each role is granted to:
 *
 *   "*"                    anyone who signs in
 *   "*@example.com"        anyone with a verified email at that domain
 *   "me@example.com"       that verified email
 *   "google-oauth2|1234"   that provider subject (anything containing "|"),
 *                          or "sub:<subject>" for subjects without one
 *
 * Roles are ordered: admin ⊃ editor ⊃ viewer.
 */

export const ROLES = ["viewer", "editor", "admin"];

/**
 * @param {{ sub: string, email?: string, emailVerified?: boolean }} who
 * @param {Record<string, string[]>} rules
 * @returns {string[]} granted roles, including those implied by higher ones
 */
export function rolesFor(who, rules = {}) {
  let highest = -1;
  ROLES.forEach((role, i) => {
    if ((rules[role] ?? []).some((pattern) => matches(pattern, who))) highest = Math.max(highest, i);
  });
  return ROLES.slice(0, highest + 1);
}

export function hasRole(roles = [], required) {
  if (!required || required === "public") return true;
  return roles.includes(required);
}

function matches(pattern, { sub, email, emailVerified }) {
  pattern = String(pattern).trim();
  if (pattern === "*") return true;
  if (pattern.startsWith("sub:")) return sub === pattern.slice(4);
  if (pattern.includes("|")) return sub === pattern;
  // Email rules only count for addresses the provider has verified
  if (!email || !emailVerified) return false;
  const e = email.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*@")) return e.endsWith(p.slice(1));
  return e === p;
}
