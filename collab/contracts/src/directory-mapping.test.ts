import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
  mapDirectoryClaimsToProfileFields,
  parseDirectoryAttributeMap,
  resolveDirectoryIdentityCollision,
} from "./directory-mapping.js";
import { ContractViolation } from "./parse.js";

describe("directory attribute map", () => {
  it("accepts the default LDAP-flavored map", () => {
    expect(parseDirectoryAttributeMap(DEFAULT_DIRECTORY_ATTRIBUTE_MAP)).toEqual(
      DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
    );
  });

  it("rejects two logical fields mapped to the same attribute name (ambiguous, fail-closed)", () => {
    expect(() =>
      parseDirectoryAttributeMap({
        ...DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
        attributes: { ...DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes, roleTitle: "cn" },
      }),
    ).toThrow(/distinct/);
  });

  it("rejects an empty or oversized attribute name", () => {
    expect(() =>
      parseDirectoryAttributeMap({
        ...DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
        attributes: { ...DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes, displayName: "" },
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseDirectoryAttributeMap({
        ...DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
        attributes: { ...DEFAULT_DIRECTORY_ATTRIBUTE_MAP.attributes, displayName: "x".repeat(200) },
      }),
    ).toThrow(ContractViolation);
  });
});

describe("mapDirectoryClaimsToProfileFields", () => {
  it("maps present claims and skips absent or empty ones", () => {
    const result = mapDirectoryClaimsToProfileFields(
      { cn: "Alice Analyst", mail: "alice@example.test", departmentNumber: "  " },
      DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
    );
    expect(result.fields).toEqual({
      displayName: "Alice Analyst",
      contactEmail: "alice@example.test",
    });
    expect(result.skipped.sort()).toEqual(["roleTitle", "team"]);
  });

  it("matches claim names case-insensitively when the value is unambiguous", () => {
    const result = mapDirectoryClaimsToProfileFields(
      { CN: "Alice Analyst", Mail: "alice@example.test" },
      DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
    );
    expect(result.fields.displayName).toBe("Alice Analyst");
    expect(result.fields.contactEmail).toBe("alice@example.test");
  });

  it("fails closed when the same attribute appears with conflicting values under different casings", () => {
    expect(() =>
      mapDirectoryClaimsToProfileFields(
        { cn: "Alice", CN: "Alicia" },
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
      ),
    ).toThrow(/ambiguous/);
  });

  it("throws on an oversized directory value instead of truncating", () => {
    expect(() =>
      mapDirectoryClaimsToProfileFields(
        { cn: "x".repeat(500) },
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
      ),
    ).toThrow(/unsafe or exceeds/);
  });

  it("throws on a directory value carrying an invisible character", () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    expect(() =>
      mapDirectoryClaimsToProfileFields(
        { cn: `Alice${zeroWidthSpace}Analyst` },
        DEFAULT_DIRECTORY_ATTRIBUTE_MAP,
      ),
    ).toThrow(/unsafe/);
  });
});

describe("resolveDirectoryIdentityCollision", () => {
  const incomingUsername = "alice";
  const incomingDirectorySubject = "uid=alice,ou=people,dc=example,dc=test";

  it("creates when neither the username nor the directory subject is known", () => {
    expect(
      resolveDirectoryIdentityCollision({
        incomingUsername,
        incomingDirectorySubject,
        byUsername: null,
        byDirectorySubject: null,
      }),
    ).toBe("create");
  });

  it("updates when the directory subject is already known under the same identity", () => {
    expect(
      resolveDirectoryIdentityCollision({
        incomingUsername,
        incomingDirectorySubject,
        byUsername: { id: "p1", directorySubject: incomingDirectorySubject },
        byDirectorySubject: { id: "p1", username: incomingUsername },
      }),
    ).toBe("update");
  });

  it("updates through an upstream username rename (subject known, new username unclaimed)", () => {
    expect(
      resolveDirectoryIdentityCollision({
        incomingUsername: "alice-renamed",
        incomingDirectorySubject,
        byUsername: null,
        byDirectorySubject: { id: "p1", username: "alice" },
      }),
    ).toBe("update");
  });

  it("fails closed when the username is already owned by a different profile", () => {
    expect(
      resolveDirectoryIdentityCollision({
        incomingUsername,
        incomingDirectorySubject,
        byUsername: { id: "p-local-alice", directorySubject: null },
        byDirectorySubject: null,
      }),
    ).toBe("collision");
  });

  it("fails closed when username and directory-subject lookups disagree on identity", () => {
    expect(
      resolveDirectoryIdentityCollision({
        incomingUsername,
        incomingDirectorySubject,
        byUsername: { id: "p1", directorySubject: "uid=someone-else,ou=people,dc=example,dc=test" },
        byDirectorySubject: { id: "p2", username: "someone-else" },
      }),
    ).toBe("collision");
  });

  it("never auto-maps by display name alone: the resolver has no display-name input at all", () => {
    // Structural guard: DirectoryIdentityLookupV1 only carries username and
    // directorySubject inputs. If a displayName-based signal is ever added
    // to this decision, this test's fixture will need one too and will
    // force a conscious review of the auto-map risk it re-introduces.
    const input: Parameters<typeof resolveDirectoryIdentityCollision>[0] = {
      incomingUsername,
      incomingDirectorySubject,
      byUsername: null,
      byDirectorySubject: null,
    };
    expect(Object.keys(input).sort()).toEqual(
      ["byDirectorySubject", "byUsername", "incomingDirectorySubject", "incomingUsername"].sort(),
    );
  });
});
