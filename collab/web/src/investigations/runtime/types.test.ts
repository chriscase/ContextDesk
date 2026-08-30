import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_EVIDENCE_UPLOAD_BYTES,
  type CommandOutcome,
} from "./types.js";

describe("runtime command types", () => {
  it("uses the decimal one-megabyte evidence limit", () => {
    expect(MAX_EVIDENCE_UPLOAD_BYTES).toBe(1_000_000);
  });

  it("keeps success, bounded failure, and ignored commands distinct", () => {
    const succeeded: CommandOutcome<string> = {
      status: "succeeded",
      value: "case-a",
    };
    const failed: CommandOutcome<string> = {
      status: "failed",
      error: { kind: "input", field: "title", reason: "required" },
    };
    const ignored: CommandOutcome<string> = {
      status: "ignored",
      reason: "stale",
    };

    expect([succeeded.status, failed.status, ignored.status]).toEqual([
      "succeeded",
      "failed",
      "ignored",
    ]);
    expectTypeOf(succeeded).toMatchTypeOf<CommandOutcome<string>>();
  });
});
