import { describe, expect, it } from "vitest";
import { activityOutcomeFromImportClass } from "./types";

describe("activityOutcomeFromImportClass", () => {
  it("records only an explicit complete class as completed", () => {
    expect(activityOutcomeFromImportClass("complete")).toBe("completed");
    expect(activityOutcomeFromImportClass("partial")).toBe("partial");
    expect(activityOutcomeFromImportClass("rejected")).toBe("failed");
    expect(activityOutcomeFromImportClass(undefined)).toBe("partial");
    expect(activityOutcomeFromImportClass(null)).toBe("partial");
  });
});
