import { describe, expect, it } from "vitest";
import { triageBridgeOptions } from "./runtime-config.js";

describe("triage bridge runtime configuration", () => {
  it("uses the operator-facing bridge variables and preserves optional settings", () => {
    expect(triageBridgeOptions({
      COLLAB_BRIDGE_BIN: "/opt/contextdesk",
      COLLAB_BRIDGE_LIBRARY: "cd_workflow",
      COLLAB_BRIDGE_DATA_DIR: "/var/lib/contextdesk",
      COLLAB_BRIDGE_TIMEOUT_MS: "45000",
    })).toEqual({
      command: "/opt/contextdesk",
      library: "cd_workflow",
      dataDir: "/var/lib/contextdesk",
      timeoutMs: 45000,
    });
  });

  it("keeps legacy deployments working when the new name is absent", () => {
    expect(triageBridgeOptions({
      COLLAB_TRIAGE_RUNNER: "/old/contextdesk",
      COLLAB_TRIAGE_LIBRARY: "legacy",
      COLLAB_TRIAGE_RUNNER_DATA_DIR: "/old/data",
      COLLAB_TRIAGE_RUNNER_TIMEOUT_MS: "9000",
    })).toEqual({
      command: "/old/contextdesk",
      library: "legacy",
      dataDir: "/old/data",
      timeoutMs: 9000,
    });
  });

  it("prefers the operator-facing value when both names are present", () => {
    expect(triageBridgeOptions({
      COLLAB_BRIDGE_BIN: "/new/contextdesk",
      COLLAB_TRIAGE_RUNNER: "/old/contextdesk",
    })?.command).toBe("/new/contextdesk");
  });

  it("leaves the gateway disabled when no bridge is configured", () => {
    expect(triageBridgeOptions({})).toBeNull();
  });

  it.each(["0", "999", "900001", "not-a-number", "45000.5"]) (
    "rejects an unsafe bridge timeout (%s)",
    (timeout) => {
      expect(() => triageBridgeOptions({ COLLAB_BRIDGE_BIN: "/opt/contextdesk", COLLAB_BRIDGE_TIMEOUT_MS: timeout }))
        .toThrow("COLLAB_BRIDGE_TIMEOUT_MS must be an integer between 1000 and 900000");
    },
  );
});
