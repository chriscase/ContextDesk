import { describe, expect, it } from "vitest";
import { REACT_PACKAGE } from "./index";

describe("@contextdesk/react smoke", () => {
  it("exports its package identity", () => {
    expect(REACT_PACKAGE).toBe("@contextdesk/react");
  });
});
