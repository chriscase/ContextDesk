import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parseCaseBoard } from "./case-board.js";
import { ContractViolation } from "./parse.js";
import {
  parseSnapshot,
  parseSnapshotList,
  snapshotFairness,
  snapshotFingerprint,
  snapshotItemContentHash,
  type SnapshotEvidenceV1,
  type SnapshotFingerprintInput,
} from "./snapshot.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");
const schemasDir = join(here, "..", "schemas");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as unknown;
}

function validRecord(): Record<string, unknown> {
  return structuredClone(load("snapshot.valid.json")) as Record<string, unknown>;
}

function fingerprintInput(row: Record<string, unknown>): SnapshotFingerprintInput {
  return {
    parentSnapshotId: (row.parentSnapshotId as string | null) ?? null,
    evidence: row.evidence as SnapshotEvidenceV1[],
    visibility: row.visibility as SnapshotFingerprintInput["visibility"],
    protocolVersion: String(row.protocolVersion),
  };
}

function withFingerprint(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, fingerprint: snapshotFingerprint(fingerprintInput(row)) };
}

describe("snapshot contract", () => {
  it("accepts the frozen lander-shaped fixture and rejects unknown fields", () => {
    const snapshot = parseSnapshot(load("snapshot.valid.json"));
    expect(snapshot.schemaId).toBe("cd-collab.snapshot.v1");
    expect(snapshot.id).toBe("snapshot-1");
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.evidence.map((item) => item.evidenceId)).toEqual(["artifact-b", "artifact-a"]);
    expect(snapshot.visibility).toBe("owner_only");
    expect(snapshot.fairnessClass).toBe("same_snapshot");
    expect(snapshot.status).toBe("frozen");
    expect(snapshot.createdBy).toBe("alice");
    expect("snapshotId" in snapshot).toBe(false);
    expect("items" in snapshot).toBe(false);
    expect("visibilityPolicy" in snapshot).toBe(false);
    expect("fairness" in snapshot).toBe(false);
    expect(() => parseSnapshot(load("snapshot.unknown-field.json"))).toThrow(/unknown key/);
  });

  it("fingerprints from { parentSnapshotId, evidence, visibility, protocolVersion }", () => {
    const snapshot = parseSnapshot(load("snapshot.valid.json"));
    const input: SnapshotFingerprintInput = {
      parentSnapshotId: snapshot.parentSnapshotId,
      evidence: snapshot.evidence,
      visibility: snapshot.visibility,
      protocolVersion: snapshot.protocolVersion,
    };
    expect(snapshotFingerprint(input)).toBe(snapshot.fingerprint);
    expect(snapshotFingerprint(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotFingerprint({ ...input, evidence: [...snapshot.evidence].reverse() })).toBe(
      snapshot.fingerprint,
    );
    expect(snapshotFingerprint({ ...input, visibility: "share_safe" })).not.toBe(snapshot.fingerprint);
    expect(snapshotFingerprint({ ...input, evidence: snapshot.evidence.slice(0, 1) })).not.toBe(
      snapshot.fingerprint,
    );
    expect(snapshotFingerprint({ ...input, parentSnapshotId: "snapshot-parent" })).not.toBe(
      snapshot.fingerprint,
    );
  });

  it("preserves supplied evidence order while hashing independently of that order", () => {
    const valid = validRecord();
    const evidence = [...(valid.evidence as SnapshotEvidenceV1[])].reverse();
    const parsed = parseSnapshot(withFingerprint({ ...valid, evidence }));
    expect(parsed.evidence.map((item) => item.evidenceId)).toEqual(["artifact-a", "artifact-b"]);
    expect(parsed.fingerprint).toBe(
      (load("snapshot.valid.json") as { fingerprint: string }).fingerprint,
    );
  });

  it("reports unknown fairness when equality cannot be established", () => {
    expect(
      snapshotFairness([
        {
          evidenceId: "ev-a",
          ordinal: 0,
          contentHash: null,
          expectedHash: null,
          verificationStatus: "unverified",
          privacyClass: "owner_only",
        },
      ]),
    ).toBe("unknown");
    expect(snapshotFairness([])).toBe("same_snapshot");
    expect(
      snapshotFairness(
        (load("snapshot.valid.json") as { evidence: SnapshotEvidenceV1[] }).evidence,
      ),
    ).toBe("same_snapshot");
    const unknownDoc = withFingerprint({
      ...validRecord(),
      evidence: [
        {
          evidenceId: "ev-missing",
          ordinal: 0,
          contentHash: null,
          expectedHash: null,
          verificationStatus: null,
          privacyClass: "owner_only",
        },
      ],
      fairnessClass: "unknown",
    });
    expect(parseSnapshot(unknownDoc).fairnessClass).toBe("unknown");
  });

  it("maps an honest content hash or expectedHash without inventing bytes", () => {
    expect(snapshotItemContentHash({ contentHash: "a".repeat(64), expectedHash: null })).toBe(
      "a".repeat(64),
    );
    expect(snapshotItemContentHash({ contentHash: null, expectedHash: "b".repeat(64) })).toBe(
      "b".repeat(64),
    );
    expect(snapshotItemContentHash({ contentHash: null, expectedHash: null })).toBeNull();
  });

  it("rejects duplicate or empty evidence identities, forged fingerprints, and bad ordinals", () => {
    const valid = validRecord();
    const dup = structuredClone(valid.evidence) as Record<string, unknown>[];
    dup.push({ ...dup[0], ordinal: 99 });
    expect(() => parseSnapshot({ ...valid, evidence: dup })).toThrow(/duplicate evidenceId/);
    const emptyId = structuredClone(valid.evidence) as Record<string, unknown>[];
    emptyId[0] = { ...emptyId[0], evidenceId: "  " };
    expect(() => parseSnapshot(withFingerprint({ ...valid, evidence: emptyId }))).toThrow(
      /must not be empty/,
    );
    const dupOrdinal = structuredClone(valid.evidence) as Record<string, unknown>[];
    dupOrdinal[1] = { ...dupOrdinal[1], ordinal: dupOrdinal[0]?.ordinal };
    expect(() => parseSnapshot(withFingerprint({ ...valid, evidence: dupOrdinal }))).toThrow(
      /duplicate ordinal/,
    );
    expect(() => parseSnapshot({ ...valid, fingerprint: "f".repeat(64) })).toThrow(
      /canonical snapshot fingerprint/,
    );
  });

  it("rejects malformed hashes, empty protocol values, and invalid timestamps", () => {
    const valid = validRecord();
    const badHash = structuredClone(valid.evidence) as Record<string, unknown>[];
    badHash[0] = { ...badHash[0], contentHash: "not-a-hash" };
    expect(() => parseSnapshot({ ...valid, evidence: badHash })).toThrow(/SHA-256/);
    const badExpected = structuredClone(valid.evidence) as Record<string, unknown>[];
    badExpected[1] = { ...badExpected[1], expectedHash: "ABC" };
    expect(() => parseSnapshot({ ...valid, evidence: badExpected })).toThrow(/SHA-256/);
    expect(() => parseSnapshot({ ...valid, protocolVersion: "  " })).toThrow(/must not be empty/);
    expect(() => parseSnapshot({ ...valid, createdAt: "yesterday" })).toThrow(/RFC3339/);
    expect(() => parseSnapshot({ ...valid, caseId: "" })).toThrow(/must not be empty/);
    expect(() => parseSnapshot({ ...valid, id: "  " })).toThrow(/must not be empty/);
  });

  it("accepts parent lineage, empty evidence sets, and rejects self-reference", () => {
    const valid = validRecord();
    const child = withFingerprint({ ...valid, id: "snapshot-2", parentSnapshotId: "snapshot-1" });
    expect(parseSnapshot(child).parentSnapshotId).toBe("snapshot-1");
    expect(parseSnapshot(child).fingerprint).not.toBe(
      (load("snapshot.valid.json") as { fingerprint: string }).fingerprint,
    );
    expect(() =>
      parseSnapshot(withFingerprint({ ...valid, parentSnapshotId: String(valid.id) })),
    ).toThrow(/must not reference the snapshot itself/);
    const empty = withFingerprint({ ...valid, evidence: [] });
    expect(parseSnapshot(empty).evidence).toEqual([]);
    expect(snapshotFairness([])).toBe("same_snapshot");
  });

  it("requires creator provenance and share-safe visibility honesty", () => {
    const valid = validRecord();
    expect(() => parseSnapshot({ ...valid, createdBy: "  " })).toThrow(/creator identity/);
    expect(() =>
      parseSnapshot(withFingerprint({ ...valid, visibility: "share_safe" })),
    ).toThrow(/share-safe snapshot cannot include owner-only evidence/);
    const shareSafeEvidence = (valid.evidence as SnapshotEvidenceV1[]).map((item) => ({
      ...item,
      privacyClass: "share_safe" as const,
    }));
    const shareSafe = withFingerprint({
      ...valid,
      visibility: "share_safe",
      evidence: shareSafeEvidence,
    });
    expect(parseSnapshot(shareSafe).visibility).toBe("share_safe");
  });

  it("parses a snapshot list through the same fail-closed snapshot rules", () => {
    const snapshot = load("snapshot.valid.json");
    const list = parseSnapshotList({
      schemaId: "cd-collab.snapshot_list.v1",
      caseId: "case-1",
      snapshots: [snapshot],
    });
    expect(list.snapshots[0]?.id).toBe("snapshot-1");
    expect(list.snapshots[0]?.evidence).toHaveLength(2);
    expect(() =>
      parseSnapshotList({
        schemaId: "cd-collab.snapshot_list.v1",
        caseId: "case-1",
        snapshots: [{ ...(snapshot as object), leak: true }],
      }),
    ).toThrow(/unknown key/);
  });

  it("JSON schema rejects unknown fields on the snapshot fixture", () => {
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(join(schemasDir, "snapshot.v1.json"), "utf8")) as object,
    );
    expect(validate(load("snapshot.valid.json"))).toBe(true);
    expect(validate(load("snapshot.unknown-field.json"))).toBe(false);
  });

  it("keeps board agreement separate from correctness and gold", () => {
    const board = parseCaseBoard({
      schemaId: "cd-collab.case_board.v1",
      caseId: "case-1",
      snapshotId: "snapshot-1",
      generatedAt: "2026-08-20T00:00:00.000Z",
      goldStatus: "unknown",
      findings: [
        {
          id: "finding-1",
          bucket: "agreed",
          statement: "Multiple supported hypotheses reference the same evidence.",
          evidenceRefs: ["artifact-a"],
          contributionRefs: ["hypothesis-1", "hypothesis-2"],
          agreement: "shared",
          confidence: "medium",
          basis: "evidence",
        },
      ],
      notice: "Agreement is not proof of correctness.",
    });
    expect(board.goldStatus).toBe("unknown");
    expect(board.findings[0]?.agreement).toBe("shared");
  });

  it("does not throw ContractViolation for a valid parse path", () => {
    expect(() => parseSnapshot(load("snapshot.valid.json"))).not.toThrow(ContractViolation);
  });
});
