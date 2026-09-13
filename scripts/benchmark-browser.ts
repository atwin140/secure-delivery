import { chromium, expect } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  rm,
  open,
  readFile,
  writeFile,
  unlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
await mkdir(".local/browser-benchmark", { recursive: true });
const paths: string[] = [];
const sizes = [250, 250, 250, 250, 24, ...Array(95).fill(0)];
for (let i = 0; i < sizes.length; i++) {
  const path = resolve(
    ".local/browser-benchmark",
    `file-${String(i).padStart(3, "0")}.bin`,
  );
  const f = await open(path, "w");
  await f.truncate(sizes[i] * 1048576);
  await f.close();
  paths.push(path);
}
const profilePath = await mkdtemp(resolve(".local/browser-profile-"));
const profile = await chromium.launchPersistentContext(profilePath, {
  channel: "chrome",
  headless: true,
});
const browser = profile.browser()!;
const browserCdp = await browser.newBrowserCDPSession();
const rootPid = Number(
  (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.find(
    (p: any) => p.type === "browser",
  )?.id,
);
console.log("Benchmark: normal persistent Chrome profile started.");
let peakRss = 0;
const sample = () => {
  try {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((s) => s.trim().split(/\s+/).map(Number));
    const ids = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows)
        if (ids.has(ppid) && !ids.has(pid)) {
          ids.add(pid);
          changed = true;
        }
    }
    peakRss = Math.max(
      peakRss,
      rows.filter(([id]) => ids.has(id)).reduce((n, r) => n + r[2] * 1024, 0),
    );
  } catch {}
};
const sampling = setInterval(sample, 500);
const results: Record<string, unknown> = {
  browser: browser.version(),
  plaintextBytes: 1073741824,
  files: 100,
  largestIndividualBytes: 262144000,
};
let id: string | undefined;
try {
  await profile.clearCookies();
  const page = await profile.newPage();
  page.setDefaultTimeout(30000);
  await page.goto("http://127.0.0.1:3000");
  await page.getByRole("link", { name: "Use synthetic local sender" }).click();
  await expect(
    page.getByText("Client-side encryption active", { exact: false }),
  ).toBeVisible();
  const password = await page
    .getByLabel("Bundle password", { exact: true })
    .inputValue();
  await page.getByLabel("Documents", { exact: true }).setInputFiles(paths);
  let t = performance.now();
  await page
    .getByRole("button", { name: "Encrypt and create delivery" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("[role=alert]")?.textContent ||
      Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent === "Save key bundle",
      ),
    {},
    { timeout: 300000 },
  );
  const error = (await page.getByRole("alert").count())
    ? await page.getByRole("alert").textContent()
    : "";
  if (error) throw new Error(error);
  console.log("Benchmark: encrypted, uploaded and finalized.");
  results.encryptUploadFinalizeMs = performance.now() - t;
  const link = await page
    .getByLabel("Recipient link", { exact: true })
    .inputValue();
  id = new URLSearchParams(new URL(link).hash.slice(1)).get("r")!;
  const dp = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save key bundle" }).click();
  const bundle = await readFile((await (await dp).path())!, "utf8");
  const ctx = profile;
  const rp = await ctx.newPage();
  await rp.addInitScript(() => {
    const Base = window.Worker;
    (window as any).__measurements = [];
    window.Worker = class extends Base {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (e) => {
          if (e.data.type === "benchmark")
            (window as any).__measurements.push(e.data);
        });
      }
    };
  });
  await rp.goto(link);
  await rp.getByLabel("Portable key bundle", { exact: true }).fill(bundle);
  await rp.getByLabel("Bundle password", { exact: true }).fill(password);
  t = performance.now();
  await rp.getByRole("button", { name: "Retrieve and verify" }).click();
  await expect(
    rp.getByText("Entire package verified", { exact: true }),
  ).toBeVisible({ timeout: 300000 });
  results.retrieveVerifyMs = performance.now() - t;
  console.log("Benchmark: whole package retrieved and verified.");
  results.unlock = await rp.evaluate(() => (window as any).__measurements);
  await rp.evaluate(() => {
    window.showSaveFilePicker = async ({ suggestedName } = {}) =>
      (await navigator.storage.getDirectory()).getFileHandle(
        "benchmark-output-" + suggestedName,
        { create: true },
      );
  });
  t = performance.now();
  await rp
    .getByRole("button", { name: "Save file", exact: true })
    .first()
    .click();
  await expect(
    rp.getByText("Verified files saved.", { exact: true }),
  ).toBeVisible({ timeout: 300000 });
  results.individualOutputMs = performance.now() - t;
  console.log("Benchmark: 250 MiB individual file saved.");
  const individualSize = await rp.evaluate(
    async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("benchmark-output-file-000.bin")
        ).getFile()
      ).size,
  );
  expect(individualSize).toBe(262144000);
  t = performance.now();
  await rp.getByRole("button", { name: "Download all as ZIP" }).click();
  await expect
    .poll(
      async () =>
        rp.evaluate(async () => {
          try {
            return (
              await (
                await (
                  await navigator.storage.getDirectory()
                ).getFileHandle("benchmark-output-delivery.zip")
              ).getFile()
            ).size;
          } catch {
            return 0;
          }
        }),
      { timeout: 300000, intervals: [500] },
    )
    .toBeGreaterThan(1073741824);
  await expect(
    rp.getByRole("button", { name: "Download all as ZIP" }),
  ).toBeEnabled({ timeout: 300000 });
  results.zipOutputMs = performance.now() - t;
  results.zipBytes = await rp.evaluate(
    async () =>
      (
        await (
          await (
            await navigator.storage.getDirectory()
          ).getFileHandle("benchmark-output-delivery.zip")
        ).getFile()
      ).size,
  );
  await rp.getByRole("button", { name: "Remove local ciphertext" }).click();
  await expect(
    rp.getByText("Local ciphertext removed.", { exact: true }),
  ).toBeVisible();
  await rp.evaluate(async () => {
    const r = await navigator.storage.getDirectory();
    await r.removeEntry("benchmark-output-file-000.bin");
    await r.removeEntry("benchmark-output-delivery.zip");
  });
  const session = await (
    await page.request.get("http://127.0.0.1:3000/api/session")
  ).json();
  await page.request.post(
    `http://127.0.0.1:3000/api/repositories/${id}/revoke`,
    {
      headers: {
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": session.csrf,
      },
      data: {},
    },
  );
  sample();
  results.peakChromeProcessTreeRssBytes = peakRss;
  results.at = new Date().toISOString();
  results.outputCaveat =
    "Synthetic OPFS output adapter exercises real browser worker/FileSystemWritableFileStream writes. Does not establish native picker or external filesystem output performance.";
  await writeFile(
    "evidence/benchmark-browser.json",
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results));
} catch (error) {
  await writeFile(
    "evidence/benchmark-browser.json",
    JSON.stringify(
      {
        ...results,
        status: "failed",
        reason: (error as Error).message.split("\n")[0],
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Browser benchmark failed; see evidence/benchmark-browser.json.");
  process.exitCode = 1;
} finally {
  clearInterval(sampling);
  await profile.close();
  await rm(profilePath, { recursive: true, force: true });
  for (const path of paths) await unlink(path).catch(() => {});
  if (id) await unlink(".local/ciphertext/" + id).catch(() => {});
}
