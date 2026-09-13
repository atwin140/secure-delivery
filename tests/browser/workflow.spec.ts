import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
test("cancel during repository creation never starts a later upload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Use synthetic local sender" }).click();
  await expect(
    page.getByText("Client-side encryption active", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Documents", { exact: true }).setInputFiles({
    name: "cancel.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic cancellation"),
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let uploads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/ciphertext")) uploads++;
  });
  await page.route("**/api/repositories", async (route) => {
    if (route.request().method() === "POST") await gate;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Encrypt and create delivery" })
    .click();
  await page.getByRole("button", { name: "Cancel operation" }).click();
  const failed = page.waitForResponse((r) => r.url().endsWith("/fail"));
  release();
  expect((await failed).status()).toBe(200);
  expect(uploads).toBe(0);
  await expect(
    page.getByRole("button", { name: "Encrypt and create delivery" }),
  ).toBeEnabled();
});
test("browser encryption, request canaries, full verification, accessibility and local streaming output", async ({
  page,
  browser,
}) => {
  const requests: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/"))
      requests.push({
        url: r.url(),
        body: r.postData() ?? "",
        headers: r.headers(),
      });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Use synthetic local sender" }).click();
  await expect(
    page.getByText("Client-side encryption active", { exact: false }),
  ).toBeVisible();
  const password = await page
    .getByLabel("Bundle password", { exact: true })
    .inputValue();
  await page.getByLabel("Documents", { exact: true }).setInputFiles({
    name: "BROWSER-FILENAME-CANARY.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("BROWSER-PLAINTEXT-CANARY-6aa092"),
  });
  const started = Date.now();
  await page
    .getByRole("button", { name: "Encrypt and create delivery" })
    .click();
  await expect(
    page.getByRole("button", { name: "Save key bundle" }),
  ).toBeVisible();
  const link = await page
    .getByLabel("Recipient link", { exact: true })
    .inputValue();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save key bundle" }).click();
  const download = await downloadPromise;
  const bundle = await readFile((await download.path())!, "utf8");
  const wire = JSON.stringify(requests);
  for (const canary of [
    password,
    bundle,
    "BROWSER-FILENAME-CANARY",
    "BROWSER-PLAINTEXT-CANARY",
  ])
    expect(wire).not.toContain(canary);
  const senderAxe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(senderAxe.violations).toEqual([]);
  const recipient = await browser.newContext();
  const rp = await recipient.newPage();
  const recipientUrls: string[] = [];
  rp.on("request", (r) => recipientUrls.push(r.url()));
  await rp.goto(link);
  expect(rp.url()).not.toContain("#");
  await expect(
    rp.getByRole("button", { name: "Download all as ZIP" }),
  ).toBeDisabled();
  await rp.getByLabel("Portable key bundle", { exact: true }).fill(bundle);
  await rp.getByLabel("Bundle password", { exact: true }).fill(password);
  await rp.getByRole("button", { name: "Retrieve and verify" }).click();
  await expect(
    rp.getByText("Entire package verified", { exact: true }),
  ).toBeVisible();
  await expect(
    rp.getByRole("button", { name: "Download all as ZIP" }),
  ).toBeEnabled();
  // Synthetic output adapter only: exercise real worker FileSystemWritableFileStream writes.
  // Production calls the native user file picker and does not create this adapter.
  await rp.evaluate(() => {
    window.showSaveFilePicker = async ({ suggestedName } = {}) =>
      (await navigator.storage.getDirectory()).getFileHandle(
        "test-output-" + suggestedName,
        { create: true },
      );
  });
  await rp.getByRole("button", { name: "Download all as ZIP" }).click();
  await expect(
    rp.getByText("Verified files saved.", { exact: true }),
  ).toBeVisible();
  const zipSize = await rp.evaluate(async () => {
    const root = await navigator.storage.getDirectory(),
      f = await root.getFileHandle("test-output-delivery.zip");
    return (await f.getFile()).size;
  });
  expect(zipSize).toBeGreaterThan(29);
  await rp.getByRole("button", { name: "Save file", exact: true }).click();
  await expect
    .poll(async () =>
      rp.evaluate(async () => {
        try {
          return (
            await (
              await (
                await navigator.storage.getDirectory()
              ).getFileHandle("test-output-BROWSER-FILENAME-CANARY.txt")
            ).getFile()
          ).size;
        } catch {
          return -1;
        }
      }),
    )
    .toBe(Buffer.byteLength("BROWSER-PLAINTEXT-CANARY-6aa092"));
  const plaintext = await rp.evaluate(async () => {
    const root = await navigator.storage.getDirectory(),
      f = await root.getFileHandle("test-output-BROWSER-FILENAME-CANARY.txt");
    return (await f.getFile()).text();
  });
  expect(plaintext).toBe("BROWSER-PLAINTEXT-CANARY-6aa092");
  const result = await new AxeBuilder({ page: rp })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  expect(
    recipientUrls.every(
      (u) => !u.includes("#") && !u.includes(link.split("c=")[1]),
    ),
  ).toBe(true);
  await rp.setViewportSize({ width: 3840, height: 2160 });
  await page.setViewportSize({ width: 3840, height: 2160 });
  await rp.screenshot({ path: "evidence/recipient.png" });
  await page.screenshot({ path: "evidence/sender.png" });
  await rp.getByRole("button", { name: "Remove local ciphertext" }).click();
  await expect(
    rp.getByText("Local ciphertext removed.", { exact: true }),
  ).toBeVisible();
  await rp.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for (const name of [
      "test-output-delivery.zip",
      "test-output-BROWSER-FILENAME-CANARY.txt",
    ])
      await root.removeEntry(name);
  });
  console.log(
    JSON.stringify({
      browser: browser.version(),
      workflowMs: Date.now() - started,
      output:
        "synthetic OPFS adapter; native picker requires separate manual check",
    }),
  );
  await recipient.close();
});
test("late ciphertext corruption never enables output", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Use synthetic local sender" }).click();
  await expect(
    page.getByText("Client-side encryption active", { exact: false }),
  ).toBeVisible();
  const password = await page
    .getByLabel("Bundle password", { exact: true })
    .inputValue();
  await page.getByLabel("Documents", { exact: true }).setInputFiles({
    name: "late.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(2 * 1048576, 71),
  });
  await page
    .getByRole("button", { name: "Encrypt and create delivery" })
    .click();
  await expect(
    page.getByRole("button", { name: "Save key bundle" }),
  ).toBeVisible();
  const link = await page
    .getByLabel("Recipient link", { exact: true })
    .inputValue();
  const dp = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save key bundle" }).click();
  const bundle = await readFile((await (await dp).path())!, "utf8");
  const context = await browser.newContext();
  const rp = await context.newPage();
  await rp.route("**/api/recipient/*", async (route) => {
    const response = await route.fetch();
    const body = await response.body();
    body[body.length - 1] ^= 1;
    await route.fulfill({ response, body });
  });
  await rp.goto(link);
  await rp.getByLabel("Portable key bundle", { exact: true }).fill(bundle);
  await rp.getByLabel("Bundle password", { exact: true }).fill(password);
  await rp.getByRole("button", { name: "Retrieve and verify" }).click();
  await expect(rp.getByRole("alert")).toBeVisible();
  await expect(
    rp.getByRole("button", { name: "Download all as ZIP" }),
  ).toBeDisabled();
  await context.close();
});
test("unsupported browser has a useful explanation and keyboard focus is visible", async ({
  page,
}) => {
  const entry = await page.request.get("/receive", {
    headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
  });
  expect(entry.status()).toBe(200);
  await page.addInitScript(() => {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined });
  });
  await page.goto("/receive");
  await expect(
    page.getByRole("heading", {
      name: "This browser cannot complete secure file delivery.",
    }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.locator(":focus").count()).toBe(1);
});
