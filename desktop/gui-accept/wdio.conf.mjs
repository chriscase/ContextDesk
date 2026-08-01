/**
 * WebdriverIO + tauri-driver config for ContextDesk release-host integration.
 * Linux only. Does not embed WebDriver plugins in the product.
 *
 * Env:
 *   GUI_ACCEPT_APP_BINARY — path to real host binary (required)
 *   GUI_ACCEPT_RUN_DIR — artifact directory
 *   TAURI_DRIVER_PATH — absolute path to tauri-driver (required under isolated HOME)
 *   HOME — isolated home for the SUT (must NOT be used to find tauri-driver)
 */

import { spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import {
  assertPortFree,
  terminateProcessTree,
  waitForOwnedPort,
} from "./harness/process.mjs";

const binary = process.env.GUI_ACCEPT_APP_BINARY;
const runDir =
  process.env.GUI_ACCEPT_RUN_DIR || join(process.cwd(), ".runs", "wdio-adhoc");
const driverPort = Number(process.env.GUI_ACCEPT_DRIVER_PORT);
const driverPidPath = join(runDir, "logs", "tauri-driver.pid");
if (!Number.isInteger(driverPort) || driverPort < 1024 || driverPort > 65535) {
  throw new Error("GUI_ACCEPT_DRIVER_PORT must be an allocated non-privileged port");
}

/** @type {import('child_process').ChildProcess | null} */
let tauriDriver = null;

/**
 * Resolve tauri-driver without using the SUT isolated HOME.
 * Priority: TAURI_DRIVER_PATH → CARGO_HOME/bin → /cargo-home/bin → ~/.cargo/bin of host.
 */
function tauriDriverPath() {
  const candidates = [
    process.env.TAURI_DRIVER_PATH,
    process.env.CARGO_HOME ? join(process.env.CARGO_HOME, "bin", "tauri-driver") : null,
    "/cargo-home/bin/tauri-driver",
    "/usr/local/cargo/bin/tauri-driver",
    // Only use host HOME if GUI_ACCEPT_HOST_HOME is set (never SUT home)
    process.env.GUI_ACCEPT_HOST_HOME
      ? join(process.env.GUI_ACCEPT_HOST_HOME, ".cargo", "bin", "tauri-driver")
      : null,
  ].filter(Boolean);

  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  // Linux-only last resort: PATH lookup.
  const r = spawnSync("which", ["tauri-driver"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [
        process.env.CARGO_HOME ? `${process.env.CARGO_HOME}/bin` : null,
        "/cargo-home/bin",
        process.env.PATH,
      ]
        .filter(Boolean)
        .join(delimiter),
    },
  });
  if (r.status === 0 && r.stdout?.trim()) return r.stdout.trim();
  return "tauri-driver";
}

export const config = {
  specs: ["./specs/**/*.spec.mjs"],
  maxInstances: 1,
  // Classic tauri-driver (not embedded WDIO service): only tauri:options.
  // browserName: "wry" causes "Failed to match capabilities" with tauri-driver + WebKitWebDriver.
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: binary,
      },
    },
  ],
  logLevel: process.env.GUI_ACCEPT_WDIO_LOG || "info",
  bail: 0,
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 300_000,
  },
  hostname: "127.0.0.1",
  port: driverPort,
  path: "/",

  async onPrepare() {
    if (!binary || !existsSync(binary)) {
      throw new Error(
        `GUI_ACCEPT_APP_BINARY missing or not a file: ${binary ?? "(unset)"}`,
      );
    }
    mkdirSync(join(runDir, "screenshots"), { recursive: true });
    mkdirSync(join(runDir, "logs"), { recursive: true });
    await assertPortFree(driverPort);

    const driverBin = tauriDriverPath();
    writeFileSync(
      join(runDir, "logs", "wdio-prepare.json"),
      JSON.stringify(
        {
          binary,
          driverPort,
          driverBin,
          cargoHome: process.env.CARGO_HOME || null,
          home: process.env.HOME || null,
          display: process.env.DISPLAY || null,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    if (!existsSync(driverBin) && driverBin !== "tauri-driver") {
      throw new Error(
        `tauri-driver not found at ${driverBin}. Set TAURI_DRIVER_PATH.`,
      );
    }

    const logPath = join(runDir, "logs", "tauri-driver.log");
    writeFileSync(logPath, `starting ${driverBin} --port ${driverPort}\n`);

    // Spawn with PATH that includes cargo bins; keep SUT HOME for the app child.
    const pathParts = [
      process.env.CARGO_HOME ? join(process.env.CARGO_HOME, "bin") : null,
      "/cargo-home/bin",
      process.env.PATH,
    ]
      .filter(Boolean)
      .join(delimiter);

    tauriDriver = spawn(driverBin, ["--port", String(driverPort)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: pathParts,
      },
      // One process group lets teardown kill tauri-driver and its app child.
      detached: process.platform !== "win32",
    });
    if (tauriDriver.pid) {
      writeFileSync(driverPidPath, `${tauriDriver.pid}\n`);
    }
    tauriDriver.stdout?.on("data", (d) => {
      appendFileSync(logPath, d);
    });
    tauriDriver.stderr?.on("data", (d) => {
      appendFileSync(logPath, d);
    });
    tauriDriver.on("error", (err) => {
      writeFileSync(
        join(runDir, "logs", "tauri-driver-error.txt"),
        String(err),
      );
    });
    tauriDriver.on("exit", (code, signal) => {
      appendFileSync(
        logPath,
        `\n[exit] code=${code} signal=${signal}\n`,
      );
    });

    try {
      await waitForOwnedPort(tauriDriver, driverPort, 45_000);
      appendFileSync(logPath, `listening on ${driverPort}\n`);
    } catch (e) {
      appendFileSync(logPath, `wait failed: ${e}\n`);
      await terminateProcessTree(tauriDriver);
      tauriDriver = null;
      rmSync(driverPidPath, { force: true });
      throw e;
    }
  },

  async onComplete() {
    await terminateProcessTree(tauriDriver);
    tauriDriver = null;
    rmSync(driverPidPath, { force: true });
  },

  /**
   * @param {string} testTitle
   * @param {object} _context
   * @param {Error} error
   */
  async afterTest(test, _context, { error }) {
    if (!error) return;
    try {
      const file = join(
        runDir,
        "screenshots",
        `${Date.now()}-${sanitize(test.title)}.png`,
      );
      // @ts-expect-error browser global from wdio
      await browser.saveScreenshot(file);
    } catch {
      /* screenshot best-effort */
    }
  },
};

function sanitize(s) {
  return String(s)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
}
