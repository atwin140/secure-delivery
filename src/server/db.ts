import pg from "pg";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config";
export interface Query {
  query(
    sql: string,
    values?: any[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}
export interface Database extends Query {
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function productionDb(config: Config): Database {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: { ca: config.databaseCa, rejectUnauthorized: true },
    max: 12,
    statement_timeout: 5000,
    connectionTimeoutMillis: 5000,
  });
  return {
    query: (s, v) => pool.query(s, v),
    transaction: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await fn(c);
        await c.query("COMMIT");
        return r;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const random = (n = 32) => randomBytes(n).toString("base64url");
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message = "Request could not be completed.",
  ) {
    super(message);
  }
}
export async function migrate(db: Database) {
  await db.query(
    await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
  );
}
export async function audit(
  db: Query,
  id: string | null,
  event: string,
  outcome: string,
  sender?: string,
) {
  await db.query(
    "INSERT INTO audit(repository_id,event,outcome,sender_id) VALUES($1,$2,$3,$4)",
    [id, event, outcome, sender ?? null],
  );
}
export class Repositories {
  constructor(public db: Database) {}
  async create(sender: string) {
    const id = randomBytes(16).toString("hex"),
      capability = random();
    await this.db.transaction(async (q) => {
      await q.query(
        "INSERT INTO repositories(id,object_key,sender_id,capability_hash,status) VALUES($1,$1,$2,$3,'pending')",
        [id, sender, digest(capability)],
      );
      await audit(q, id, "created", "success", sender);
    });
    return { id, capability };
  }
  async own(id: string, sender: string) {
    const { rows } = await this.db.query(
      "SELECT * FROM repositories WHERE id=$1 AND sender_id=$2",
      [id, sender],
    );
    if (!rows[0]) throw new HttpError(404);
    return rows[0];
  }
  async list(sender: string, cursor?: string) {
    return (
      await this.db.query(
        "SELECT r.id,r.status,r.created_at,r.expires_at,r.ciphertext_bytes FROM repositories r WHERE r.sender_id=$1 AND ($2::text IS NULL OR (r.created_at,r.id)<(SELECT created_at,id FROM repositories WHERE id=$2 AND sender_id=$1)) ORDER BY r.created_at DESC,r.id DESC LIMIT 100",
        [sender, cursor ?? null],
      )
    ).rows;
  }
  async reserve(id: string, sender: string, bytes: number, hash: string) {
    return this.db.transaction(async (q) => {
      const row = (
        await q.query(
          "SELECT * FROM repositories WHERE id=$1 AND sender_id=$2 FOR UPDATE",
          [id, sender],
        )
      ).rows[0];
      if (!row) throw new HttpError(404);
      if (
        row.ciphertext_sha256 &&
        (row.ciphertext_sha256 !== hash ||
          Number(row.ciphertext_bytes) !== bytes)
      )
        throw new HttpError(409, "Ciphertext differs from the initial upload.");
      if (row.status === "uploaded" || row.status === "finalized")
        return { done: true, lease: "" };
      if (row.status !== "pending") throw new HttpError(409);
      if (row.upload_attempts >= 4) throw new HttpError(410);
      const lease = random(16);
      await q.query(
        "UPDATE repositories SET status='uploading',upload_lease=$2,ciphertext_bytes=$3,ciphertext_sha256=$4,upload_attempts=upload_attempts+1,last_activity=clock_timestamp() WHERE id=$1",
        [id, lease, bytes, hash],
      );
      return { done: false, lease };
    });
  }
  async multipart(id: string, lease: string, upload: string) {
    const r = await this.db.query(
      "UPDATE repositories SET multipart_id=$3 WHERE id=$1 AND upload_lease=$2 AND status='uploading' RETURNING id",
      [id, lease, upload],
    );
    if (!r.rows.length) throw new HttpError(410);
  }
  async activity(id: string, lease: string) {
    const r = await this.db.query(
      "UPDATE repositories SET last_activity=clock_timestamp() WHERE id=$1 AND upload_lease=$2 AND status='uploading' AND last_activity>clock_timestamp()-interval '60 minutes' RETURNING id",
      [id, lease],
    );
    if (!r.rows.length) throw new HttpError(410);
  }
  async uploaded(id: string, lease: string) {
    const r = await this.db.query(
      "UPDATE repositories SET status='uploaded',upload_lease=NULL,multipart_id=NULL,last_activity=clock_timestamp() WHERE id=$1 AND upload_lease=$2 AND status='uploading' RETURNING id",
      [id, lease],
    );
    if (!r.rows.length) throw new HttpError(410);
  }
  async uploadFailed(id: string, lease: string) {
    await this.db.query(
      "UPDATE repositories SET status=CASE WHEN upload_attempts>=4 THEN 'failed' ELSE 'pending' END,invalidated_at=CASE WHEN upload_attempts>=4 THEN clock_timestamp() ELSE NULL END,upload_lease=NULL WHERE id=$1 AND upload_lease=$2 AND status='uploading'",
      [id, lease],
    );
  }
  async finalize(id: string, sender: string) {
    return this.db.transaction(async (q) => {
      const row = (
        await q.query(
          "SELECT * FROM repositories WHERE id=$1 AND sender_id=$2 FOR UPDATE",
          [id, sender],
        )
      ).rows[0];
      if (!row) throw new HttpError(404);
      if (row.status === "finalized") return { expiresAt: row.expires_at };
      if (row.status !== "uploaded") throw new HttpError(409);
      const r = await q.query(
        "UPDATE repositories SET status='finalized',finalized_at=statement_timestamp(),expires_at=statement_timestamp()+interval '7 days' WHERE id=$1 RETURNING expires_at",
        [id],
      );
      await audit(q, id, "finalized", "success", sender);
      return { expiresAt: r.rows[0].expires_at };
    });
  }
  async invalidate(id: string, sender: string, fail = false) {
    await this.db.transaction(async (q) => {
      const r = await q.query(
        "UPDATE repositories SET status=$3,invalidated_at=COALESCE(invalidated_at,clock_timestamp()),upload_lease=NULL WHERE id=$1 AND sender_id=$2 AND status=ANY($4::text[]) RETURNING id",
        [
          id,
          sender,
          fail ? "failed" : "revoked",
          fail
            ? ["pending", "uploading", "uploaded"]
            : ["pending", "uploading", "uploaded", "finalized"],
        ],
      );
      if (!r.rows.length) {
        const own = (
          await q.query(
            "SELECT id FROM repositories WHERE id=$1 AND sender_id=$2",
            [id, sender],
          )
        ).rows[0];
        if (!own) throw new HttpError(404);
      }
      await audit(q, id, fail ? "failed" : "revoked", "success", sender);
    });
  }
  async reissue(id: string, sender: string) {
    const capability = random();
    const r = await this.db.query(
      "UPDATE repositories SET capability_hash=$3 WHERE id=$1 AND sender_id=$2 AND status='finalized' AND expires_at>clock_timestamp() RETURNING id",
      [id, sender, digest(capability)],
    );
    if (!r.rows.length) throw new HttpError(404);
    await audit(this.db, id, "link_reissued", "success", sender);
    return { capability };
  }
  async authorize(id: string, capability: string, enabled = true) {
    if (!enabled || !/^[A-Za-z0-9_-]{43}$/.test(capability))
      throw new HttpError(404);
    const row = (
      await this.db.query(
        "SELECT r.id,r.object_key,r.ciphertext_bytes,r.expires_at FROM repositories r WHERE id=$1 AND capability_hash=$2 AND status='finalized' AND expires_at>clock_timestamp() AND (SELECT value FROM settings WHERE key='retrieval_enabled')=true",
        [id, digest(capability)],
      )
    ).rows[0];
    if (!row) throw new HttpError(404);
    return row;
  }
  async sweep(auditDays: number) {
    await this.db.query(
      "UPDATE repositories SET status=CASE WHEN status='finalized' THEN 'expired' ELSE 'abandoned' END,invalidated_at=COALESCE(invalidated_at,clock_timestamp()),upload_lease=NULL WHERE (status='finalized' AND expires_at<=clock_timestamp()) OR (status IN ('pending','uploading','uploaded') AND last_activity<=clock_timestamp()-interval '60 minutes')",
    );
    await this.db.query(
      "DELETE FROM sessions WHERE expires_at<=clock_timestamp()",
    );
    await this.db.query(
      "DELETE FROM oidc_transactions WHERE expires_at<=clock_timestamp()",
    );
    await this.db.query(
      "DELETE FROM audit WHERE at<clock_timestamp()-($1*interval '1 day')",
      [auditDays],
    );
  }
}
