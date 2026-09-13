import { beforeAll, afterAll, it, expect } from "vitest";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { embeddedDb, localConfig, MemoryStorage } from "./support";
import { buildApp } from "../src/server/app";
import { OidcAuth } from "../src/server/auth";
import type { Database } from "../src/server/db";
let server: https.Server,
  db: Database,
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  issuer: string,
  nonce = "",
  mode = "valid",
  verifier = "",
  tokenCalls = 0;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "synthetic-key",
    alg: "RS256",
    use: "sig",
  };
  server = https.createServer(
    {
      cert: await readFile(process.env.TEST_TLS_CERT!),
      key: await readFile(process.env.TEST_TLS_KEY!),
    },
    async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/openid-configuration") {
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + "/authorize",
            token_endpoint: issuer + "/token",
            jwks_uri: issuer + "/jwks",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
            code_challenge_methods_supported: ["S256"],
          }),
        );
      } else if (req.url === "/jwks") res.end(JSON.stringify({ keys: [jwk] }));
      else if (req.url === "/token") {
        tokenCalls++;
        let body = "";
        for await (const c of req) body += c;
        verifier = new URLSearchParams(body).get("code_verifier") ?? "";
        const sign = async (
          data: Record<string, unknown>,
          aud: string,
          iss = issuer,
        ) =>
          new SignJWT(data)
            .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
            .setIssuedAt()
            .setExpirationTime("5m")
            .setIssuer(iss)
            .setAudience(aud)
            .setSubject("synthetic-subject")
            .sign(pair.privateKey);
        const id = await sign(
          { nonce: mode === "nonce" ? "wrong" : nonce },
          mode === "id-audience" ? "wrong" : "bff",
          mode === "issuer" ? "https://wrong.invalid" : issuer,
        );
        const access = await sign(
          {
            resource_access: {
              delivery: { roles: mode === "role" ? [] : ["repository-sender"] },
            },
          },
          mode === "access-audience" ? "wrong" : "bff",
        );
        res.end(
          JSON.stringify({
            access_token: access,
            token_type: "Bearer",
            expires_in: 300,
            id_token: id,
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `https://localhost:${(server.address() as any).port}`;
  db = await embeddedDb();
  const c = {
    ...localConfig,
    issuer,
    clientId: "bff",
    clientSecret: "synthetic-oidc-secret",
  };
  ({ app } = await buildApp({
    config: c,
    db,
    storage: new MemoryStorage(),
    auth: new OidcAuth(db, c),
    mailer: async () => {},
    staticFiles: false,
  }));
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  await new Promise<void>((r) => server?.close(() => r()));
});
async function login() {
  const r = await app.inject({ url: "/auth/login" });
  const url = new URL(r.headers.location!);
  nonce = url.searchParams.get("nonce")!;
  const cookie = (r.headers["set-cookie"] as string).split(";")[0];
  return {
    cookie,
    state: url.searchParams.get("state")!,
    challenge: url.searchParams.get("code_challenge"),
  };
}
it("performs TLS-verified OIDC code exchange with PKCE, role and session cookies", async () => {
  mode = "valid";
  const l = await login();
  expect(l.challenge).toBeTruthy();
  const response = await app.inject({
    url: `/auth/callback?code=synthetic-code&state=${l.state}`,
    headers: { cookie: l.cookie },
  });
  expect(response.statusCode).toBe(302);
  expect(verifier.length).toBeGreaterThan(40);
  expect(String(response.headers["set-cookie"])).toContain("HttpOnly");
  expect(
    (await db.query("SELECT sender_id FROM sessions")).rows[0].sender_id,
  ).toBe("synthetic-subject");
});
it.each(["nonce", "issuer", "id-audience", "access-audience", "role"])(
  "rejects invalid %s",
  async (value) => {
    mode = value;
    const l = await login();
    const response = await app.inject({
      url: `/auth/callback?code=synthetic-code&state=${l.state}`,
      headers: { cookie: l.cookie },
    });
    expect(response.statusCode).toBe(401);
  },
);
it("consumes state once and rejects state mismatch before token exchange", async () => {
  mode = "valid";
  const l = await login(),
    before = tokenCalls;
  const r = await app.inject({
    url: "/auth/callback?code=synthetic-code&state=wrong",
    headers: { cookie: l.cookie },
  });
  expect(r.statusCode).toBe(401);
  expect(tokenCalls).toBe(before);
  expect(
    (
      await app.inject({
        url: `/auth/callback?code=synthetic-code&state=${l.state}`,
        headers: { cookie: l.cookie },
      })
    ).statusCode,
  ).toBe(401);
});
it("does not trust an unrelated TLS certificate", async () => {
  await expect(
    new Promise((resolve, reject) => {
      https
        .get(issuer, { ca: "unrelated CA", rejectUnauthorized: true }, resolve)
        .on("error", reject);
    }),
  ).rejects.toThrow();
});
