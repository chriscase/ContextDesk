import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
export default defineConfig({ ...base, grep: /@joined/, retries: 0, workers: 1,
  webServer: { command: "node --import tsx/esm src/serve-s3-fixture.mjs", url: `http://127.0.0.1:${process.env.COLLAB_E2E_PORT ?? "8788"}/health`,
    reuseExistingServer: false, timeout: 120_000, stdout: "pipe", stderr: "pipe" } });
