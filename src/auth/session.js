/**
 * Signed, stateless cookies: `base64url(JSON).base64url(HMAC-SHA256)`.
 * Nothing is stored server-side, so sessions survive restarts and need no
 * database; changing the secret signs everyone out.
 */

import { createHmac, timingSafeEqual } from "crypto";

export function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

/** The payload, or null if the signature is wrong or it has expired (`exp`, ms). */
export function verify(token, secret, now = Date.now()) {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(body, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp === "number" && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

function mac(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * @param {string} name
 * @param {string} value - empty with maxAge 0 to clear
 * @param {{ maxAge: number, secure: boolean, path?: string }} opts - maxAge in seconds
 */
export function cookie(name, value, { maxAge, secure, path = "/" }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.floor(maxAge)}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
