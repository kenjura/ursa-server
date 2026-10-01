/**
 * A minimal OpenID Connect issuer for tests: discovery, JWKS, an authorize
 * endpoint that signs in `user` at once, and a token endpoint that checks PKCE
 * and returns an RS256 ID token.
 */
import { createServer } from "http";
import { generateKeyPairSync, createSign, createHash, randomBytes } from "crypto";

export async function startFakeIssuer({ clientId = "cid", clientSecret = "csecret" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const state = { user: { sub: "auth0|1", email: "me@example.com", email_verified: true, name: "Me" }, requests: [] };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    state.requests.push(url.pathname);
    const json = (o, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}oauth/token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/authorize") {
      const p = url.searchParams;
      const code = randomBytes(8).toString("hex");
      codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redirect: p.get("redirect_uri"), user: state.user });
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state"));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const basic = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const [id, secret] = basic.split(":").map(decodeURIComponent);
      const given = { id: id || p.get("client_id"), secret: secret || p.get("client_secret") };
      if (given.id !== clientId || given.secret !== clientSecret) return json({ error: "invalid_client" }, 401);
      const c = codes.get(p.get("code"));
      codes.delete(p.get("code"));
      if (!c) return json({ error: "invalid_grant" }, 400);
      const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== c.challenge) return json({ error: "invalid_grant", error_description: "PKCE" }, 400);
      const now = Math.floor(Date.now() / 1000);
      const idToken = jwt({ iss: issuer, aud: clientId, iat: now, exp: now + 300, nonce: c.nonce, ...c.user }, privateKey);
      return json({ access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${server.address().port}/`;
  return { issuer, state, clientId, clientSecret, close: () => new Promise((r) => server.close(r)) };
}

function jwt(payload, key) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT", kid: "k1" })}.${enc(payload)}`;
  const sig = createSign("RSA-SHA256").update(input).sign(key).toString("base64url");
  return `${input}.${sig}`;
}
