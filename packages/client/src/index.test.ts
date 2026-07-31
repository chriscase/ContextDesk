import { describe, expect, it } from "vitest";
import { CLIENT_PACKAGE } from "./index";

describe("@contextdesk/client smoke", () => {
  it("exports its package identity", () => {
    expect(CLIENT_PACKAGE).toBe("@contextdesk/client");
  });
});
