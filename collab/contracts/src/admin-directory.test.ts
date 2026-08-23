import { describe, expect, it } from "vitest";
import {
  ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
  ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
  ADMIN_DIRECTORY_MAX_RESULTS,
  ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
  parseAdminDirectoryGroupSearchResponse,
  parseAdminDirectoryIdentitySearchResponse,
  parseAdminDirectorySearchRequest,
} from "./admin-directory.js";

describe("admin directory contracts", () => {
  it("normalizes a bounded search term and denies unknown request fields", () => {
    expect(
      parseAdminDirectorySearchRequest({
        schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
        term: "  Alice   Smith  ",
      }),
    ).toEqual({
      schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
      term: "Alice Smith",
    });
    expect(() =>
      parseAdminDirectorySearchRequest({
        schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
        term: "alice",
        includeMemberships: true,
      }),
    ).toThrow(/unknown key/);
  });

  it("rejects too-short and too-long normalized terms", () => {
    expect(() =>
      parseAdminDirectorySearchRequest({
        schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
        term: " a ",
      }),
    ).toThrow(/at least 2/);
    expect(() =>
      parseAdminDirectorySearchRequest({
        schemaId: ADMIN_DIRECTORY_SEARCH_REQUEST_SCHEMA_ID,
        term: "a".repeat(65),
      }),
    ).toThrow(/at most 64/);
  });

  it("accepts only the identity and group privacy projections", () => {
    expect(
      parseAdminDirectoryIdentitySearchResponse({
        schemaId: ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
        results: [
          {
            id: "uid=alice,ou=people,dc=example,dc=test",
            username: "alice",
            displayName: "Alice",
            source: "ldap",
          },
        ],
      }).results,
    ).toHaveLength(1);
    expect(
      parseAdminDirectoryGroupSearchResponse({
        schemaId: ADMIN_DIRECTORY_GROUPS_SCHEMA_ID,
        results: [
          {
            dn: "cn=admins,ou=groups,dc=example,dc=test",
            name: "admins",
            source: "ldap",
          },
        ],
      }).results,
    ).toHaveLength(1);
    expect(() =>
      parseAdminDirectoryIdentitySearchResponse({
        schemaId: ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
        results: [
          {
            id: "uid=alice",
            username: "alice",
            displayName: "Alice",
            source: "ldap",
            email: "alice@example.test",
          },
        ],
      }),
    ).toThrow(/unknown key/);
  });

  it("rejects oversized result sets", () => {
    expect(() =>
      parseAdminDirectoryIdentitySearchResponse({
        schemaId: ADMIN_DIRECTORY_IDENTITIES_SCHEMA_ID,
        results: Array.from({ length: ADMIN_DIRECTORY_MAX_RESULTS + 1 }, (_, index) => ({
          id: `local:user-${index}`,
          username: `user-${index}`,
          displayName: `User ${index}`,
          source: "local",
        })),
      }),
    ).toThrow(/at most 20/);
  });
});
