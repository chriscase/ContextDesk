import { describe, expect, it } from "vitest";
import { APP_ROLES } from "./auth.js";
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  canUse,
  hasCapability,
  isCapability,
  profileCanUseCapabilities,
  resolveCapabilities,
  roleCapabilities,
  usableCapabilities,
} from "./capability.js";

describe("capability model", () => {
  it("declares an entry for every app role and only known capabilities", () => {
    for (const role of APP_ROLES) {
      expect(ROLE_CAPABILITIES[role].length).toBeGreaterThan(0);
      for (const capability of ROLE_CAPABILITIES[role]) {
        expect(isCapability(capability)).toBe(true);
      }
    }
  });

  it("ranks admin as a superset of every other role", () => {
    for (const role of APP_ROLES) {
      for (const capability of ROLE_CAPABILITIES[role]) {
        expect(ROLE_CAPABILITIES.admin).toContain(capability);
      }
    }
    expect(new Set(ROLE_CAPABILITIES.admin)).toEqual(new Set(CAPABILITIES));
  });

  it("viewer never receives write or admin capabilities", () => {
    expect(ROLE_CAPABILITIES.viewer).toEqual(["investigation:read"]);
  });

  it("resolves capabilities from roles alone in stable declaration order", () => {
    expect(roleCapabilities(["viewer"])).toEqual(["investigation:read"]);
    expect(roleCapabilities(["admin", "viewer"])).toEqual([...CAPABILITIES]);
    expect(roleCapabilities([])).toEqual([]);
  });

  it("adds local grants on top of role capabilities without duplication", () => {
    const effective = resolveCapabilities(["viewer"], ["admin:users", "investigation:read"]);
    expect(effective).toEqual(["investigation:read", "admin:users"]);
    expect(hasCapability(effective, "admin:users")).toBe(true);
    expect(hasCapability(effective, "audit:view")).toBe(false);
  });

  it("ignores unknown strings passed as local grants instead of throwing", () => {
    const effective = resolveCapabilities(["viewer"], [
      "investigation:read",
      "not-a-real-capability",
    ] as unknown as Parameters<typeof resolveCapabilities>[1]);
    expect(effective).toEqual(["investigation:read"]);
  });

  it("local grants cannot remove a role capability", () => {
    const effective = resolveCapabilities(["case-lead"], []);
    expect(effective).toContain("decision:accept");
  });

  it("zeroes usable capabilities for suspended, disabled, and historical profiles", () => {
    expect(
      usableCapabilities({ status: "suspended", provenance: "local" }, ["admin"], ["audit:view"]),
    ).toEqual([]);
    expect(
      usableCapabilities({ status: "disabled", provenance: "local" }, ["admin"], []),
    ).toEqual([]);
    expect(
      usableCapabilities(
        { status: "active", provenance: "imported_historical" },
        ["admin"],
        ["investigation:write"],
      ),
    ).toEqual([]);
    expect(profileCanUseCapabilities({ status: "active", provenance: "local" })).toBe(true);
    expect(
      canUse({ status: "active", provenance: "local" }, ["viewer"], ["investigation:write"], "investigation:write"),
    ).toBe(true);
  });
});
