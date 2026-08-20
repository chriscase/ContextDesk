import { defineConfig, devices } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.COLLAB_E2E_PORT ?? "8788", 10);
const baseURL = process.env.COLLAB_E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const startFixture = process.env.COLLAB_E2E_START_FIXTURE !== "0";

const webServer = {
  command: "npx tsx src/serve-fixture.ts",
  cwd: here,
  url: `${baseURL}/health`,
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
  stdout: "pipe" as const,
  stderr: "pipe" as const,
};

export default defineConfig({
  testDir: join(here, "specs"),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  ...(startFixture ? { webServer } : {}),
});
