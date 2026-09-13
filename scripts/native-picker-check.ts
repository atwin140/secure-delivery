import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import AdmZip from "adm-zip";
const dir = resolve(".local/native-output");
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: false });
const p = await browser.newPage();
await p.goto("http://127.0.0.1:3000");
await p.getByRole("link", { name: "Use synthetic local sender" }).click();
await expect(
  p.getByText("Client-side encryption active", { exact: false }),
).toBeVisible();
const password = await p
  .getByLabel("Bundle password", { exact: true })
  .inputValue();
await p
  .getByLabel("Documents", { exact: true })
  .setInputFiles({
    name: "sd-native-canary.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("SYNTHETIC native browser output canary"),
  });
await p.getByRole("button", { name: "Encrypt and create delivery" }).click();
await expect(p.getByRole("button", { name: "Save key bundle" })).toBeVisible();
const link = await p.getByLabel("Recipient link", { exact: true }).inputValue();
const dp = p.waitForEvent("download");
await p.getByRole("button", { name: "Save key bundle" }).click();
const bundle = await readFile((await (await dp).path())!, "utf8");
const rp = await browser.newPage();
await rp.goto(link);
await rp.getByLabel("Portable key bundle", { exact: true }).fill(bundle);
await rp.getByLabel("Bundle password", { exact: true }).fill(password);
await rp.getByRole("button", { name: "Retrieve and verify" }).click();
await expect(
  rp.getByText("Entire package verified", { exact: true }),
).toBeVisible();
await rp.bringToFront();
await rp.getByRole("button", { name: "Save file", exact: true }).click();
console.log(
  "Native individual-file picker open. Save to " +
    dir +
    "/sd-native-canary.txt",
);
await expect
  .poll(
    async () => readFile(dir + "/sd-native-canary.txt", "utf8").catch(() => ""),
    { timeout: 300000 },
  )
  .toBe("SYNTHETIC native browser output canary");
await expect(
  rp.getByText("Verified files saved.", { exact: true }),
).toBeVisible();
await rp.getByRole("button", { name: "Download all as ZIP" }).click();
console.log("Native ZIP picker open. Save to " + dir + "/delivery.zip");
await expect
  .poll(
    async () =>
      readFile(dir + "/delivery.zip")
        .then((b) => b.length)
        .catch(() => 0),
    { timeout: 300000 },
  )
  .toBeGreaterThan(100);
const zip = new AdmZip(await readFile(dir + "/delivery.zip"));
expect(zip.readAsText("sd-native-canary.txt")).toBe(
  "SYNTHETIC native browser output canary",
);
await writeFile(
  "evidence/native-picker.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      browser: browser.version(),
      nativeIndividualFilePicker: true,
      nativeZipPicker: true,
      plaintextMatches: true,
      zipIndependentRead: true,
      outputLocation: ".local/native-output",
      sizeProfile: "small synthetic file; native full-size output not measured",
    },
    null,
    2,
  ) + "\n",
);
await browser.close();
console.log("Native filesystem output verified.");
