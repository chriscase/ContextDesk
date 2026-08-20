import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_VISIBILITY_POLICY,
  SNAPSHOT_SCHEMA_ID,
  parseSnapshot,
  snapshotFairness,
  snapshotFingerprint,
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

describe("snapshot contract", () => {
  it("accepts the frozen snapshot fixture and rejects unknown fields", () => {
    const snapshot = parseSnapshot(load("snapshot.valid.json"));
    expect(snapshot.schemaId).toBe(SNAPSHOT_SCHEMA_ID);
    expect(snapshot.status).toBe("frozen");
    expect(snapshot.fairness).toBe("same_snapshot");
    expect(snapshot.items).toHaveLength(2);
    expect(() => parseSnapshot(load("snapshot.unknown-field.json"))).toThrow(/unknown key/);
  });

  it("fingerprints from canonical sorted evidence identities, hashes, and protocol fields", () => {
    const snapshot = parseSnapshot(load("snapshot.valid.json"));
    const reversed = snapshotFingerprint({
      caseId: snapshot.caseId,
      parentSnapshotId: snapshot.parentSnapshotId,
      items: [...snapshot.items].reverse(),
      visibilityPolicy: snapshot.visibilityPolicy,
      protocolId: snapshot.protocolId,
      protocolVersion: snapshot.protocolVersion,
    });
    expect(reversed).toBe(snapshot.fingerprint);
    expect(reversed).toBe(
      snapshotFingerprint({
        caseId: snapshot.caseId,
        parentSnapshotId: snapshot.parentSnapshotId,
        items: snapshot.items,
        visibilityPolicy: DEFAULT_SNAPSHOT_VISIBILITY_POLICY,
        protocolId: null,
        protocolVersion: null,
      }),
    );

    const differentParent = snapshotFingerprint({
      caseId: snapshot.caseId,
      parentSnapshotId: "22222222-2222-4222-8222-222222222222",
      items: snapshot.items,
      visibilityPolicy: snapshot.visibilityPolicy,
      protocolId: snapshot.protocolId,
      protocolVersion: snapshot.protocolVersion,
    });
    expect(differentParent).not.toBe(snapshot.fingerprint);

    const hiddenVisible = snapshotFingerprint({
      caseId: snapshot.caseId,
      parentSnapshotId: snapshot.parentSnapshotId,
      items: snapshot.items.map((item) =>
        item.evidenceId === "ev-a"
          ? { ...item, visibility: "hidden" as const }
          : item,
      ),
      visibilityPolicy: snapshot.visibilityPolicy,
      protocolId: snapshot.protocolId,
      protocolVersion: snapshot.protocolVersion,
    });
    expect(hiddenVisible).not.toBe(snapshot.fingerprint);
  });

  it("treats missing visible hashes as unknown_visibility and does not use extra_evidence", () => {
    expect(
      snapshotFairness([
        {
          evidenceId: "ev-a",
          contentHash: null,
          visibility: "strategy_visible",
          privacyClass: "owner_only",
        },
      ]),
    ).toBe("unknown_visibility");
    expect(
      snapshotFairness([
        {
          evidenceId: "ev-hidden",
          contentHash: null,
          visibility: "hidden",
          privacyClass: "owner_only",
        },
      ]),
    ).toBe("unknown_visibility");
  });

  it("rejects empty items, duplicate evidence, forged fingerprints, and forged fairness", () => {
    const valid = load("snapshot.valid.json") as Record<string, unknown>;
    expect(() => parseSnapshot({ ...valid, items: [] })).toThrow(/at least one evidence item/);
    const items = structuredClone(valid.items) as Record<string, unknown>[];
    items.push({ ...items[0] });
    expect(() => parseSnapshot({ ...valid, items })).toThrow(/duplicate evidenceId/);
    expect(() =>
      parseSnapshot({
        ...valid,
        fingerprint: "snap-0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).toThrow(/canonical snapshot fingerprint/);
    expect(() => parseSnapshot({ ...valid, fairness: "unknown_visibility" })).toThrow(
      /must be same_snapshot/,
    );
    expect(() => parseSnapshot({ ...valid, snapshotId: "not-a-uuid" })).toThrow(/UUID/);
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
});
