import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";

// The spec starts its own disposable built server, SQLite database, and bench.
const { webServer: ignoredFixtureServer, ...withoutFixtureServer } = base;
void ignoredFixtureServer;
export default defineConfig({ ...withoutFixtureServer, grep: /@joined trusted benchmark handoff/, retries: 0, workers: 1 });
