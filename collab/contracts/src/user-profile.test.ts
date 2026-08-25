import { describe, expect, it } from "vitest";
import {
  PROFILE_CUSTOM_ATTR_MAX_COUNT,
  USER_PROFILE_SCHEMA_ID,
  USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
  assertProfileUpdateAllowed,
  hasDangerousUnicode,
  isProfileFieldSelfEditable,
  normalizeCustomAttributes,
  normalizeDisplayName,
  parseUserProfile,
  parseUserProfileUpdateRequest,
  redactProfileForSelfView,
  REDACTED_DIRECTORY_SUBJECT,
  REDACTED_SELF_PROFILE_ID,
  type UserProfileV1,
} from "./user-profile.js";
import { ContractViolation } from "./parse.js";

function baseProfile(overrides: Partial<UserProfileV1> = {}): UserProfileV1 {
  return {
    schemaId: USER_PROFILE_SCHEMA_ID,
    id: "local:alice",
    username: "alice",
    displayName: "Alice Analyst",
    roleTitle: "Senior analyst",
    team: "Blue team",
    contactEmail: "alice@example.test",
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
    ...overrides,
  };
}

describe("user profile contract", () => {
  it("round-trips a well-formed local profile", () => {
    const profile = baseProfile();
    expect(parseUserProfile(profile)).toEqual(profile);
  });

  it("rejects unknown keys (contract drift)", () => {
    expect(() => parseUserProfile({ ...baseProfile(), isAdmin: true })).toThrow(/unknown key/);
  });

  it("requires a directory subject whenever provenance is not local", () => {
    expect(() =>
      parseUserProfile(
        baseProfile({ provenance: "ldap", directorySubject: null }),
      ),
    ).toThrow(/directory subject/);
    expect(
      parseUserProfile(
        baseProfile({
          provenance: "ldap",
          directorySubject: "uid=alice,ou=people,dc=example,dc=test",
        }),
      ).provenance,
    ).toBe("ldap");
  });

  it("rejects a local profile claiming a synced directory status", () => {
    expect(() =>
      parseUserProfile(baseProfile({ directorySyncStatus: "synced" })),
    ).toThrow(/not_synced/);
  });

  it("rejects a non-normalized display name", () => {
    expect(() =>
      parseUserProfile(baseProfile({ displayName: "  Alice Analyst  " })),
    ).toThrow(/not normalized/);
  });

  describe("dangerous unicode", () => {
    it("flags C0 controls, DEL, zero-width, bidi-override, and BOM characters", () => {
      const zeroWidthSpace = String.fromCodePoint(0x200b);
      const rtlOverride = String.fromCodePoint(0x202e);
      const bom = String.fromCodePoint(0xfeff);
      const del = String.fromCodePoint(0x7f);
      expect(hasDangerousUnicode(`alice${zeroWidthSpace}bob`)).toBe(true);
      expect(hasDangerousUnicode(`alice${rtlOverride}bob`)).toBe(true);
      expect(hasDangerousUnicode(`${bom}alice`)).toBe(true);
      expect(hasDangerousUnicode(`alice${del}`)).toBe(true);
      expect(hasDangerousUnicode("alice")).toBe(false);
    });

    it("rejects a display name carrying an invisible character", () => {
      const zeroWidthSpace = String.fromCodePoint(0x200b);
      expect(() => normalizeDisplayName(`Alice${zeroWidthSpace}Analyst`)).toThrow(
        ContractViolation,
      );
    });
  });

  describe("custom attributes", () => {
    it("sorts by key and rejects duplicates, bad keys, and oversized lists", () => {
      expect(
        normalizeCustomAttributes("$.customAttributes", [
          { key: "zeta", value: "z" },
          { key: "alpha", value: "a" },
        ]),
      ).toEqual([
        { key: "alpha", value: "a" },
        { key: "zeta", value: "z" },
      ]);
      expect(() =>
        normalizeCustomAttributes("$.customAttributes", [
          { key: "dup", value: "1" },
          { key: "dup", value: "2" },
        ]),
      ).toThrow(/duplicate/);
      expect(() =>
        normalizeCustomAttributes("$.customAttributes", [{ key: "has space", value: "x" }]),
      ).toThrow(ContractViolation);
      expect(() =>
        normalizeCustomAttributes(
          "$.customAttributes",
          Array.from({ length: PROFILE_CUSTOM_ATTR_MAX_COUNT + 1 }, (_, i) => ({
            key: `k${i}`,
            value: "v",
          })),
        ),
      ).toThrow(/at most/);
    });
  });

  describe("directory ownership", () => {
    it("marks synced fields read-only under ldap/oidc but editable under local", () => {
      expect(isProfileFieldSelfEditable("displayName", "local")).toBe(true);
      expect(isProfileFieldSelfEditable("displayName", "ldap")).toBe(false);
      expect(isProfileFieldSelfEditable("displayName", "oidc")).toBe(false);
      expect(isProfileFieldSelfEditable("contactOther", "ldap")).toBe(true);
      expect(isProfileFieldSelfEditable("avatar", "imported_historical")).toBe(false);
    });

    it("assertProfileUpdateAllowed throws naming the first disallowed field", () => {
      const request = parseUserProfileUpdateRequest({
        schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
        expectedRevision: 1,
        displayName: "New Name",
      });
      expect(() =>
        assertProfileUpdateAllowed({ provenance: "ldap" }, request),
      ).toThrow(/directory-owned/);
      expect(() =>
        assertProfileUpdateAllowed({ provenance: "local" }, request),
      ).not.toThrow();
    });

    it("never allows editing a directory-owned field for an imported_historical profile", () => {
      const request = parseUserProfileUpdateRequest({
        schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
        expectedRevision: 1,
        team: "New Team",
      });
      expect(() =>
        assertProfileUpdateAllowed({ provenance: "imported_historical" }, request),
      ).toThrow(/directory-owned/);
    });
  });

  describe("update request parsing", () => {
    it("accepts a minimal request touching only expectedRevision", () => {
      const request = parseUserProfileUpdateRequest({
        schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
        expectedRevision: 4,
      });
      expect(request).toEqual({
        schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
        expectedRevision: 4,
      });
    });

    it("validates contact email shape", () => {
      expect(() =>
        parseUserProfileUpdateRequest({
          schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
          expectedRevision: 1,
          contactEmail: "not-an-email",
        }),
      ).toThrow(/email/);
    });

    it("allows clearing an optional field to null", () => {
      const request = parseUserProfileUpdateRequest({
        schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
        expectedRevision: 1,
        team: null,
      });
      expect(request.team).toBeNull();
    });

    it("rejects an https-only violation for a url avatar", () => {
      expect(() =>
        parseUserProfileUpdateRequest({
          schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
          expectedRevision: 1,
          avatar: { kind: "url", value: "http://insecure.example.test/a.png" },
        }),
      ).toThrow(/https/);
    });

    it("rejects identity/authorization fields as contract drift", () => {
      expect(() =>
        parseUserProfileUpdateRequest({
          schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
          expectedRevision: 1,
          status: "active",
        }),
      ).toThrow(/unknown key/);
      expect(() =>
        parseUserProfileUpdateRequest({
          schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
          expectedRevision: 1,
          provenance: "local",
        }),
      ).toThrow(/unknown key/);
      expect(() =>
        parseUserProfileUpdateRequest({
          schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
          expectedRevision: 1,
          id: "local:mallory",
        }),
      ).toThrow(/unknown key/);
    });
  });
});

describe("self-view directory-subject redaction", () => {
  const LDAP_DN = "uid=dana,ou=people,dc=example,dc=test";

  it("replaces an LDAP DN with a linkage marker that is still a valid profile", () => {
    const profile = baseProfile({
      id: LDAP_DN,
      username: "dana",
      provenance: "ldap",
      directorySubject: LDAP_DN,
      directorySyncStatus: "synced",
    });
    const redacted = redactProfileForSelfView(profile);

    expect(redacted.directorySubject).toBe(REDACTED_DIRECTORY_SUBJECT);
    // The id carries the same DN under directory auth, so it is redacted too.
    expect(redacted.id).toBe(REDACTED_SELF_PROFILE_ID);
    expect(JSON.stringify(redacted)).not.toContain("ou=people");
    expect(JSON.stringify(redacted)).not.toContain("dc=example");
    // Still parses: the linkage indicator survives, so the UI can keep
    // distinguishing "linked" from "not linked".
    expect(() => parseUserProfile(redacted)).not.toThrow();
    expect(Boolean(redacted.directorySubject)).toBe(true);
  });

  it("redacts an OIDC subject and an imported historical subject too", () => {
    for (const [provenance, subject, syncStatus] of [
      ["oidc", "b3f1c0de-0000-4000-8000-000000000000", "synced"],
      ["imported_historical", "imported:example-installation:actor-42", "not_synced"],
    ] as const) {
      const redacted = redactProfileForSelfView(
        baseProfile({
          id: subject,
          provenance,
          directorySubject: subject,
          directorySyncStatus: syncStatus,
        }),
      );
      expect(redacted.directorySubject).toBe(REDACTED_DIRECTORY_SUBJECT);
      expect(redacted.id).toBe(REDACTED_SELF_PROFILE_ID);
      expect(JSON.stringify(redacted)).not.toContain(subject);
    }
  });

  it("leaves a local profile untouched and changes no other field", () => {
    const local = baseProfile();
    expect(redactProfileForSelfView(local)).toBe(local);

    const directory = baseProfile({
      provenance: "ldap",
      directorySubject: LDAP_DN,
      directorySyncStatus: "synced",
    });
    const redacted = redactProfileForSelfView(directory);
    expect({ ...redacted, id: "x", directorySubject: null }).toEqual({
      ...directory,
      id: "x",
      directorySubject: null,
    });
    // Non-mutating: the caller's record still holds the real subject for
    // admin surfaces that legitimately need it.
    expect(directory.directorySubject).toBe(LDAP_DN);
  });

  it("is idempotent", () => {
    const once = redactProfileForSelfView(
      baseProfile({
        provenance: "ldap",
        directorySubject: LDAP_DN,
        directorySyncStatus: "synced",
      }),
    );
    expect(redactProfileForSelfView(once)).toEqual(once);
  });

  it("does not leak a DN that carries filter or DN metacharacters", () => {
    const injected = String.raw`uid=a*)(uid=*),ou=people\2Cdc=example,dc=test`;
    const redacted = redactProfileForSelfView(
      baseProfile({
        id: injected,
        provenance: "ldap",
        directorySubject: injected,
        directorySyncStatus: "synced",
      }),
    );
    expect(redacted.directorySubject).toBe(REDACTED_DIRECTORY_SUBJECT);
    expect(JSON.stringify(redacted)).not.toContain("uid=a*");
  });
});
