import { describe, expect, it } from "vitest";
import { logTimeBridgeOptions } from "./runtime-config.js";

const BIN = "/opt/contextdesk/bin/contextdesk";
const ROOT = "/var/lib/contextdesk/log-corpora";

describe("log-time host configuration", () => {
  it("stays unconfigured when no host binary is named", () => {
    expect(logTimeBridgeOptions({ COLLAB_LOG_CORPUS_ROOT: ROOT })).toBeNull();
  });

  it("stays unconfigured when no corpus root is named", () => {
    // Without somewhere durable to keep case corpora there is nothing to
    // review, so the routes must not register at all.
    expect(logTimeBridgeOptions({ COLLAB_BRIDGE_BIN: BIN })).toBeNull();
  });

  it("configures the bridge when both are present", () => {
    const options = logTimeBridgeOptions({
      COLLAB_BRIDGE_BIN: BIN,
      COLLAB_LOG_CORPUS_ROOT: ROOT,
    });
    expect(options).toEqual({ command: BIN, cacheRoot: ROOT, timeoutMs: 120_000 });
  });

  it("shares the triage bridge binary name", () => {
    const options = logTimeBridgeOptions({
      COLLAB_TRIAGE_RUNNER: BIN,
      COLLAB_LOG_CORPUS_ROOT: ROOT,
    });
    expect(options?.command).toBe(BIN);
  });

  it("rejects a timeout outside the supported window instead of clamping", () => {
    for (const value of ["0", "999", "900001", "not-a-number", "12.5"]) {
      expect(() =>
        logTimeBridgeOptions({
          COLLAB_BRIDGE_BIN: BIN,
          COLLAB_LOG_CORPUS_ROOT: ROOT,
          COLLAB_LOG_TIME_TIMEOUT_MS: value,
        }),
      ).toThrow(/between 1000 and 900000/);
    }
  });

  it("runs a configured .mjs shim through this Node runtime on Windows", () => {
    const options = logTimeBridgeOptions(
      { COLLAB_BRIDGE_BIN: "C:\\shims\\bridge.mjs", COLLAB_LOG_CORPUS_ROOT: ROOT },
      "win32",
    );
    expect(options?.command).toBe(process.execPath);
    expect(options?.prefixArgs).toEqual(["C:\\shims\\bridge.mjs"]);
  });

  it("leaves a native binary alone on Windows", () => {
    const options = logTimeBridgeOptions(
      { COLLAB_BRIDGE_BIN: "C:\\bin\\contextdesk.exe", COLLAB_LOG_CORPUS_ROOT: ROOT },
      "win32",
    );
    expect(options?.command).toBe("C:\\bin\\contextdesk.exe");
    expect(options?.prefixArgs).toBeUndefined();
  });

  it("treats whitespace-only values as absent", () => {
    expect(
      logTimeBridgeOptions({ COLLAB_BRIDGE_BIN: "   ", COLLAB_LOG_CORPUS_ROOT: ROOT }),
    ).toBeNull();
    expect(
      logTimeBridgeOptions({ COLLAB_BRIDGE_BIN: BIN, COLLAB_LOG_CORPUS_ROOT: "  " }),
    ).toBeNull();
  });
});
