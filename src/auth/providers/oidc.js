/**
 * `oidc` provider: any OpenID Connect issuer, with presets for the common
 * ones. Authorization code flow with PKCE, via openid-client. docs/AUTH.md.
 */

import * as client from "openid-client";

/** Vendor presets: config → issuer URL (and anything vendor-specific). */
export const PRESETS = {
  auth0: ({ domain }) => {
    if (!domain) throw new Error("auth0: `domain` is required (e.g. your-tenant.us.auth0.com)");
    return { issuer: `https://${domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/` };
  },
  google: () => ({ issuer: "https://accounts.google.com" }),
  cognito: ({ region, userPoolId }) => ({ issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` }),
};

/**
 * @param {object} cfg - { preset?, issuer?, domain?, clientId, clientSecret, scope? }
 * @param {{ redirectUri: string }} opts
 */
export function createOidcProvider(cfg, { redirectUri }) {
  const issuer = cfg.issuer ?? (cfg.preset ? PRESETS[cfg.preset](cfg).issuer : null);
  if (!issuer) throw new Error("oidc provider: give `preset` or `issuer`");
  const issuerUrl = new URL(issuer);
  const insecure = issuerUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(issuerUrl.hostname);
  if (issuerUrl.protocol !== "https:" && !insecure) throw new Error(`oidc issuer must be https: ${issuer}`);

  let configuration = null;
  async function config() {
    configuration ??= await client.discovery(issuerUrl, cfg.clientId, cfg.clientSecret, undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((e) => {
        configuration = null;
        throw new Error(`could not reach ${issuer} for sign-in: ${e.message}`);
      });
    return configuration;
  }

  return {
    id: cfg.preset ?? "oidc",
    issuer,

    /** Start a sign-in: the URL to send the browser to, and what to check on return. */
    async begin() {
      const c = await config();
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(c, {
        redirect_uri: redirectUri,
        scope: cfg.scope ?? "openid email profile",
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return { url: url.href, checks: { verifier, state, nonce } };
    },

    /** Finish a sign-in from the callback URL. Returns who signed in. */
    async finish(callbackUrl, checks) {
      const c = await config();
      const tokens = await client.authorizationCodeGrant(c, new URL(callbackUrl), {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      return {
        sub: claims.sub,
        email: claims.email ?? null,
        emailVerified: claims.email_verified === true,
        name: claims.name ?? claims.nickname ?? claims.email ?? claims.sub,
      };
    },

    /** Where to send the browser to end the provider's session too. */
    async logoutUrl(returnTo) {
      const c = await config();
      if (c.serverMetadata().end_session_endpoint) {
        return client.buildEndSessionUrl(c, { post_logout_redirect_uri: returnTo, client_id: cfg.clientId }).href;
      }
      if (cfg.preset === "auth0") {
        const u = new URL("v2/logout", issuer);
        u.searchParams.set("client_id", cfg.clientId);
        u.searchParams.set("returnTo", returnTo);
        return u.href;
      }
      return returnTo;
    },
  };
}
