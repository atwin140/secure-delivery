import { it, expect, vi } from "vitest";
import { readConfig } from "../src/server/config";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { graphMailer } from "../src/server/mail";
import { localConfig } from "./support";
it("fails closed for missing config, placeholders, insecure origins and global TLS bypass", () => {
  expect(() => readConfig({})).toThrow();
  expect(() => readConfig({ APP_ORIGIN: "https://REPLACE_HOST" })).toThrow();
  expect(() => readConfig({ APP_ORIGIN: "http://service.internal" })).toThrow();
  expect(() => readConfig({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(
    "Disabling TLS verification",
  );
});
it("requires Graph credentials by default and permits their absence only with explicit email disablement", () => {
  const dir = mkdtempSync(".local/config-");
  try {
    writeFileSync(dir + "/password", "synthetic-test-only-credential", {
      mode: 0o600,
    });
    const env = {
      APP_ORIGIN: "https://delivery.test",
      RETRIEVAL_ENABLED: "false",
      DATABASE_HOST: "db.test",
      DATABASE_NAME: "delivery",
      DATABASE_USER: "delivery",
      DATABASE_PASSWORD_FILE: dir + "/password",
      DATABASE_CA_FILE: process.env.TEST_TLS_CERT,
      OIDC_ISSUER: "https://identity.test/realms/test",
      OIDC_CLIENT_ID: "test-client",
      OIDC_ROLE_CLIENT: "test-client",
      OIDC_CLIENT_SECRET_FILE: dir + "/password",
      S3_ENDPOINT: "https://s3.test",
      S3_REGION: "test-region",
      S3_BUCKET: "test-bucket",
      S3_ACCESS_KEY_FILE: dir + "/password",
      S3_SECRET_KEY_FILE: dir + "/password",
      TLS_CERT_FILE: process.env.TEST_TLS_CERT,
      TLS_KEY_FILE: process.env.TEST_TLS_KEY,
    };
    expect(() => readConfig(env)).toThrow("GRAPH_TENANT_ID");
    expect(() =>
      readConfig({ ...env, LINK_EMAIL_ENABLED: "invalid" }),
    ).toThrow();
    const c = readConfig({ ...env, LINK_EMAIL_ENABLED: "false" });
    expect(c.emailEnabled).toBe(false);
    expect(c.graphClientSecret).toBe("");
  } finally {
    rmSync(dir, { recursive: true });
  }
});
it("makes no provider request when link email is disabled", async () => {
  const request = vi.spyOn(globalThis, "fetch");
  try {
    await expect(
      graphMailer({ ...localConfig, emailEnabled: false })(
        ["test@example.invalid"],
        "https://delivery.test/receive",
        "2030-01-01",
      ),
    ).rejects.toThrow("disabled");
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});
it("redacts production startup errors instead of dumping configuration/provider objects", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/server/main.ts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        APP_ORIGIN: "http://STARTUP-SECRET-CANARY.invalid",
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('{"event":"startup","outcome":"failure"}\n');
  expect(result.stdout).toBe("");
});
