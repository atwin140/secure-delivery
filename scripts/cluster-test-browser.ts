// Real deployed OIDC/application/S3 workflow. Synthetic documents and accounts only.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
if (!process.env.KUBECONFIG) throw Error("Explicit KUBECONFIG required");
const origin = "https://delivery-secure-delivery-test.apps.acm.sharkbait.tech";
const tlsVerification = process.env.TEST_CERT_MANAGER === "true";
const evidencePrefix = tlsVerification ? "cert-manager-" : "";
const secret = JSON.parse(
  execFileSync(
    "oc",
    [
      "get",
      "secret",
      "test-sender-accounts",
      "-n",
      "secure-delivery-test",
      "-o",
      "json",
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ),
);
const passwordFor = (name: string) =>
  Buffer.from(secret.data[name], "base64").toString();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  browser: browser.version(),
  origin,
  syntheticOutputAdapter: true,
};
let phase = "initialization";
try {
  async function login(name: string) {
    const context = await browser.newContext(),
      page = await context.newPage();
    await page.goto(origin);
    await page
      .getByRole("link", { name: "Sign in with your organization" })
      .click();
    await page.locator("#username").fill(name);
    await page.locator("#password").fill(passwordFor(name));
    await page.locator("#kc-login").click();
    await page.waitForURL(
      (url) =>
        url.origin === origin || url.pathname.includes("required-action"),
    );
    if (await page.locator("#email").isVisible()) {
      await page.locator("#email").fill(name + "@example.invalid");
      await page
        .locator('form input[type="submit"], form button[type="submit"]')
        .click();
    }
    return { context, page };
  }
  phase = "sender-login";
  const { context, page } = await login("sender-a");
  await page
    .getByLabel("Documents", { exact: true })
    .waitFor({ timeout: 30000 });
  await page
    .getByText("Client-side encryption active", { exact: false })
    .waitFor();
  results.realKeycloakLogin = true;
  const requests: { url: string; body: string }[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith(origin + "/api/"))
      requests.push({ url: r.url(), body: r.postData() ?? "" });
  });
  const password = await page
    .getByLabel("Bundle password", { exact: true })
    .inputValue();
  phase = "encrypt-upload-finalize";
  const canary = "CLUSTER-SYNTHETIC-PLAINTEXT-" + Date.now();
  const filename = "CLUSTER-FILENAME-CANARY.txt";
  await page.getByLabel("Documents", { exact: true }).setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(canary),
  });
  await page
    .getByRole("button", { name: "Encrypt and create delivery" })
    .click();
  await page
    .getByRole("button", { name: "Save key bundle" })
    .waitFor({ timeout: 60000 });
  const link = await page
    .getByLabel("Recipient link", { exact: true })
    .inputValue();
  const fragment = new URLSearchParams(new URL(link).hash.slice(1)),
    id = fragment.get("r")!,
    capability = fragment.get("c")!;
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save key bundle" }).click();
  const bundle = await readFile((await (await downloaded).path())!, "utf8");
  const wire = JSON.stringify(requests);
  for (const value of [canary, filename, password, bundle])
    assert(!wire.includes(value), "Sensitive value reached API");
  results.requestCanariesAbsent = true;
  results.finalized = true;
  assert(
    await page
      .getByText("Link email is disabled for this deployment.", {
        exact: false,
      })
      .isVisible(),
  );
  results.emailDisabled = true;
  const session = await (
    await context.request.get(origin + "/api/session")
  ).json();
  phase = "recipient-verification";
  const recipient = await browser.newContext(),
    rp = await recipient.newPage(),
    urls: string[] = [];
  rp.on("request", (r) => urls.push(r.url()));
  await rp.goto(link);
  assert(!rp.url().includes("#"));
  assert(
    await rp.getByRole("button", { name: "Download all as ZIP" }).isDisabled(),
  );
  await rp.getByLabel("Portable key bundle", { exact: true }).fill(bundle);
  await rp.getByLabel("Bundle password", { exact: true }).fill(password);
  await rp.getByRole("button", { name: "Retrieve and verify" }).click();
  await rp
    .getByText("Entire package verified", { exact: true })
    .waitFor({ timeout: 60000 });
  assert(
    await rp.getByRole("button", { name: "Download all as ZIP" }).isEnabled(),
  );
  assert(urls.every((u) => !u.includes(capability)));
  results.fullVerificationBeforeOutput = true;
  results.capabilityAbsentFromRequestUrls = true;
  phase = "local-outputs";
  // This explicitly synthetic adapter tests worker writes; it does not claim native Save-dialog coverage.
  await rp.evaluate(() => {
    window.showSaveFilePicker = async ({ suggestedName } = {}) =>
      (await navigator.storage.getDirectory()).getFileHandle(
        "cluster-output-" + suggestedName,
        { create: true },
      );
  });
  await rp.getByRole("button", { name: "Save file", exact: true }).click();
  await rp.getByText("Verified files saved.", { exact: true }).waitFor();
  const restored = await rp.evaluate(
    async (name) =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("cluster-output-" + name)
        ).getFile()
      ).text(),
    filename,
  );
  assert.equal(restored, canary);
  results.individualOutputMatches = true;
  await rp.getByRole("button", { name: "Download all as ZIP" }).click();
  await rp.waitForFunction(async () => {
    try {
      return (
        (
          await (
            await (
              await navigator.storage.getDirectory()
            ).getFileHandle("cluster-output-delivery.zip")
          ).getFile()
        ).size > 0
      );
    } catch {
      return false;
    }
  });
  results.zipOutputWritten = true;
  phase = "accessibility";
  const axes = [];
  for (const p of [page, rp])
    axes.push(
      (
        await new AxeBuilder({ page: p })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations.length,
    );
  assert.deepEqual(axes, [0, 0]);
  results.axeViolations = axes;
  phase = "ownership-and-role";
  const b = await login("sender-b");
  await b.page
    .getByLabel("Documents", { exact: true })
    .waitFor({ timeout: 30000 });
  const sb = await (
    await b.context.request.get(origin + "/api/session")
  ).json();
  const cross = await b.context.request.post(
    origin + `/api/repositories/${id}/revoke`,
    { headers: { origin, "x-csrf-token": sb.csrf }, data: {} },
  );
  assert([403, 404].includes(cross.status()));
  results.crossOwnerDenied = true;
  const denied = await login("denied-user");
  await denied.page.waitForURL(origin + "/**", { timeout: 30000 });
  assert.equal(
    (await denied.context.request.get(origin + "/api/session")).status(),
    401,
  );
  results.missingRoleDenied = true;
  phase = "email-server-disabled";
  const email = await context.request.post(
    origin + `/api/repositories/${id}/email`,
    {
      headers: { origin, "x-csrf-token": session.csrf },
      data: { addresses: ["synthetic@example.invalid"], capability },
    },
  );
  assert.equal(email.status(), 503);
  results.emailApiDenied = true;
  phase = "metadata-backup";
  const backupJob = "test-backup-" + Date.now().toString(36);
  execFileSync(
    "oc",
    [
      "create",
      "job",
      backupJob,
      "--from=cronjob/delivery-metadata-backup",
      "-n",
      "secure-delivery-test",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    "oc",
    [
      "wait",
      "--for=condition=complete",
      "job/" + backupJob,
      "-n",
      "secure-delivery-test",
      "--timeout=55s",
    ],
    { stdio: "pipe" },
  );
  results.backupJob = backupJob;
  results.restoreCandidateRepositoryId = id;
  results.metadataBackupWhileFinalized = true;
  phase = "revocation";
  const revoke = await context.request.post(
    origin + `/api/repositories/${id}/revoke`,
    { headers: { origin, "x-csrf-token": session.csrf }, data: {} },
  );
  assert.equal(revoke.status(), 200);
  const revoked = await recipient.request.get(origin + `/api/recipient/${id}`, {
    headers: { authorization: "Bearer " + capability },
  });
  assert([403, 404, 410].includes(revoked.status()));
  results.revokedRetrievalDenied = true;
  const orphan = await context.request.post(origin + "/api/repositories", {
    headers: { origin, "x-csrf-token": session.csrf },
    data: {},
  });
  const pending = await orphan.json();
  assert(
    [403, 404, 410].includes(
      (
        await recipient.request.get(origin + `/api/recipient/${pending.id}`, {
          headers: { authorization: "Bearer " + pending.capability },
        })
      ).status(),
    ),
  );
  await context.request.post(origin + `/api/repositories/${pending.id}/fail`, {
    headers: { origin, "x-csrf-token": session.csrf },
    data: {},
  });
  results.pendingRetrievalDenied = true;
  // Remove displayed capability/bundle before retaining screenshots.
  await page.goto(origin);
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.screenshot({
    path: `evidence/cluster-test/${evidencePrefix}sender.png`,
  });
  await rp.getByRole("button", { name: "Remove local ciphertext" }).click();
  await rp.getByText("Local ciphertext removed.", { exact: true }).waitFor();
  await rp.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries())
      if (name.startsWith("cluster-output-")) await root.removeEntry(name);
  });
  results.status = "passed";
} catch (error) {
  results.failureKind = error instanceof Error ? error.name : "unknown";
  results.status = "failed";
  results.failedPhase = phase;
  process.exitCode = 1;
} finally {
  await browser.close();
  results.finishedAt = new Date().toISOString();
  await writeFile(
    `evidence/cluster-test/${evidencePrefix}browser-workflow.json`,
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results));
}
