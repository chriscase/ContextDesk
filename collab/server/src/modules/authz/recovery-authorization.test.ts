import { ROLE_CAPABILITIES } from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { MapAuthAdapter } from "../auth/index.js";
import { MemoryLocalGrantStore, MemoryUserProfileStore } from "../people/index.js";
import {
  authorizeRecoveryRequester,
  bindRecoveryAuthorization,
} from "./recovery-authorization.js";
import { MutableGroupRoleMap, parseGroupRoleMap } from "./roles.js";

const LEAD_ID = "local:lead";
const VIEWER_ID = "local:viewer";
const HISTORICAL_ID = "imported:north-installation:actor-42";

function adapter() {
  return new MapAuthAdapter(
    new Map([
      [
        "lead",
        {
          password: "lead-secret",
          identity: { id: LEAD_ID, username: "lead", displayName: "Lead" },
          groups: ["local:case-leads"],
        },
      ],
      [
        "viewer",
        {
          password: "viewer-secret",
          identity: { id: VIEWER_ID, username: "viewer", displayName: "Viewer" },
          groups: ["local:viewers"],
        },
      ],
      [
        "historical",
        {
          password: "historical-secret",
          identity: { id: HISTORICAL_ID, username: "historical", displayName: "Historical" },
          groups: ["local:case-leads"],
        },
      ],
    ]),
  );
}

function roles() {
  return new MutableGroupRoleMap(
    parseGroupRoleMap("local:case-leads=case-lead;local:viewers=viewer;local:admins=admin"),
  );
}

async function seedActive(
  profiles: MemoryUserProfileStore,
  id: string,
  username: string,
  provenance: "local" | "imported_historical" = "local",
) {
  const seeded = await profiles.touchOnLogin({
    id,
    username,
    displayName: username,
    provenance,
    directorySubject: provenance === "local" ? null : id,
  });
  expect(seeded.outcome).toBe("ok");
}

describe("authorizeRecoveryRequester", () => {
  it("re-resolves an active requester from current roles and grants without a session", async () => {
    const profiles = new MemoryUserProfileStore();
    const grants = new MemoryLocalGrantStore();
    await seedActive(profiles, LEAD_ID, "lead");
    const result = await authorizeRecoveryRequester(
      { id: LEAD_ID, username: "lead" },
      {
        lookupGroups: (identity) => adapter().lookupGroups(identity),
        roles: roles(),
        profiles,
        grants,
      },
    );
    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.isAdmin).toBe(false);
    expect(result.has("run:strategies")).toBe(true);
    expect(result.has("evidence:private:read")).toBe(true);
    expect(result.capabilities).toEqual([...ROLE_CAPABILITIES["case-lead"]]);
  });

  it("observes a grant added after the original queue time and does not cache roles", async () => {
    const profiles = new MemoryUserProfileStore();
    const grants = new MemoryLocalGrantStore();
    const roleMap = roles();
    await seedActive(profiles, VIEWER_ID, "viewer");
    const bound = bindRecoveryAuthorization({
      lookupGroups: (identity) => adapter().lookupGroups(identity),
      roles: roleMap,
      profiles,
      grants,
    });
    const before = await bound({ id: VIEWER_ID, username: "viewer" });
    expect(before.kind).toBe("authorized");
    if (before.kind !== "authorized") return;
    expect(before.has("run:strategies")).toBe(false);

    await grants.grant(VIEWER_ID, "run:strategies", "local:admin");
    const afterGrant = await bound({ id: VIEWER_ID, username: "viewer" });
    expect(afterGrant.kind).toBe("authorized");
    if (afterGrant.kind !== "authorized") return;
    expect(afterGrant.has("run:strategies")).toBe(true);

    roleMap.delete("local:viewers");
    const afterRoleLoss = await bound({ id: VIEWER_ID, username: "viewer" });
    expect(afterRoleLoss.kind).toBe("authorized");
    if (afterRoleLoss.kind !== "authorized") return;
    expect(afterRoleLoss.roles).toEqual([]);
    expect(afterRoleLoss.has("investigation:read")).toBe(false);
    expect(afterRoleLoss.has("run:strategies")).toBe(true);
  });

  it("fails closed for suspended, disabled, historical, and missing profiles", async () => {
    const profiles = new MemoryUserProfileStore();
    const grants = new MemoryLocalGrantStore();
    const deps = {
      lookupGroups: (identity: { id: string; username: string; displayName: string }) =>
        adapter().lookupGroups(identity),
      roles: roles(),
      profiles,
      grants,
    };
    await seedActive(profiles, LEAD_ID, "lead");
    const lead = await profiles.getById(LEAD_ID);
    if (!lead) throw new Error("setup failed");
    await profiles.setStatus(LEAD_ID, "suspended", lead.revision);
    expect(await authorizeRecoveryRequester({ id: LEAD_ID, username: "lead" }, deps)).toEqual({
      kind: "inactive",
      reason: "suspended",
    });

    await profiles.setStatus(LEAD_ID, "disabled", lead.revision + 1);
    expect(await authorizeRecoveryRequester({ id: LEAD_ID, username: "lead" }, deps)).toEqual({
      kind: "inactive",
      reason: "disabled",
    });

    await seedActive(profiles, HISTORICAL_ID, "historical", "imported_historical");
    expect(
      await authorizeRecoveryRequester({ id: HISTORICAL_ID, username: "historical" }, deps),
    ).toEqual({ kind: "inactive", reason: "imported_historical" });

    expect(
      await authorizeRecoveryRequester({ id: "local:missing", username: "missing" }, deps),
    ).toEqual({ kind: "inactive", reason: "missing_profile" });
  });

  it("fails closed when the profile or grant store throws", async () => {
    const profiles = new MemoryUserProfileStore();
    const grants = new MemoryLocalGrantStore();
    await seedActive(profiles, LEAD_ID, "lead");
    const throwingProfiles = {
      getById: async () => {
        throw new Error("profile store down");
      },
    };
    expect(
      await authorizeRecoveryRequester(
        { id: LEAD_ID, username: "lead" },
        {
          lookupGroups: async () => ["local:case-leads"],
          roles: roles(),
          profiles: throwingProfiles,
          grants,
        },
      ),
    ).toEqual({ kind: "unavailable" });

    const throwingGrants = {
      list: async () => {
        throw new Error("grant store down");
      },
    };
    expect(
      await authorizeRecoveryRequester(
        { id: LEAD_ID, username: "lead" },
        {
          lookupGroups: async () => ["local:case-leads"],
          roles: roles(),
          profiles,
          grants: throwingGrants,
        },
      ),
    ).toEqual({ kind: "unavailable" });
  });
});
