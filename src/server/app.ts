import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { MAX_CIPHER } from "../crypto/bytes";
import { Repositories, HttpError, audit, type Database } from "./db";
import type { Auth } from "./auth";
import type { Config } from "./config";
import type { Storage } from "./storage";
import type { Mailer } from "./mail";
import { Streams } from "./lifecycle";
export type Dependencies = {
  config: Config;
  db: Database;
  storage: Storage;
  auth: Auth;
  mailer: Mailer;
  streams?: Streams;
  staticFiles?: boolean;
};
const params = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: "^[a-f0-9]{32}$" } },
  additionalProperties: false,
};
const empty = { type: "object", properties: {}, additionalProperties: false };
export async function buildApp(d: Dependencies) {
  const c = d.config,
    repos = new Repositories(d.db),
    streams = d.streams ?? new Streams();
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
    bodyLimit: 8192,
    requestTimeout: 3600000,
    connectionTimeout: 60000,
    ...(!c.development ? { https: { cert: c.tlsCert, key: c.tlsKey } } : {}),
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 180,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.ip,
  });
  // Static-file helpers also pass this hook, so their defaults cannot cache pages.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cross-origin-opener-policy": "same-origin",
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    });
    if (!c.development)
      reply.header(
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
      );
    if (
      req.headers["sec-fetch-site"] === "cross-site" &&
      !req.url.startsWith("/auth/") &&
      !(req.method === "GET" && ["/", "/receive"].includes(req.url))
    )
      throw new HttpError(403);
  });
  app.setErrorHandler((error, _req, reply) => {
    const known = error as { validation?: unknown; statusCode?: number };
    const status =
      error instanceof HttpError
        ? error.statusCode
        : known.validation
          ? 400
          : known.statusCode && known.statusCode < 500
            ? known.statusCode
            : 503;
    reply.code(status).send({
      error:
        status >= 500
          ? "Service unavailable. Please retry."
          : error instanceof HttpError
            ? error.message
            : "Request rejected.",
    });
  });
  await d.auth.register(app);
  app.get("/api/public-config", () => ({
    brandName: c.brandName,
    supportText: c.supportText,
    development: !!c.development,
    emailEnabled: c.emailEnabled !== false,
  }));
  app.get("/health/live", () => ({ ok: true }));
  app.get("/metrics", async (_req, reply) => {
    const row = (
      await d.db.query(
        "SELECT count(*) AS pending, COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-min(invalidated_at)),0) AS oldest FROM repositories WHERE invalidated_at IS NOT NULL AND deleted_at IS NULL",
      )
    ).rows[0];
    return reply
      .type("text/plain; version=0.0.4")
      .send(
        `# TYPE delivery_cleanup_pending gauge\ndelivery_cleanup_pending ${Number(row.pending)}\n# TYPE delivery_cleanup_oldest_age_seconds gauge\ndelivery_cleanup_oldest_age_seconds ${Math.max(0, Number(row.oldest))}\n`,
      );
  });
  app.get("/health/ready", async (_req, reply) => {
    await d.db.query("SELECT 1");
    const n = Number(
      (
        await d.db.query(
          "SELECT count(*) AS n FROM repositories WHERE invalidated_at<clock_timestamp()-interval '23 hours' AND deleted_at IS NULL",
        )
      ).rows[0].n,
    );
    if (n) reply.code(503);
    return { ok: n === 0 };
  });
  app.get<{ Querystring: { cursor?: string } }>(
    "/api/repositories",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { cursor: { type: "string", pattern: "^[a-f0-9]{32}$" } },
        },
      },
    },
    async (req) => repos.list((await d.auth.sender(req)).id, req.query.cursor),
  );
  app.post("/api/repositories", { schema: { body: empty } }, async (req) =>
    repos.create((await d.auth.sender(req, true)).id),
  );
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
    done(null, payload),
  );
  app.put<{ Params: { id: string } }>(
    "/api/repositories/:id/ciphertext",
    { schema: { params }, bodyLimit: MAX_CIPHER },
    async (req, reply) => {
      const sender = await d.auth.sender(req, true),
        id = req.params.id;
      const bytes = Number(req.headers["content-length"]),
        hash = req.headers["x-ciphertext-sha256"];
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 101 ||
        bytes > MAX_CIPHER ||
        typeof hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(hash)
      )
        throw new HttpError(400);
      const reservation = await repos.reserve(id, sender.id, bytes, hash);
      if (reservation.done) {
        req.raw.resume();
        return reply.code(204).send();
      }
      const abort = new AbortController();
      req.raw.on("aborted", () => abort.abort());
      try {
        await d.storage.upload(
          id,
          req.body as Readable,
          bytes,
          hash,
          abort.signal,
          (upload) => repos.multipart(id, reservation.lease, upload),
          () => repos.activity(id, reservation.lease),
        );
        await repos.uploaded(id, reservation.lease);
        await audit(d.db, id, "ciphertext_uploaded", "success", sender.id);
        return reply.code(204).send();
      } catch {
        abort.abort();
        await repos.uploadFailed(id, reservation.lease);
        await audit(d.db, id, "ciphertext_upload", "failure", sender.id);
        throw new HttpError(503);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/finalize",
    { schema: { params, body: empty } },
    async (req) =>
      repos.finalize(req.params.id, (await d.auth.sender(req, true)).id),
  );
  const notify = async () => {
    await d.db
      .query("SELECT pg_notify('delivery_state','changed')")
      .catch(() => {
        streams.stop();
      });
    await streams.check();
  };
  for (const action of ["revoke", "fail"] as const)
    app.post<{ Params: { id: string } }>(
      `/api/repositories/:id/${action}`,
      { schema: { params, body: empty } },
      async (req) => {
        await repos.invalidate(
          req.params.id,
          (await d.auth.sender(req, true)).id,
          action === "fail",
        );
        await notify();
        return { ok: true };
      },
    );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/reissue",
    { schema: { params, body: empty } },
    async (req) => {
      const result = await repos.reissue(
        req.params.id,
        (await d.auth.sender(req, true)).id,
      );
      await notify();
      return result;
    },
  );
  app.post<{
    Params: { id: string };
    Body: { addresses: string[]; capability: string };
  }>(
    "/api/repositories/:id/email",
    {
      schema: {
        params,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["addresses", "capability"],
          properties: {
            addresses: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: {
                type: "string",
                maxLength: 254,
                pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
              },
            },
            capability: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          },
        },
      },
    },
    async (req, reply) => {
      const sender = await d.auth.sender(req, true),
        id = req.params.id;
      await repos.own(id, sender.id);
      if (c.emailEnabled === false) throw new HttpError(503);
      const row = await repos.authorize(
        id,
        req.body.capability,
        c.retrievalEnabled,
      );
      try {
        await d.mailer(
          req.body.addresses,
          `${c.origin}/receive#r=${id}&c=${req.body.capability}`,
          new Date(row.expires_at).toISOString(),
        );
        await audit(d.db, id, "link_email_accepted", "success", sender.id);
        return reply.code(202).send({ accepted: true });
      } catch {
        await audit(d.db, id, "link_email", "failure", sender.id);
        throw new HttpError(502);
      } finally {
        req.body.addresses = [];
        req.body.capability = "";
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/recipient/:id",
    {
      schema: { params },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const id = req.params.id,
        auth = req.headers.authorization;
      const capability = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      const row = await repos.authorize(id, capability, c.retrievalEnabled);
      const abort = new AbortController();
      const check = async () => {
        await repos.authorize(id, capability, c.retrievalEnabled);
      };
      const remove = streams.add(abort, check);
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void check()
          .catch(() => abort.abort())
          .finally(() => {
            checking = false;
          });
      }, 250);
      const deadline = setTimeout(
        () => abort.abort(),
        Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
      );
      const clean = () => {
        clearInterval(timer);
        clearTimeout(deadline);
        remove();
        abort.abort();
      };
      reply.raw.on("close", clean);
      let source: Readable;
      try {
        source = await d.storage.get(row.object_key, abort.signal);
        await check();
        await audit(d.db, id, "ciphertext_retrieval_started", "success");
      } catch {
        clean();
        throw new HttpError(503);
      }
      abort.signal.addEventListener(
        "abort",
        () => source.destroy(new Error("Access ended")),
        { once: true },
      );
      const body = Readable.from(
        (async function* () {
          let bytes = 0;
          try {
            for await (const chunk of source) {
              if (abort.signal.aborted) throw new Error("Access ended");
              await check();
              if (abort.signal.aborted) throw new Error("Access ended");
              bytes += chunk.length;
              if (bytes > Number(row.ciphertext_bytes))
                throw new Error("Invalid storage length");
              yield chunk;
            }
            if (bytes !== Number(row.ciphertext_bytes))
              throw new Error("Truncated storage");
            await audit(d.db, id, "ciphertext_retrieval_completed", "success");
          } catch {
            await audit(d.db, id, "ciphertext_retrieval", "stopped").catch(
              () => {},
            );
            throw new Error("Transfer stopped");
          } finally {
            clean();
          }
        })(),
      );
      return reply
        .type("application/octet-stream")
        .header("content-length", row.ciphertext_bytes)
        .header("content-disposition", 'attachment; filename="delivery.sdp"')
        .send(body);
    },
  );
  if (d.staticFiles !== false) {
    await app.register(serveStatic, {
      root: fileURLToPath(new URL("../../dist", import.meta.url)),
      wildcard: true,
    });
    app.get("/receive", (_req, reply) => reply.sendFile("index.html"));
  }
  app.addHook("onClose", async () => streams.stop());
  return { app, repos, streams };
}
