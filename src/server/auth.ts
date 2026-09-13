import * as oidc from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { digest, random, HttpError, type Database } from "./db";
import type { Config } from "./config";
export interface Auth {
  sender(
    req: FastifyRequest,
    unsafe?: boolean,
  ): Promise<{ id: string; csrf: string }>;
  register(app: FastifyInstance): Promise<void>;
}
export class SessionAuth implements Auth {
  sessionCookie: string;
  csrfCookie: string;
  constructor(
    public db: Database,
    public config: Config,
  ) {
    this.sessionCookie = config.development ? "sd-dev" : "__Host-sd";
    this.csrfCookie = config.development ? "sd-dev-csrf" : "__Host-sd-csrf";
  }
  async sender(req: FastifyRequest, unsafe = false) {
    const token = req.cookies[this.sessionCookie],
      csrf = req.cookies[this.csrfCookie];
    if (!token || !csrf) throw new HttpError(401);
    const row = (
      await this.db.query(
        "SELECT sender_id,csrf_hash FROM sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()",
        [digest(token)],
      )
    ).rows[0];
    if (!row || digest(csrf) !== row.csrf_hash) throw new HttpError(401);
    if (
      unsafe &&
      (req.headers.origin !== this.config.origin ||
        typeof req.headers["x-csrf-token"] !== "string" ||
        digest(req.headers["x-csrf-token"]) !== row.csrf_hash)
    )
      throw new HttpError(403);
    return { id: row.sender_id, csrf };
  }
  async createSession(reply: FastifyReply, id: string) {
    const token = random(),
      csrf = random();
    await this.db.query(
      "INSERT INTO sessions(token_hash,csrf_hash,sender_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes')",
      [digest(token), digest(csrf), id],
    );
    const opts = {
      secure: !this.config.development,
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      maxAge: 900,
    };
    reply
      .setCookie(this.sessionCookie, token, opts)
      .setCookie(this.csrfCookie, csrf, opts);
  }
  async register(app: FastifyInstance) {
    app.get("/api/session", async (req) => this.sender(req));
    app.post("/api/logout", async (req, reply) => {
      await this.sender(req, true);
      await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [
        digest(req.cookies[this.sessionCookie]!),
      ]);
      reply
        .clearCookie(this.sessionCookie, { path: "/" })
        .clearCookie(this.csrfCookie, { path: "/" });
      return { ok: true };
    });
  }
}
export class OidcAuth extends SessionAuth {
  override async register(app: FastifyInstance) {
    await super.register(app);
    const c = this.config;
    const client = await oidc.discovery(
      new URL(c.issuer),
      c.clientId,
      c.clientSecret,
    );
    const meta = client.serverMetadata();
    if (
      meta.issuer !== c.issuer ||
      !meta.jwks_uri ||
      new URL(meta.jwks_uri).protocol !== "https:"
    )
      throw new Error("OIDC issuer metadata invalid");
    const jwks = createRemoteJWKSet(new URL(meta.jwks_uri), {
      timeoutDuration: 5000,
    });
    app.get("/auth/login", async (_req, reply) => {
      const verifier = oidc.randomPKCECodeVerifier(),
        state = oidc.randomState(),
        nonce = oidc.randomNonce(),
        token = random();
      await this.db.query(
        "INSERT INTO oidc_transactions(token_hash,state,nonce,verifier,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes')",
        [digest(token), state, nonce, verifier],
      );
      reply.setCookie("__Host-sd-oidc", token, {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 300,
      });
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: c.origin + "/auth/callback",
        scope: "openid",
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      });
      return reply.redirect(url.href);
    });
    app.get("/auth/callback", async (req, reply) => {
      const token = req.cookies["__Host-sd-oidc"];
      reply.clearCookie("__Host-sd-oidc", { path: "/" });
      if (!token) throw new HttpError(401);
      const t = (
        await this.db.query(
          "DELETE FROM oidc_transactions WHERE token_hash=$1 AND expires_at>clock_timestamp() RETURNING *",
          [digest(token)],
        )
      ).rows[0];
      if (!t) throw new HttpError(401);
      try {
        const tokens = await oidc.authorizationCodeGrant(
          client,
          new URL(req.url, c.origin),
          {
            pkceCodeVerifier: t.verifier,
            expectedState: t.state,
            expectedNonce: t.nonce,
            idTokenExpected: true,
          },
        );
        const claims = tokens.claims();
        if (!claims?.sub || claims.iss !== c.issuer) throw new Error();
        const { payload } = await jwtVerify(tokens.access_token, jwks, {
          issuer: c.issuer,
          audience: c.clientId,
          requiredClaims: ["exp", "iat", "sub"],
          algorithms: ["RS256", "PS256", "ES256"],
        });
        const roles = (
          payload.resource_access as
            | Record<string, { roles?: string[] }>
            | undefined
        )?.[c.roleClient]?.roles;
        if (payload.sub !== claims.sub || !roles?.includes(c.role))
          throw new Error();
        await this.createSession(reply, claims.sub);
        return reply.redirect("/");
      } catch {
        throw new HttpError(
          401,
          "Sign-in was unsuccessful or the required sender role is missing.",
        );
      }
    });
  }
}
