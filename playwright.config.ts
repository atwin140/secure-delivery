import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  timeout: 180000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3000",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx scripts/local.ts",
    url: "http://127.0.0.1:3000/health/live",
    reuseExistingServer: true,
  },
  reporter: [["list"], ["json", { outputFile: "evidence/browser-tests.json" }]],
});
