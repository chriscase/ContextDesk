import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hostOs,
  releaseHostWebDriverSupport,
  probeTauriDriver,
  supportMatrixSnapshot,
} from "./platform.mjs";

describe("platform support matrix", () => {
  it("returns a known host OS", () => {
    assert.ok(["linux", "windows", "macos", "other"].includes(hostOs()));
  });

  it("claims only the measured Linux release-host path", () => {
    const s = releaseHostWebDriverSupport();
    if (hostOs() === "linux") {
      assert.equal(s.supported, true);
      assert.equal(s.driver, "tauri-driver");
      assert.match(s.reason, /not installed-bundle|not.*native-input/i);
    } else {
      assert.equal(s.supported, false);
      assert.equal(s.driver, "none");
    }
  });

  it("probes tauri-driver and records refusal text on macOS", () => {
    const p = probeTauriDriver();
    if (hostOs() === "macos" && p.present) {
      assert.match(p.probe, /not supported|unsupported/i);
    }
  });

  it("snapshot includes measuredAt and nested fields", () => {
    const snap = supportMatrixSnapshot();
    assert.ok(snap.measuredAt);
    assert.ok(snap.releaseHostWebDriver);
    assert.ok(snap.tauriDriver);
  });
});
