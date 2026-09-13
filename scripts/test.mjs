import { mkdir } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
await mkdir(".local/test-tls", { recursive: true });
const cert = resolve(".local/test-tls/cert.pem"),
  key = resolve(".local/test-tls/key.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);
const r = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: cert,
      TEST_TLS_CERT: cert,
      TEST_TLS_KEY: key,
    },
  },
);
process.exitCode = r.status ?? 1;
