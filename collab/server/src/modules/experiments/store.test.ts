import { describe, expect, it } from "vitest";
import {
  MemoryExperimentStore,
  PgExperimentStore,
  type ExperimentRow,
} from "./store.js";
import type { InteractionTraceV1 } from "@cd-collab/contracts";

const AGREEMENT = {
  sharedAnchors: [],
  candidateSpecific: [],
  roleConflicts: [],
  notes: [
    "Agreement is not proof of correctness.",
    "Imported comparison contains no supplied agreement analysis; agreement remains unknown.",
  ],
};

function experimentRow(): ExperimentRow {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    caseId: "00000000-0000-0000-0000-000000000011",
    packageId: "pkg-test",
    sourceSchemaId: "cd-collab.experiment_package.v1",
    taskFingerprint: `task-${"a".repeat(64)}`,
    snapshotFingerprint: `snap-${"b".repeat(64)}`,
    snapshotProof: {
      basis: "host_frozen_snapshot",
      fairnessClass: "same_snapshot",
      lineageClass: "derived",
    },
    candidates: [],
    agreement: AGREEMENT,
    createdAt: "2026-08-20T00:00:00.000Z",
    importerId: "fixture-operator",
    importerUsername: "fixture-operator",
  };
}

describe("PgExperimentStore trace identity boundary", () => {
  it("stores a database UUID separately from a public trace alias", async () => {
    let params: unknown[] | undefined;
    const db = {
      query: async (_text: string, values: unknown[]) => {
        params = values;
        return { rows: [] };
      },
    };
    const store = new PgExperimentStore(db as never);
    const trace = {
      traceId: "trace-programmatic-diverge-v1",
      candidateId: "candidate-programmatic",
      createdAt: "2026-08-20T00:00:00.000Z",
    } as unknown as InteractionTraceV1;

    await store.insertTrace(
      "00000000-0000-0000-0000-000000000001",
      trace,
      "fingerprint",
    );

    expect(params?.[0]).not.toBe(trace.traceId);
    expect(params?.[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(params?.[5]).toContain(trace.traceId);
  });
});

describe("experiment snapshot proof persistence boundary", () => {
  it("stores host proof inside the immutable agreement envelope and returns isolated copies", async () => {
    let params: unknown[] | undefined;
    const db = {
      query: async (_text: string, values: unknown[]) => {
        params = values;
        return { rows: [] };
      },
    };
    const pg = new PgExperimentStore(db as never);
    await pg.insert(experimentRow());
    const encoded = JSON.parse(String(params?.[7])) as {
      publicAgreement: unknown;
      snapshotProof: unknown;
    };
    expect(encoded.publicAgreement).toEqual(AGREEMENT);
    expect(encoded.snapshotProof).toEqual(experimentRow().snapshotProof);

    const memory = new MemoryExperimentStore();
    await memory.insert(experimentRow());
    const first = await memory.get(experimentRow().id);
    expect(first?.snapshotProof).toEqual(experimentRow().snapshotProof);
    first!.snapshotProof.fairnessClass = "unknown";
    expect((await memory.get(experimentRow().id))?.snapshotProof.fairnessClass).toBe(
      "same_snapshot",
    );
  });

  it("reads legacy rows as unknown and rejects internally inconsistent stored proof", async () => {
    const raw = {
      id: experimentRow().id,
      case_id: experimentRow().caseId,
      package_id: experimentRow().packageId,
      source_schema_id: experimentRow().sourceSchemaId,
      task_fingerprint: experimentRow().taskFingerprint,
      snapshot_fingerprint: experimentRow().snapshotFingerprint,
      candidates: [],
      agreement: AGREEMENT,
      created_at: experimentRow().createdAt,
      importer_id: experimentRow().importerId,
      importer_username: experimentRow().importerUsername,
    };
    const legacy = new PgExperimentStore({ query: async () => ({ rows: [raw] }) } as never);
    expect((await legacy.get(experimentRow().id))?.snapshotProof).toEqual({
      basis: "unknown",
      fairnessClass: "unknown",
      lineageClass: "unknown",
    });

    const malformed = new PgExperimentStore({
      query: async () => ({
        rows: [
          {
            ...raw,
            agreement: {
              publicAgreement: AGREEMENT,
              snapshotProof: {
                basis: "unknown",
                fairnessClass: "same_snapshot",
                lineageClass: "unknown",
              },
            },
          },
        ],
      }),
    } as never);
    await expect(malformed.get(experimentRow().id)).rejects.toThrow(
      "unknown stored snapshot proof cannot claim fairness or lineage",
    );

    const proofWithRawIdentity = {
      ...experimentRow(),
      snapshotProof: {
        ...experimentRow().snapshotProof,
        rawFingerprint: "must-not-be-stored",
      },
    } as ExperimentRow;
    const rejectingInsert = new PgExperimentStore({
      query: async () => ({ rows: [] }),
    } as never);
    await expect(rejectingInsert.insert(proofWithRawIdentity)).rejects.toThrow(
      "invalid stored experiment snapshot proof fields",
    );

    const envelopeWithUnknownField = new PgExperimentStore({
      query: async () => ({
        rows: [
          {
            ...raw,
            agreement: {
              publicAgreement: AGREEMENT,
              snapshotProof: experimentRow().snapshotProof,
              rawFingerprint: "must-not-be-read",
            },
          },
        ],
      }),
    } as never);
    await expect(envelopeWithUnknownField.get(experimentRow().id)).rejects.toThrow(
      "invalid stored experiment snapshot proof envelope fields",
    );

    const legacyMemory = new MemoryExperimentStore();
    const legacyRow = { ...experimentRow() };
    delete (legacyRow as Partial<ExperimentRow>).snapshotProof;
    await legacyMemory.insert(legacyRow);
    expect((await legacyMemory.get(legacyRow.id))?.snapshotProof).toEqual({
      basis: "unknown",
      fairnessClass: "unknown",
      lineageClass: "unknown",
    });
  });
});
