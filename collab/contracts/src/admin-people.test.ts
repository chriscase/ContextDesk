import { describe, expect, it } from "vitest";
import {
  ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_LIST_SCHEMA_ID,
  ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID,
  ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID,
  buildEffectiveCapabilityRows,
  computeDirectoryMappingPreview,
  parseAdminDirectoryMappingPreviewRequest,
  parseAdminPeopleGrantRequest,
  parseAdminPeopleListRequest,
  parseAdminPeopleListResponse,
  parseAdminPeopleRevokeRequest,
  parseAdminPeopleStatusRequest,
} from "./admin-people.js";
import { DEFAULT_DIRECTORY_ATTRIBUTE_MAP } from "./directory-mapping.js";
import { ContractViolation } from "./parse.js";
import { USER_PROFILE_SCHEMA_ID, type UserProfileV1 } from "./user-profile.js";

function profile(username: string, id = `local:${username}`): UserProfileV1 {
  return {
    schemaId: USER_PROFILE_SCHEMA_ID,
    id,
    username,
    displayName: username,
    roleTitle: null,
    team: null,
    contactEmail: null,
    contactOther: null,
    avatar: null,
    status: "active",
    provenance: "local",
    directorySubject: null,
    directorySyncStatus: "not_synced",
    directorySyncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
    customAttributes: [],
    revision: 1,
  };
}

describe("admin people list request", () => {
  it("accepts an empty term (list all) and bounds the page size", () => {
    const request = parseAdminPeopleListRequest({
      schemaId: ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
      term: "",
      status: null,
      provenance: null,
      cursor: null,
      limit: 25,
    });
    expect(request.term).toBe("");
    expect(request.limit).toBe(25);
  });

  it("rejects a limit outside [1, ADMIN_PEOPLE_MAX_PAGE_SIZE]", () => {
    expect(() =>
      parseAdminPeopleListRequest({
        schemaId: ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
        term: "",
        status: null,
        provenance: null,
        cursor: null,
        limit: 0,
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseAdminPeopleListRequest({
        schemaId: ADMIN_PEOPLE_LIST_REQUEST_SCHEMA_ID,
        term: "",
        status: null,
        provenance: null,
        cursor: null,
        limit: 5000,
      }),
    ).toThrow(ContractViolation);
  });
});

describe("admin people list response", () => {
  it("accepts rows sorted by username", () => {
    const response = parseAdminPeopleListResponse({
      schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID,
      people: [profile("alice"), profile("bob")],
      nextCursor: null,
    });
    expect(response.people).toHaveLength(2);
  });

  it("rejects rows that are not sorted by username", () => {
    expect(() =>
      parseAdminPeopleListResponse({
        schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID,
        people: [profile("zeta"), profile("alice")],
        nextCursor: null,
      }),
    ).toThrow(/not sorted/);
  });

  it("rejects more rows than the max page size", () => {
    const people = Array.from({ length: 51 }, (_, i) => profile(`user${String(i).padStart(3, "0")}`));
    expect(() =>
      parseAdminPeopleListResponse({
        schemaId: ADMIN_PEOPLE_LIST_SCHEMA_ID,
        people,
        nextCursor: null,
      }),
    ).toThrow(/at most/);
  });
});

describe("buildEffectiveCapabilityRows", () => {
  it("attributes a capability to the granting role", () => {
    const rows = buildEffectiveCapabilityRows(["case-lead"], []);
    const decision = rows.find((row) => row.capability === "decision:accept");
    expect(decision?.viaRoles).toEqual(["case-lead"]);
    expect(decision?.viaLocalGrant).toBe(false);
  });

  it("shows a local grant even when no role would otherwise provide it", () => {
    const rows = buildEffectiveCapabilityRows(["viewer"], [
      { capability: "admin:users", grantedBy: "local:admin", grantedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const adminUsers = rows.find((row) => row.capability === "admin:users");
    expect(adminUsers?.viaRoles).toEqual([]);
    expect(adminUsers?.viaLocalGrant).toBe(true);
    expect(adminUsers?.grantedBy).toBe("local:admin");
  });

  it("includes every capability, held or not, so an admin UI can render a full toggle list", () => {
    const rows = buildEffectiveCapabilityRows(["viewer"], []);
    expect(rows).toHaveLength(10);
  });
});

describe("status / grant / revoke request idempotency", () => {
  it("requires a well-formed idempotency key on status updates", () => {
    expect(() =>
      parseAdminPeopleStatusRequest({
        schemaId: ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID,
        status: "suspended",
        expectedRevision: 3,
        idempotencyKey: "short",
      }),
    ).toThrow(ContractViolation);
    const request = parseAdminPeopleStatusRequest({
      schemaId: ADMIN_PEOPLE_STATUS_REQUEST_SCHEMA_ID,
      status: "suspended",
      expectedRevision: 3,
      idempotencyKey: "admin-suspend-alice-001",
    });
    expect(request.status).toBe("suspended");
  });

  it("rejects an unknown capability on grant/revoke", () => {
    expect(() =>
      parseAdminPeopleGrantRequest({
        schemaId: ADMIN_PEOPLE_GRANT_REQUEST_SCHEMA_ID,
        capability: "root:everything",
        idempotencyKey: "grant-key-0001",
      }),
    ).toThrow(ContractViolation);
    expect(
      parseAdminPeopleRevokeRequest({
        schemaId: ADMIN_PEOPLE_REVOKE_REQUEST_SCHEMA_ID,
        capability: "audit:view",
        idempotencyKey: "revoke-key-0001",
      }).capability,
    ).toBe("audit:view");
  });
});

describe("directory mapping preview", () => {
  it("parses a request and computes the same mapping the pure function would", () => {
    const request = parseAdminDirectoryMappingPreviewRequest({
      schemaId: ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
      map: DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
      sampleClaims: { cn: "Sample Analyst", mail: "sample@example.test" },
    });
    const preview = computeDirectoryMappingPreview(request);
    expect(preview.fields.displayName).toBe("Sample Analyst");
    expect(preview.fields.contactEmail).toBe("sample@example.test");
    expect(preview.skipped.sort()).toEqual(["roleTitle", "team"]);
  });

  it("bounds the number of sample claims", () => {
    const sampleClaims = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`attr${i}`, "value"]),
    );
    expect(() =>
      parseAdminDirectoryMappingPreviewRequest({
        schemaId: ADMIN_DIRECTORY_MAPPING_PREVIEW_REQUEST_SCHEMA_ID,
        map: DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
        sampleClaims,
      }),
    ).toThrow(/at most/);
  });
});
