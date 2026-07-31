import { describe, expect, it } from "vitest";
import { CD_WIRE_VERSION, CONTRACTS_PACKAGE } from "./index";

describe("@contextdesk/contracts smoke", () => {
  it("exports its package identity", () => {
    expect(CONTRACTS_PACKAGE).toBe("@contextdesk/contracts");
  });

  it("pins the wire contract generation", () => {
    expect(CD_WIRE_VERSION).toBe("cd.v1");
  });
});
