import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { embeddedDb, LocalAuth, localConfig } from "../tests/support";
import { buildApp } from "../src/server/app";
import { cleanup } from "../src/server/lifecycle";
import type { Storage } from "../src/server/storage";
import type { Source } from "../src/crypto/bytes";
// This executable is deliberately separate from the production entrypoint.
const base = resolve(".local");
await mkdir(join(base, "ciphertext"), { recursive: true });
const db = await embeddedDb(join(base, "metadata"));
await db.query("UPDATE settings SET value=true WHERE key='retrieval_enabled'");
class LocalDisk implements Storage {
  path(key: string) {
    if (!/^[a-f0-9]{32}$/.test(key)) throw new Error("Opaque ID required");
    return join(base, "ciphertext", key);
  }
  async upload(
    key: string,
    source: Source,
    expected: number,
    hash: string,
    signal: AbortSignal,
    started: (id: string) => Promise<void>,
    activity: () => Promise<void>,
  ) {
    await started("synthetic-local");
    const file = await open(this.path(key), "w", 0o600);
    let n = 0;
    const sha = createHash("sha256");
    try {
      for await (const b of source) {
        if (signal.aborted) throw new Error("Cancelled");
        n += b.length;
        if (n > expected) throw new Error("Too large");
        sha.update(b);
        await file.writeFile(b);
        await activity();
      }
      if (n !== expected || sha.digest("hex") !== hash)
        throw new Error("Integrity");
    } finally {
      await file.close();
    }
  }
  async get(key: string, _signal: AbortSignal) {
    return createReadStream(this.path(key), { highWaterMark: 1048576 });
  }
  async remove(key: string) {
    await unlink(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch (e: any) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }
  async *objects() {
    for (const key of await readdir(join(base, "ciphertext")))
      if (/^[a-f0-9]{32}$/.test(key))
        yield { key, at: (await stat(this.path(key))).mtime };
  }
  async *multiparts(): AsyncGenerator<{ key: string; id: string; at: Date }> {}
  async abort(_key: string, _id: string) {}
}
const storage = new LocalDisk();
const { app, repos } = await buildApp({
  config: localConfig,
  db,
  storage,
  auth: new LocalAuth(db, localConfig),
  mailer: async () => {},
});
const timer = setInterval(() => {
  void cleanup(repos, storage, 90).catch(() => {});
}, 60000);
await app.listen({ host: "127.0.0.1", port: 3000 });
process.stdout.write(
  "Local synthetic application: http://127.0.0.1:3000\nNo live email or production identity providers are connected.\n",
);
for (const s of ["SIGINT", "SIGTERM"] as const)
  process.on(s, () => {
    clearInterval(timer);
    void app.close().then(() => db.close());
  });
