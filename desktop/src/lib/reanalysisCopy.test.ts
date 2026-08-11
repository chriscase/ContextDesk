import { describe, expect, it } from "vitest";

import {
  LOCAL_REANALYSIS_COPY,
  REMOTE_REANALYSIS_COPY,
  reanalysisLocalityCopy,
} from "./reanalysisCopy";

describe("reanalysis locality copy", () => {
  it("picks the sentence that matches where the work runs", () => {
    expect(reanalysisLocalityCopy(false)).toBe(LOCAL_REANALYSIS_COPY);
    expect(reanalysisLocalityCopy(true)).toBe(REMOTE_REANALYSIS_COPY);
  });

  it("cannot describe a remote operation with local wording", () => {
    // The two strings share no claim about egress, so a surface that renders
    // one can never be mistaken for the other.
    expect(LOCAL_REANALYSIS_COPY).not.toBe(REMOTE_REANALYSIS_COPY);
    expect(LOCAL_REANALYSIS_COPY).toContain("does not leave this machine");
    expect(REMOTE_REANALYSIS_COPY).not.toContain("does not leave");
    expect(REMOTE_REANALYSIS_COPY).toContain("leaves this machine");
  });

  it("names what a remote run actually sends", () => {
    // Consent needs both facts: what is sent, and that it leaves.
    expect(REMOTE_REANALYSIS_COPY).toContain("log template text");
    expect(REMOTE_REANALYSIS_COPY).toContain("remote embedding provider");
  });

  it("matches the Rust constants byte for byte", () => {
    // These mirror `LOCAL_REANALYSIS_COPY` / `REMOTE_REANALYSIS_COPY` in
    // `cd_core::log_analysis::reanalysis_plan`. Copying the literals here (and
    // asserting them) is what makes a drift between the two surfaces visible
    // in review instead of only at runtime.
    expect(LOCAL_REANALYSIS_COPY).toBe(
      "Re-analysis runs on this machine. Log content does not leave this machine.",
    );
    expect(REMOTE_REANALYSIS_COPY).toBe(
      "Re-analysis sends log template text to a remote embedding provider. " +
        "Log content leaves this machine.",
    );
  });
});
