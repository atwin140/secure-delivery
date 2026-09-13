import { PGlite } from "@electric-sql/pglite";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { Database, Query } from "../src/server/db";
import { migrate } from "../src/server/db";
import type { Storage } from "../src/server/storage";
import type { Source } from "../src/crypto/bytes";
import type { Config } from "../src/server/config";
import { SessionAuth } from "../src/server/auth";
import type { FastifyInstance } from "fastify";
export async function embeddedDb(path?: string): Promise<Database> {
  const p = new PGlite(path);
  await p.waitReady;
  const wrap = (client: any): Query => ({
    query: async (s, v) => {
      if (v === undefined && s.includes(";")) {
        const r = await client.exec(s);
        return r.at(-1) ?? { rows: [] };
      }
      return client.query(s, v);
    },
  });
  const db: Database = {
    ...wrap(p),
    transaction: (fn) => p.transaction((tx) => fn(wrap(tx))),
    close: () => p.close(),
  };
  await migrate(db);
  return db;
}
export const localConfig: Config = {
  origin: "http://127.0.0.1:3000",
  brandName: "Docs signed by Sharkbait",
  supportText: "Local testing only. No real data or messages.",
  issuer: "https://keycloak.example.invalid/realms/development-only",
  clientId: "development-only",
  clientSecret: "development-only",
  roleClient: "delivery",
  role: "repository-sender",
  databaseUrl: "development-only",
  databaseCa: "",
  s3Endpoint: "https://s3.example.invalid",
  s3Region: "development-only",
  s3Bucket: "development-only",
  s3AccessKey: "development-only",
  s3SecretKey: "development-only",
  graphTenant: "development-only",
  graphClientId: "development-only",
  graphClientSecret: "development-only",
  graphMailbox: "development-only@example.invalid",
  auditDays: 90,
  tlsCert: "",
  tlsKey: "",
  retrievalEnabled: true,
  development: true,
};
export class LocalAuth extends SessionAuth {
  override async register(app: FastifyInstance) {
    await super.register(app);
    app.get("/auth/login", async (_req, reply) => {
      await this.createSession(reply, "synthetic-sender");
      return reply.redirect("/");
    });
  }
}
export class MemoryStorage implements Storage {
  data = new Map<string, Buffer>();
  failUploads = 0;
  failDeletes = false;
  delay = 0;
  openMultiparts = new Map<string, string>();
  async upload(
    key: string,
    source: Source,
    expected: number,
    hash: string,
    signal: AbortSignal,
    started: (id: string) => Promise<void>,
    activity: () => Promise<void>,
  ) {
    this.openMultiparts.set(key, "synthetic-upload");
    await started("synthetic-upload");
    try {
      if (this.failUploads-- > 0) throw new Error("Synthetic provider failure");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const c of source) {
        if (signal.aborted) throw new Error("Aborted");
        length += c.length;
        if (length > expected) throw new Error("Too large");
        chunks.push(c);
        await activity();
      }
      const bytes = Buffer.concat(chunks);
      if (
        length !== expected ||
        createHash("sha256").update(bytes).digest("hex") !== hash
      )
        throw new Error("Integrity");
      this.data.set(key, bytes);
    } finally {
      this.openMultiparts.delete(key);
    }
  }
  async get(key: string, signal: AbortSignal) {
    const data = this.data.get(key);
    if (!data) throw new Error("Missing");
    const delay = this.delay;
    return Readable.from(
      (async function* () {
        for (let p = 0; p < data.length; p += 128) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (signal.aborted) throw new Error("Stopped");
          yield data.subarray(p, p + 128);
        }
      })(),
    );
  }
  async remove(key: string) {
    if (this.failDeletes) throw new Error("Synthetic outage");
    this.data.delete(key);
  }
  async exists(key: string) {
    return this.data.has(key);
  }
  async *objects() {
    for (const key of this.data.keys()) yield { key, at: new Date(0) };
  }
  async *multiparts() {
    for (const [key, id] of this.openMultiparts)
      yield { key, id, at: new Date(0) };
  }
  async abort(key: string, _id: string) {
    this.openMultiparts.delete(key);
  }
}
