import { describe, expect, it } from "vitest";
import { sealImportOperatorMessage } from "./importOutcome";

describe("sealImportOperatorMessage", () => {
  it("is fail-closed for empty, nested, and stacked frames", () => {
    for (const raw of [
      "zip open: missing end record [member=]",
      "zip open: missing end record [member=foo [member=sk-abcdefghijklmnopqrst]]",
      "zip open: missing end record [member=x] [member=secret]",
      "zip open: missing end record[member=no-space]",
    ]) {
      const shown = sealImportOperatorMessage(raw);
      expect(shown, raw).not.toContain("[member=");
      expect(shown, raw).toContain("zip open: missing end record");
    }
  });

  it("leaves an unannotated message unchanged", () => {
    expect(sealImportOperatorMessage("policy denied: plan is stale")).toBe(
      "policy denied: plan is stale",
    );
  });
});
