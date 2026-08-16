import { describe, expect, it } from "vitest";
import {
  operatorImportCommandFailure,
  sealImportOperatorMessage,
} from "./importOutcome";

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

describe("operatorImportCommandFailure", () => {
  const rejected = { class: "rejected" as const, published: false };

  it("unwraps the Tauri object shape and keeps a classified rejection", () => {
    const shown = operatorImportCommandFailure({
      message: "zip open: missing end record",
      outcome: rejected,
    });
    expect(shown.message).toBe(
      "Import rejected: zip open: missing end record",
    );
    expect(shown.message).not.toContain("[object Object]");
    expect(shown.outcome?.class).toBe("rejected");
    expect(shown.outcome?.published).toBe(false);
  });

  it("seals a leftover [member= frame on the object message", () => {
    const shown = operatorImportCommandFailure({
      message: "zip open: missing end record [member=bundles/inner.zip]",
      outcome: rejected,
    });
    expect(shown.message).not.toContain("[member=");
    expect(shown.message).toContain("zip open: missing end record");
    expect(shown.outcome?.class).toBe("rejected");
  });

  it("does not treat String(error) as the operator text", () => {
    const raw = {
      message: "zip open: missing end record",
      outcome: rejected,
    };
    expect(String(raw)).toBe("[object Object]");
    expect(operatorImportCommandFailure(raw).message).not.toBe(
      "[object Object]",
    );
  });
});
