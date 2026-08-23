import { describe, expect, it } from "vitest";
import { activityOutcomeFromImportClass } from "./types";

describe("activityOutcomeFromImportClass", () => {
  it("records only an explicit complete class as completed", () => {
    expect(activityOutcomeFromImportClass("complete")).toBe("completed");
    expect(activityOutcomeFromImportClass("partial")).toBe("partial");
    expect(activityOutcomeFromImportClass("rejected")).toBe("failed");
  });

  it("records a missing class as unknown, never as an invented verdict", () => {
    expect(activityOutcomeFromImportClass(undefined)).toBe("unknown");
    expect(activityOutcomeFromImportClass(null)).toBe("unknown");
    expect(activityOutcomeFromImportClass("unknown")).toBe("unknown");
  });
});
