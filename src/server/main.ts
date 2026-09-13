import { readConfig } from "./config";
import { productionDb } from "./db";
import { OidcAuth } from "./auth";
import { S3Storage } from "./storage";
import { graphMailer } from "./mail";
import { buildApp } from "./app";
import { cleanup, listenRevocations, Streams } from "./lifecycle";
async function main() {
  const config = readConfig(),
    db = productionDb(config),
    storage = new S3Storage(config),
    streams = new Streams();
  const { app, repos } = await buildApp({
    config,
    db,
    storage,
    auth: new OidcAuth(db, config),
    mailer: graphMailer(config),
    streams,
  });
  const stopListen = await listenRevocations(config, streams);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await cleanup(repos, storage, config.auditDays);
      process.stdout.write(
        JSON.stringify({ event: "cleanup", ...result }) + "\n",
      );
    } catch {
      process.stdout.write('{"event":"cleanup","outcome":"failure"}\n');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 60000);
  await tick();
  await app.listen({ host: "0.0.0.0", port: 8443 });
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      clearInterval(timer);
      streams.stop();
      void app
        .close()
        .then(stopListen)
        .then(() => db.close())
        .catch(() => {
          process.stderr.write('{"event":"shutdown","outcome":"failure"}\n');
        });
    });
}
void main().catch(() => {
  process.stderr.write('{"event":"startup","outcome":"failure"}\n');
  process.exit(1);
});
