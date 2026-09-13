import https from "node:https";
import { randomBytes, createHash } from "node:crypto";
import { readConfig } from "../src/server/config";
import { productionDb, migrate, Repositories } from "../src/server/db";
import { S3Storage } from "../src/server/storage";
import { cleanup } from "../src/server/lifecycle";
import { safeRestoreInvalidate } from "../src/server/restore";
const command = process.argv[2];
try {
  const config = readConfig();
  if (command === "health" || command === "live") {
    const host = process.env.APP_INTERNAL_HOST;
    if (!host) throw new Error("APP_INTERNAL_HOST required");
    await new Promise<void>((resolve, reject) => {
      const req = https.get(
        {
          // Probe this replica directly. An unready replica is excluded from
          // Service endpoints, so probing the Service deadlocks first startup.
          hostname: "127.0.0.1",
          servername: host,
          port: 8443,
          path: command === "health" ? "/health/ready" : "/health/live",
          ca: config.databaseCa,
          rejectUnauthorized: true,
          timeout: 5000,
        },
        (response) => {
          response.resume();
          response.statusCode === 200
            ? resolve()
            : reject(new Error("Health check failed"));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", reject);
    });
  } else {
    const db = productionDb(config),
      storage = new S3Storage(config),
      repos = new Repositories(db);
    try {
      if (command === "migrate") await migrate(db);
      else if (command === "restore-invalidate")
        await safeRestoreInvalidate(db);
      else if (command === "disable-retrieval")
        await db.query(
          "UPDATE settings SET value=false WHERE key='retrieval_enabled'",
        );
      else if (command === "enable-retrieval") {
        const outstanding = (
          await db.query(
            "SELECT id FROM repositories WHERE invalidated_at IS NOT NULL AND deleted_at IS NULL LIMIT 1",
          )
        ).rows;
        if (outstanding.length)
          throw new Error("Unreconciled invalidated objects");
        await storage.preflight();
        await db.query(
          "UPDATE settings SET value=true WHERE key='retrieval_enabled'",
        );
      } else if (command === "cleanup") {
        const result = await cleanup(repos, storage, config.auditDays);
        console.log(JSON.stringify(result));
        if (result.failures || result.overdue) process.exitCode = 1;
      } else if (command === "preflight") {
        await storage.preflight();
        const key = randomBytes(16).toString("hex"),
          bytes = randomBytes(256),
          sha = createHash("sha256").update(bytes).digest("hex"),
          abort = new AbortController();
        try {
          await storage.upload(
            key,
            (async function* () {
              yield bytes;
            })(),
            bytes.length,
            sha,
            abort.signal,
            async () => {},
            async () => {},
          );
          const body = await storage.get(key, abort.signal);
          const parts: Buffer[] = [];
          for await (const p of body) parts.push(p);
          if (!Buffer.concat(parts).equals(bytes))
            throw new Error("S3 roundtrip mismatch");
          const probe = new URL(
            config.s3Endpoint +
              "/" +
              encodeURIComponent(config.s3Bucket) +
              "/" +
              key,
          );
          const anonymous = await fetch(probe, {
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          await anonymous.body?.cancel();
          if (![403, 404].includes(anonymous.status))
            throw new Error("Unauthenticated bucket access not denied");
        } finally {
          await storage.remove(key);
        }
        if (await storage.exists(key))
          throw new Error("S3 deletion absence not confirmed");
        await storage.preflight();
        console.log(
          JSON.stringify({
            event: "storage_preflight",
            result: "passed",
            roundtrip: true,
            deleteAbsence: true,
            anonymousAccessDenied: true,
            note: "ODF operator/backing-store attestations still required",
          }),
        );
      } else throw new Error("Unknown administrative command");
    } finally {
      await db.close();
      storage.client.destroy();
    }
  }
} catch {
  process.stderr.write(
    "Administrative check failed. Review configuration and provider access without logging secret values.\n",
  );
  process.exitCode = 1;
}
