import { describe, expect, it } from "vitest";
import { UI_PACKAGE } from "./index";

describe("@contextdesk/ui smoke", () => {
  it("exports its package identity", () => {
    expect(UI_PACKAGE).toBe("@contextdesk/ui");
  });
});
