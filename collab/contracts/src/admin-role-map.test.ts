import { describe, expect, it } from "vitest";
import {
  ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
  ADMIN_ROLE_MAPPING_MAX_RESULTS,
  parseAdminRoleMappingList,
  parseAdminRoleMappingRevokeRequest,
  parseAdminRoleMappingUpdateRequest,
} from "./admin-role-map.js";

describe("admin role mapping contracts", () => {
  it("accepts a sorted, bounded mapping list", () => {
    expect(
      parseAdminRoleMappingList({
        schemaId: ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
        mappings: [
          { group: "local:admins", role: "admin" },
          { group: "local:operators", role: "contributor" },
        ],
        limit: ADMIN_ROLE_MAPPING_MAX_RESULTS,
        truncated: false,
      }).mappings,
    ).toHaveLength(2);
  });

  it("rejects duplicate, unsorted, oversized, and non-normalized mappings", () => {
    const response = (mappings: unknown[], limit = ADMIN_ROLE_MAPPING_MAX_RESULTS) => ({
      schemaId: ADMIN_ROLE_MAPPING_LIST_SCHEMA_ID,
      mappings,
      limit,
      truncated: false,
    });
    expect(() =>
      parseAdminRoleMappingList(response([
        { group: "local:viewers", role: "viewer" },
        { group: "LOCAL:VIEWERS", role: "admin" },
      ])),
    ).toThrow(/duplicate/);
    expect(() =>
      parseAdminRoleMappingList(response([
        { group: "local:z", role: "viewer" },
        { group: "local:a", role: "viewer" },
      ])),
    ).toThrow(/not sorted/);
    expect(() =>
      parseAdminRoleMappingList(response([{ group: " local:a ", role: "viewer" }])),
    ).toThrow(/not normalized/);
    expect(() => parseAdminRoleMappingList(response([], 20))).toThrow(/expected 500/);
  });

  it("normalizes mutation groups and fails closed on drift or control characters", () => {
    expect(
      parseAdminRoleMappingUpdateRequest({
        group: "  local:operators  ",
        role: "case-lead",
      }),
    ).toEqual({ group: "local:operators", role: "case-lead" });
    expect(parseAdminRoleMappingRevokeRequest({ group: " local:operators " })).toEqual({
      group: "local:operators",
    });
    expect(() =>
      parseAdminRoleMappingUpdateRequest({
        group: "local:operators",
        role: "admin",
        importedAuthority: true,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseAdminRoleMappingRevokeRequest({ group: "local:operators\u0000admin" }),
    ).toThrow(/control characters/);
  });
});
