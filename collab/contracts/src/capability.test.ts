import { describe, expect, it } from "vitest";
import { APP_ROLES } from "./auth.js";
import {
  CAPABILITY_MODEL_VERSION,
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
  it("publishes capability model v3 in stable declaration order", () => {
    expect(CAPABILITY_MODEL_VERSION).toBe(3);
    expect(CAPABILITIES).toEqual([
      "investigation:read",
      "investigation:write",
      "investigation:coordinate",
      "evidence:private:read",
      "run:strategies",
      "decision:accept",
      "export:create",
      "portable:restore",
      "catalog:write",
      "admin:users",
      "admin:system_config",
      "audit:view",
    ]);
    expect(Object.keys(ROLE_CAPABILITIES).sort()).toEqual([...APP_ROLES].sort());
  });

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

  it("defaults coordination authority to case leads and admins", () => {
    expect(ROLE_CAPABILITIES.viewer).toEqual(["investigation:read"]);
    expect(ROLE_CAPABILITIES.contributor).toEqual([
      "investigation:read",
      "investigation:write",
    ]);
    expect(ROLE_CAPABILITIES["case-lead"]).toEqual([
      "investigation:read",
      "investigation:write",
      "investigation:coordinate",
      "evidence:private:read",
      "run:strategies",
      "decision:accept",
      "export:create",
      "portable:restore",
      "catalog:write",
    ]);
    expect(ROLE_CAPABILITIES.admin).toEqual([...CAPABILITIES]);
  });

  it("grants catalog:write to current catalog writers without changing viewer or contributor", () => {
    expect(ROLE_CAPABILITIES.viewer).toEqual(["investigation:read"]);
    expect(ROLE_CAPABILITIES.contributor).toEqual([
      "investigation:read",
      "investigation:write",
    ]);
    expect(ROLE_CAPABILITIES.viewer).not.toContain("catalog:write");
    expect(ROLE_CAPABILITIES.contributor).not.toContain("catalog:write");
    expect(ROLE_CAPABILITIES["case-lead"]).toContain("catalog:write");
    expect(ROLE_CAPABILITIES.admin).toContain("catalog:write");
    expect(roleCapabilities(["case-lead"])).toEqual(ROLE_CAPABILITIES["case-lead"]);
    expect(roleCapabilities(["admin"])).toEqual([...CAPABILITIES]);
    expect(isCapability("catalog:write")).toBe(true);
  });

  it("does not treat run:strategies, admin:users, or investigation read/write as catalog mutation authority", () => {
    const viewerWithRun = resolveCapabilities(["viewer"], ["run:strategies"]);
    expect(viewerWithRun).toEqual(["investigation:read", "run:strategies"]);
    expect(hasCapability(viewerWithRun, "catalog:write")).toBe(false);

    const viewerWithAdminUsers = resolveCapabilities(["viewer"], ["admin:users"]);
    expect(viewerWithAdminUsers).toEqual(["investigation:read", "admin:users"]);
    expect(hasCapability(viewerWithAdminUsers, "catalog:write")).toBe(false);

    const contributor = resolveCapabilities(["contributor"]);
    expect(contributor).toEqual(["investigation:read", "investigation:write"]);
    expect(hasCapability(contributor, "catalog:write")).toBe(false);
    expect(hasCapability(contributor, "investigation:read")).toBe(true);
    expect(hasCapability(contributor, "investigation:write")).toBe(true);
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

  it("permits an additive coordination grant without granting a role", () => {
    expect(resolveCapabilities(["viewer"], ["investigation:coordinate"])).toEqual([
      "investigation:read",
      "investigation:coordinate",
    ]);
  });

  it("permits an additive catalog:write grant without granting a role", () => {
    expect(resolveCapabilities(["viewer"], ["catalog:write"])).toEqual([
      "investigation:read",
      "catalog:write",
    ]);
    expect(resolveCapabilities(["contributor"], ["catalog:write"])).toEqual([
      "investigation:read",
      "investigation:write",
      "catalog:write",
    ]);
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
    expect(
      canUse({ status: "active", provenance: "local" }, ["case-lead"], [], "catalog:write"),
    ).toBe(true);
    expect(
      canUse({ status: "active", provenance: "local" }, ["admin"], [], "catalog:write"),
    ).toBe(true);
    expect(
      canUse({ status: "active", provenance: "local" }, ["viewer"], ["catalog:write"], "catalog:write"),
    ).toBe(true);
    expect(
      canUse({ status: "suspended", provenance: "local" }, ["admin"], ["catalog:write"], "catalog:write"),
    ).toBe(false);
    expect(
      canUse({ status: "disabled", provenance: "local" }, ["case-lead"], [], "catalog:write"),
    ).toBe(false);
    expect(
      canUse(
        { status: "active", provenance: "imported_historical" },
        ["admin"],
        ["catalog:write"],
        "catalog:write",
      ),
    ).toBe(false);
  });
});
