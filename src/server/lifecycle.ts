import pg from "pg";
import { Repositories, audit } from "./db";
import type { Storage } from "./storage";
import type { Config } from "./config";
export class Streams {
  private checks = new Map<AbortController, () => Promise<void>>();
  add(c: AbortController, check: () => Promise<void>) {
    this.checks.set(c, check);
    return () => this.checks.delete(c);
  }
  async check() {
    await Promise.all(
      [...this.checks].map(async ([c, f]) => {
        try {
          await f();
        } catch {
          c.abort();
        }
      }),
    );
  }
  stop() {
    for (const c of this.checks.keys()) c.abort();
  }
}
export async function listenRevocations(c: Config, streams: Streams) {
  const client = new pg.Client({
    connectionString: c.databaseUrl,
    ssl: { ca: c.databaseCa, rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
  });
  client.on("error", () => streams.stop());
  client.on("end", () => streams.stop());
  client.on("notification", () => {
    void streams.check();
  });
  await client.connect();
  await client.query("LISTEN delivery_state");
  return () => client.end();
}
export async function cleanup(
  repos: Repositories,
  storage: Storage,
  auditDays: number,
) {
  await repos.sweep(auditDays);
  const rows = (
    await repos.db.query(
      "SELECT id,object_key,multipart_id FROM repositories WHERE invalidated_at IS NOT NULL AND deleted_at IS NULL ORDER BY invalidated_at LIMIT 100",
    )
  ).rows;
  let failures = 0;
  for (const row of rows) {
    try {
      await repos.db.query(
        "UPDATE repositories SET delete_attempts=delete_attempts+1,last_delete_attempt=clock_timestamp() WHERE id=$1",
        [row.id],
      );
      if (row.multipart_id)
        await storage.abort(row.object_key, row.multipart_id);
      await storage.remove(row.object_key);
      if (await storage.exists(row.object_key))
        throw new Error("Deletion not confirmed");
      await repos.db.query(
        "UPDATE repositories SET deleted_at=clock_timestamp(),multipart_id=NULL WHERE id=$1",
        [row.id],
      );
      await audit(repos.db, row.id, "ciphertext_absence_confirmed", "success");
    } catch {
      failures++;
    }
  }
  for await (const u of storage.multiparts()) {
    if (u.at.getTime() > Date.now() - 3600000) continue;
    const active = (
      await repos.db.query(
        "SELECT id FROM repositories WHERE object_key=$1 AND multipart_id=$2 AND status='uploading' AND last_activity>clock_timestamp()-interval '60 minutes'",
        [u.key, u.id],
      )
    ).rows.length;
    if (!active) {
      try {
        await storage.abort(u.key, u.id);
      } catch {
        failures++;
      }
    }
  }
  for await (const o of storage.objects()) {
    if (o.at.getTime() > Date.now() - 7200000) continue;
    const row = (
      await repos.db.query(
        "SELECT status,invalidated_at FROM repositories WHERE object_key=$1",
        [o.key],
      )
    ).rows[0];
    if (!row || row.invalidated_at) {
      try {
        await storage.remove(o.key);
        if (await storage.exists(o.key)) throw new Error();
        await audit(
          repos.db,
          row ? o.key : null,
          "orphan_absence_confirmed",
          "success",
        );
      } catch {
        failures++;
      }
    }
  }
  const overdue = Number(
    (
      await repos.db.query(
        "SELECT count(*) AS n FROM repositories WHERE invalidated_at<clock_timestamp()-interval '23 hours' AND deleted_at IS NULL",
      )
    ).rows[0].n,
  );
  return { failures, overdue };
}
