import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FILE_SERVER_REF_SCHEMA_ID,
  REFERENCE_RECHECK_LIMITS,
  type FileServerReferenceV1,
  type ReferenceIdentityV1,
  type ReferenceRecheckOutcome,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import {
  ScriptedReferenceObserver,
  asServerOwnedFileServerReferenceIdentity,
  type ReferenceObserver,
  type ServerOwnedFileServerReferenceIdentity,
} from "./index.js";

const HASH = "a".repeat(64);

function storedReference(
  overrides: Partial<FileServerReferenceV1> = {},
): FileServerReferenceV1 {
  return {
    schemaId: FILE_SERVER_REF_SCHEMA_ID,
    id: "private-storage-ref-id",
    uri: "s3://recorded-evidence/incidents/core.log",
    expectedHash: HASH,
    verificationStatus: "unverified",
    ...overrides,
  };
}

describe("ReferenceObserver", () => {
  it("mints only a detached frozen public identity from a stored reference", () => {
    const stored = storedReference();
    const owned = asServerOwnedFileServerReferenceIdentity(stored);
    stored.uri = "s3://attacker-controlled/changed";
    stored.expectedHash = null;
    stored.verificationStatus = "verified";

    expect(owned).toEqual({
      kind: "file_server_ref",
      uri: "s3://recorded-evidence/incidents/core.log",
      expectedHash: HASH,
    });
    expect(Object.isFrozen(owned)).toBe(true);
    expect(owned).not.toHaveProperty("id");
    expect(owned).not.toHaveProperty("refId");
    expect(owned).not.toHaveProperty("schemaId");
    expect(owned).not.toHaveProperty("verificationStatus");
    expect(owned).not.toHaveProperty("credentials");
  });

  it("fails closed on malformed server-loaded public identity fields", () => {
    for (const reference of [
      storedReference({ uri: " s3://recorded-evidence/key" }),
      storedReference({ uri: "s3://recorded-evidence/key\nnext" }),
      storedReference({ uri: "s3://recorded-evidence/\u202Eyek" }),
      storedReference({ uri: "s3://recorded-evidence/\u212B" }),
      storedReference({ uri: "x".repeat(REFERENCE_RECHECK_LIMITS.uriMaxChars + 1) }),
      storedReference({ expectedHash: "A".repeat(64) }),
      storedReference({ expectedHash: "a".repeat(63) }),
      storedReference({ schemaId: "wrong" as typeof FILE_SERVER_REF_SCHEMA_ID }),
    ]) {
      expect(() => asServerOwnedFileServerReferenceIdentity(reference)).toThrow(
        "invalid server-owned file reference identity",
      );
    }
  });

  it("observes both closed outcomes without fetching or mutating a reference", async () => {
    const reachableStored = storedReference();
    const unreachableStored = storedReference({
      uri: "file:///recorded/incidents/missing.log",
      expectedHash: null,
    });
    const reachable = asServerOwnedFileServerReferenceIdentity(reachableStored);
    const unreachable = asServerOwnedFileServerReferenceIdentity(unreachableStored);
    const observer: ReferenceObserver = new ScriptedReferenceObserver([
      [reachable, "reachable_metadata"],
      [unreachable, "unreachable"],
    ]);

    const reachableResult = await observer.observe(reachable);
    const unreachableResult = await observer.observe(unreachable);

    expect(reachableResult.outcome).toBe("reachable_metadata");
    expect(unreachableResult.outcome).toBe("unreachable");
    expect(reachableResult.reference).toEqual(reachable);
    expect(reachableResult.reference).not.toBe(reachable);
    expect(Object.isFrozen(reachableResult)).toBe(true);
    expect(Object.isFrozen(reachableResult.reference)).toBe(true);
    expect(reachableStored).toEqual(storedReference());
    expect(unreachableStored.verificationStatus).toBe("unverified");
  });

  it("rejects unminted targets, unscripted identities, duplicates, and false outcomes", async () => {
    const stored = storedReference();
    const owned = asServerOwnedFileServerReferenceIdentity(stored);
    const observer = new ScriptedReferenceObserver([[owned, "unreachable"]]);
    const requestIdentity: ReferenceIdentityV1 = {
      kind: "file_server_ref",
      uri: stored.uri,
      expectedHash: stored.expectedHash,
    };

    await expect(
      observer.observe(
        requestIdentity as ServerOwnedFileServerReferenceIdentity,
      ),
    ).rejects.toThrow("invalid server-owned file reference identity");

    const other = asServerOwnedFileServerReferenceIdentity(
      storedReference({ uri: "s3://recorded-evidence/other.log" }),
    );
    await expect(observer.observe(other)).rejects.toThrow(
      "reference observation unavailable",
    );
    expect(() => new ScriptedReferenceObserver([
      [owned, "unreachable"],
      [owned, "reachable_metadata"],
    ])).toThrow("duplicate scripted reference observation identity");
    expect(() => new ScriptedReferenceObserver([
      [owned, "verified" as ReferenceRecheckOutcome],
    ])).toThrow("invalid reference observation outcome");
  });

  it("does not couple the observer module to fetch or mutable evidence operations", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./observer.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("verifyFileServerReference");
    expect(source).not.toContain("EvidenceStore");
    expect(source).not.toContain("S3EvidenceError");
    expect(source).not.toMatch(/\b(?:put|restore|abandon)FileServerReference\b/);
  });
});
