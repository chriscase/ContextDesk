/**
 * Platform support for release-host WebDriver integration.
 * Only the measured Linux path is claimed. Native desktop acceptance and
 * installed bundle behavior remain separate lanes.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { platform } from "node:process";

/** @typedef {'linux'|'windows'|'macos'|'other'} HostOs */

/**
 * @returns {HostOs}
 */
export function hostOs() {
  switch (platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "other";
  }
}

/**
 * Direct tauri-driver + WebKitWebDriver (no production plugins).
 * @returns {{ supported: boolean, reason: string, driver: 'tauri-driver'|'none', provider: string }}
 */
export function releaseHostWebDriverSupport() {
  const osName = hostOs();
  if (osName === "linux") {
    return {
      supported: true,
      reason:
        "Linux: tauri-driver + WebKitWebDriver drive the SPA-embedded release host without app plugins. This is not installed-bundle or native-input proof.",
      driver: "tauri-driver",
      provider: "native-webkit",
    };
  }
  if (osName === "windows") {
    return {
      supported: false,
      reason:
        "Windows is not claimed until known-folder data isolation, driver discovery, and hosted proof are implemented.",
      driver: "none",
      provider: "none",
    };
  }
  if (osName === "macos") {
    return {
      supported: false,
      reason:
        "macOS: direct tauri-driver is unsupported (no WKWebView system driver). Native macOS checks belong to the native-automation lane.",
      driver: "none",
      provider: "none",
    };
  }
  return {
    supported: false,
    reason: `Unsupported host platform ${platform}`,
    driver: "none",
    provider: "none",
  };
}

/**
 * Probe whether `tauri-driver` is installed and whether it refuses this OS.
 * @returns {{ present: boolean, path: string|null, probe: string }}
 */
export function probeTauriDriver() {
  const candidates = [
    process.env.TAURI_DRIVER_PATH,
    "tauri-driver",
    `${os.homedir()}/.cargo/bin/tauri-driver`,
  ].filter(Boolean);

  for (const bin of candidates) {
    if (bin !== "tauri-driver" && !existsSync(bin)) continue;
    const r = spawnSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
    if (r.error && r.error.code === "ENOENT") continue;
    return {
      present: true,
      path: bin,
      probe: out || `exit=${r.status}`,
    };
  }
  return { present: false, path: null, probe: "tauri-driver not found on PATH" };
}

/**
 * @returns {{ os: HostOs, arch: string, releaseHostWebDriver: ReturnType<typeof releaseHostWebDriverSupport>, tauriDriver: ReturnType<typeof probeTauriDriver>, measuredAt: string }}
 */
export function supportMatrixSnapshot() {
  return {
    os: hostOs(),
    arch: os.arch(),
    releaseHostWebDriver: releaseHostWebDriverSupport(),
    tauriDriver: probeTauriDriver(),
    measuredAt: new Date().toISOString(),
  };
}

/**
 * Exit codes for harness orchestration.
 * 0 = scenarios ran (or self-tests only on unsupported OS with --matrix-only)
 * 2 = platform unsupported for release-host WebDriver (expected off Linux)
 * 3 = missing tools on a supported OS
 * 4 = scenario failure
 */
export const EXIT = {
  OK: 0,
  UNSUPPORTED: 2,
  MISSING_TOOLS: 3,
  SCENARIO_FAIL: 4,
};
