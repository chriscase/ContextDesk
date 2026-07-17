#!/usr/bin/env node
/**
 * ContextDesk `tauri dev` wrapper with sustainable port conflict handling.
 *
 * Many Tauri templates hardcode Vite on 1420 (already taken on this machine).
 * This script picks a free port and keeps Vite + Tauri in sync via:
 *   - CD_DEV_PORT / PORT for Vite
 *   - tauri --config merge for build.devUrl
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pickDevPort, CONTEXTDESK_BASE_PORT } from "./dev-port.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");

const { port, source } = await pickDevPort();
const devUrl = `http://localhost:${port}`;

console.log(
  `[contextdesk] dev UI → ${devUrl} (source=${source}, base=${CONTEXTDESK_BASE_PORT}; override with CD_DEV_PORT=…)`,
);

const configMerge = JSON.stringify({
  build: {
    devUrl,
    // beforeDevCommand inherits env below so Vite uses the same port
  },
});

const env = {
  ...process.env,
  CD_DEV_PORT: String(port),
  PORT: String(port),
  // Vite picks this up in vite.config.ts
  VITE_DEV_PORT: String(port),
};

const tauriCli = path.join(
  desktopRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

const child = spawn(
  process.execPath,
  [tauriCli, "dev", "--config", configMerge, ...process.argv.slice(2)],
  {
    cwd: desktopRoot,
    env,
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
