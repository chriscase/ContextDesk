#!/usr/bin/env node
/**
 * ContextDesk Linux release-host GUI integration orchestrator.
 *
 * - Proves support matrix on this host
 * - On Linux: prepares isolation, resolves a real SPA-embedded host, runs WDIO
 * - Elsewhere: fail-closed with EXIT 2; self-tests and fixture prep still run
 *
 * Usage:
 *   node harness/run.mjs [--matrix-only] [--self-test] [--build]
 *   GUI_ACCEPT_APP_BINARY=/path/to/binary node harness/run.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  supportMatrixSnapshot,
  releaseHostWebDriverSupport,
  EXIT,
} from "./platform.mjs";
import {
  createRunDir,
  writeJson,
  appendLog,
  recordTiming,
  buildFailureBundle,
  defaultRunRoot,
} from "./artifacts.mjs";
import {
  createIsolatedHomes,
  startOllamaStub,
  setConfigOllamaBaseUrl,
  sutEnv,
} from "./env.mjs";
import {
  resolveBinary,
  repoRoot,
  assertReleaseHostBinary,
  binarySha256,
  probeSpaEmbedded,
  sourceRevision,
} from "./binary.mjs";
import { prepare25kZip } from "./fixtures.mjs";
import {
  findFreePort,
  runProcessWithTimeout,
  terminatePidTree,
} from "./process.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = join(here, "..");

function parseArgs(argv) {
  return {
    matrixOnly: argv.includes("--matrix-only"),
    selfTest: argv.includes("--self-test") || argv.includes("--self-test-only"),
    build: argv.includes("--build"),
    forceRun: argv.includes("--force-wdio"), // for CI debugging only
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const runRoot = defaultRunRoot(root);
  mkdirSync(runRoot, { recursive: true });
  const runDir = createRunDir(runRoot, "gui-accept");
  const t0 = Date.now();

  const matrix = supportMatrixSnapshot();
  writeJson(runDir, "support-matrix.json", matrix);
  appendLog(
    runDir,
    "orchestrator.log",
    `host=${matrix.os}/${matrix.arch} releaseHost=${matrix.releaseHostWebDriver.supported}\n${matrix.releaseHostWebDriver.reason}\ntauri-driver: ${matrix.tauriDriver.probe}\n`,
  );

  console.log("=== ContextDesk GUI Accept — support matrix ===");
  console.log(JSON.stringify(matrix, null, 2));

  // Always run harness unit tests (hermetic, no WebDriver).
  // Use npm script so shell expands globs (spawnSync argv does not on Linux).
  const self = spawnSync("npm", ["run", "harness:self-test"], {
    cwd: GUI_ROOT,
    encoding: "utf8",
    env: process.env,
    shell: true,
  });
  appendLog(runDir, "self-test.log", `${self.stdout || ""}\n${self.stderr || ""}`);
  writeJson(runDir, "self-test-summary.json", {
    status: self.status,
    ok: self.status === 0,
  });
  if (self.status !== 0) {
    console.error("Harness self-tests FAILED");
    console.error(self.stdout, self.stderr);
    buildFailureBundle(runDir, { reason: "self-test-failed" });
    process.exit(EXIT.SCENARIO_FAIL);
  }
  console.log("Harness self-tests: OK");
  recordTiming(runDir, "self-test", Date.now() - t0, "ok");
  // Fixture prep (always)
  const zipPath = join(runDir, "fixtures", "seven-day-25k.zip");
  mkdirSync(join(runDir, "fixtures"), { recursive: true });
  const tZip = Date.now();
  try {
    const meta = prepare25kZip(zipPath);
    writeJson(runDir, "fixtures/25k-zip.meta.json", meta);
    recordTiming(runDir, "prepare-25k-zip", Date.now() - tZip, "ok", `${meta.bytes} bytes`);
    console.log(`25k ZIP ready: ${meta.bytes} bytes sha256=${meta.sha256.slice(0, 12)}…`);
  } catch (e) {
    appendLog(runDir, "orchestrator.log", `fixture error: ${e}\n`);
    recordTiming(runDir, "prepare-25k-zip", Date.now() - tZip, "fail", String(e));
    buildFailureBundle(runDir, { reason: "fixture-prepare-failed" });
    process.exit(EXIT.SCENARIO_FAIL);
  }

  if (args.matrixOnly || args.selfTest) {
    writeJson(runDir, "result.json", {
      status: "matrix-or-self-test-only",
      exit: EXIT.OK,
      wallMs: Date.now() - t0,
      matrix,
      runDir,
    });
    console.log(`Artifacts: ${runDir}`);
    process.exit(EXIT.OK);
  }

  const support = releaseHostWebDriverSupport();
  if (!support.supported && !args.forceRun) {
    writeJson(runDir, "result.json", {
      status: "unsupported-release-host-webdriver",
      exit: EXIT.UNSUPPORTED,
      wallMs: Date.now() - t0,
      matrix,
      runDir,
      note:
        "Only Linux release-host WebDriver integration is claimed. Native macOS acceptance remains in the native-automation lane.",
    });
    console.log("");
    console.log("RELEASE_HOST_WEBDRIVER: UNSUPPORTED on this host (matrix-justified).");
    console.log(support.reason);
    console.log(`Artifacts: ${runDir}`);
    // Exit 0 for CI self-check jobs that only need matrix+self-test on macOS;
    // use GUI_ACCEPT_REQUIRE_RELEASE_HOST=1 to make unsupported a hard fail.
    if (process.env.GUI_ACCEPT_REQUIRE_RELEASE_HOST === "1") {
      process.exit(EXIT.UNSUPPORTED);
    }
    process.exit(EXIT.OK);
  }

  // Resolve real binary + stage demo-log-corpus under resource_dir (exe parent)
  const exactHead = process.env.GUI_ACCEPT_EXACT_HEAD === "1";
  const bin = resolveBinary({ build: args.build || exactHead });
  appendLog(runDir, "binary.log", bin.log || "");
  writeJson(runDir, "binary.json", {
    binary: bin.binary,
    built: bin.built,
    ms: bin.ms ?? null,
    demoResource: bin.demoResource ?? null,
    demoOk: bin.demoOk ?? null,
  });
  if (!bin.binary) {
    console.error("No host binary found. Set GUI_ACCEPT_APP_BINARY or pass --build.");
    buildFailureBundle(runDir, { reason: "no-binary" });
    process.exit(EXIT.MISSING_TOOLS);
  }
  if (bin.built && bin.ok === false) {
    console.error("fresh release-host build or deterministic resource staging failed");
    buildFailureBundle(runDir, { reason: "fresh-build-failed" });
    process.exit(EXIT.SCENARIO_FAIL);
  }
  console.log(`Binary: ${bin.binary}`);
  // Record the exact source and executable bytes used. Exact-head mode forces a
  // fresh build; an existing executable is never accepted as exact-head proof.
  const spa = probeSpaEmbedded(bin.binary);
  const sourceSha = sourceRevision(root);
  const binaryDigest = binarySha256(bin.binary);
  writeJson(runDir, "binary-identity.json", {
    binary: bin.binary,
    sourceSha,
    expectedSourceSha: process.env.GITHUB_SHA || null,
    binarySha256: binaryDigest,
    builtThisRun: bin.built,
    exactHead,
    spa,
    at: new Date().toISOString(),
  });
  if (process.env.GITHUB_SHA && sourceSha !== process.env.GITHUB_SHA) {
    console.error(
      `source revision mismatch: GITHUB_SHA=${process.env.GITHUB_SHA}, HEAD=${sourceSha}`,
    );
    buildFailureBundle(runDir, { reason: "source-revision-mismatch" });
    process.exit(EXIT.SCENARIO_FAIL);
  }
  if (exactHead && !bin.built) {
    console.error("exact-head mode requires a fresh release-host build in this run");
    buildFailureBundle(runDir, { reason: "stale-binary-refused" });
    process.exit(EXIT.SCENARIO_FAIL);
  }
  if (process.env.GUI_ACCEPT_REQUIRE_RELEASE_HOST === "1") {
    try {
      assertReleaseHostBinary(bin.binary, { requireSpa: true });
    } catch (e) {
      console.error(String(e));
      buildFailureBundle(runDir, { reason: "binary-identity-failed" });
      process.exit(EXIT.SCENARIO_FAIL);
    }
  } else if (!spa.ok) {
    console.warn(`binary SPA probe: ${spa.reason}`);
  } else {
    console.log(`SPA embed check: ok (${spa.reason})`);
  }
  if (bin.demoOk === false) {
    console.warn(
      "Demo corpus not staged beside binary — Install demo will show Demo unavailable.",
    );
  } else if (bin.demoResource) {
    console.log(`Demo resource: ${bin.demoResource}`);
  }

  // Isolation + ollama stub
  const homes = createIsolatedHomes(runDir);
  const stub = await startOllamaStub();
  setConfigOllamaBaseUrl(homes.configPath, stub.url);
  writeJson(runDir, "stub.json", { url: stub.url });

  const env = sutEnv({ home: homes.home, runDir });
  env.GUI_ACCEPT_APP_BINARY = bin.binary;
  env.GUI_ACCEPT_RUN_DIR = runDir;
  env.GUI_ACCEPT_25K_ZIP = zipPath;
  env.GUI_ACCEPT_DRIVER_PORT = String(await findFreePort());
  env.HOME = homes.home;
  // Preserve real host HOME for locating cargo tools (never use SUT home for tauri-driver)
  env.GUI_ACCEPT_HOST_HOME = process.env.HOME || process.env.GUI_ACCEPT_HOST_HOME || "";
  // Prefer explicit tauri-driver from cargo install locations used by Docker/Linux
  if (!env.TAURI_DRIVER_PATH) {
    const candidates = [
      process.env.TAURI_DRIVER_PATH,
      process.env.CARGO_HOME
        ? join(process.env.CARGO_HOME, "bin", "tauri-driver")
        : null,
      "/cargo-home/bin/tauri-driver",
      join(env.GUI_ACCEPT_HOST_HOME, ".cargo", "bin", "tauri-driver"),
    ].filter(Boolean);
    for (const p of candidates) {
      if (existsSync(p)) {
        env.TAURI_DRIVER_PATH = p;
        break;
      }
    }
  }
  if (process.env.CARGO_HOME) env.CARGO_HOME = process.env.CARGO_HOME;

  // Ensure node_modules for wdio
  if (exactHead || !existsSync(join(GUI_ROOT, "node_modules", "webdriverio"))) {
    console.log("Installing locked gui-accept npm deps…");
    const npm = spawnSync("npm", ["ci"], {
      cwd: GUI_ROOT,
      encoding: "utf8",
      env: process.env,
      timeout: 300_000,
    });
    appendLog(runDir, "npm-ci.log", `${npm.stdout || ""}\n${npm.stderr || ""}`);
    if (npm.status !== 0) {
      await stub.close().catch(() => {});
      buildFailureBundle(runDir, { reason: "npm-ci-failed" });
      process.exit(EXIT.MISSING_TOOLS);
    }
  }

  console.log("=== Running WDIO scenarios against real binary ===");
  const tWdio = Date.now();
  // WebKitWebDriver can be noisy. Bound both output and wall time, and terminate
  // the complete WDIO/driver/application process tree on timeout.
  if (!env.GUI_ACCEPT_WDIO_LOG) env.GUI_ACCEPT_WDIO_LOG = "warn";
  const wdio = await runProcessWithTimeout("npx", ["wdio", "run", "wdio.conf.mjs"], {
    cwd: GUI_ROOT,
    env,
    timeoutMs: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  appendLog(runDir, "wdio.log", `${wdio.stdout || ""}\n${wdio.stderr || ""}`);
  if (wdio.error) {
    appendLog(runDir, "wdio.log", `spawn error: ${wdio.error}\n`);
  }
  // WDIO normally performs this cleanup. The recorded detached driver group is
  // also reaped here so an outer timeout/crash cannot orphan driver/app children.
  const driverPidPath = join(runDir, "logs", "tauri-driver.pid");
  if (existsSync(driverPidPath)) {
    const driverPid = Number(readFileSync(driverPidPath, "utf8").trim());
    await terminatePidTree(driverPid);
  }
  recordTiming(
    runDir,
    "wdio-suite",
    Date.now() - tWdio,
    wdio.status === 0 ? "ok" : "fail",
  );

  await stub.close().catch(() => {});

  writeJson(runDir, "result.json", {
    status: wdio.status === 0 ? "passed" : "failed",
    exit: wdio.status === 0 ? EXIT.OK : EXIT.SCENARIO_FAIL,
    wallMs: Date.now() - t0,
    matrix,
    binary: bin.binary,
    sourceSha,
    binarySha256: binaryDigest,
    proofScope: exactHead
      ? "exact-head Linux release-host GUI integration"
      : "non-exact local Linux release-host GUI integration",
    runDir,
  });

  if (wdio.status !== 0) {
    buildFailureBundle(runDir, { reason: "wdio-failed" });
    console.error(wdio.stdout);
    console.error(wdio.stderr);
    process.exit(EXIT.SCENARIO_FAIL);
  }

  console.log(`GATE: Linux release-host GUI scenarios passed in ${Date.now() - t0}ms`);
  console.log(`Artifacts: ${runDir}`);
  process.exit(EXIT.OK);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
