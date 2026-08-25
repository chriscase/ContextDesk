import { describe, expect, it } from "vitest";
import { canUse, effectiveCapabilityRows, usableCapabilities } from "./capabilities.js";

function profile(overrides: { status?: "active" | "suspended" | "disabled"; provenance?: string } = {}) {
  return {
    status: overrides.status ?? "active",
    provenance: (overrides.provenance ?? "local") as "local" | "ldap" | "oidc" | "imported_historical",
  };
}

describe("usableCapabilities / canUse", () => {
  it("resolves the role's default capabilities for an active local profile", () => {
    const caps = usableCapabilities(profile(), ["case-lead"], []);
    expect(caps).toContain("decision:accept");
    expect(canUse(profile(), ["case-lead"], [], "decision:accept")).toBe(true);
  });

  it("adds local grants on top of role capabilities", () => {
    expect(canUse(profile(), ["viewer"], [
      { capability: "admin:users", grantedBy: "local:root", grantedAt: "2026-01-01T00:00:00.000Z" },
    ], "admin:users")).toBe(true);
  });

  it("zeroes every capability for a suspended profile, even an admin role plus explicit grants", () => {
    const suspended = profile({ status: "suspended" });
    const caps = usableCapabilities(suspended, ["admin"], [
      { capability: "admin:users", grantedBy: "local:root", grantedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(caps).toEqual([]);
    expect(canUse(suspended, ["admin"], [], "admin:users")).toBe(false);
  });

  it("zeroes every capability for a disabled profile", () => {
    expect(usableCapabilities(profile({ status: "disabled" }), ["admin"], [])).toEqual([]);
  });

  it("zeroes every capability for an imported_historical profile regardless of role or grant", () => {
    const historical = profile({ provenance: "imported_historical" });
    const caps = usableCapabilities(historical, ["admin"], [
      { capability: "investigation:read", grantedBy: "local:root", grantedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(caps).toEqual([]);
  });
});

describe("effectiveCapabilityRows", () => {
  it("keeps showing role/grant-derived capabilities for a suspended profile (inspection, not enforcement)", () => {
    // This intentionally does NOT take profile status as input: it answers
    // "what would this role/grant combination confer", which an admin needs
    // to see even for a suspended account to understand what reactivating
    // it would restore. usableCapabilities is the enforcement gate that
    // actually zeroes it out while suspended.
    const rows = effectiveCapabilityRows(["case-lead"], []);
    const decision = rows.find((row) => row.capability === "decision:accept");
    expect(decision?.viaRoles).toEqual(["case-lead"]);
  });
});
