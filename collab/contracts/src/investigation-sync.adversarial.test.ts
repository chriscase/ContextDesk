import { describe, expect, it } from "vitest";
import {
  INVESTIGATION_SYNC_STATE_SCHEMA_ID,
  attachInvestigationSyncIntegrity,
  investigationSyncObjectHash,
  parseInvestigationSyncBatch,
  planInvestigationSync,
  type InvestigationSyncBatchUnsignedV1,
  type InvestigationSyncDestinationStateV1,
} from "./investigation-sync.js";

function evidenceHash(
  payloadJson: string,
  revision: number,
  privacyClass: "owner_only" | "share_safe" = "owner_only",
): string {
  return investigationSyncObjectHash({
    sourceInstallationId: "inst-syntheticnorth",
    investigationId: "investigation-synthetic-001",
    kind: "evidence",
    objectId: "evidence-synthetic-timeout",
    revision,
    privacyClass,
    tombstoned: false,
    payloadJson,
    tombstoneReason: null,
  });
}

function batchWithPayload(payloadJson = '{"message":"Synthetic observation"}') {
  const unsigned: InvestigationSyncBatchUnsignedV1 = {
    sourceInstallationId: "inst-syntheticnorth",
    investigationId: "investigation-synthetic-001",
    fromCursor: {
      sourceInstallationId: "inst-syntheticnorth",
      throughSequence: 0,
      lastOperationId: null,
      lastOperationFingerprint: null,
    },
    operations: [
      {
        operationId: "syncop-synthetic000001",
        sourceInstallationId: "inst-syntheticnorth",
        sourceSequence: 1,
        emittedAt: "2026-08-24T12:00:00.000Z",
        investigationId: "investigation-synthetic-001",
        actor: {
          sourceActorId: "actor-synthetic-operator",
          displayName: "Synthetic Operator",
          kind: "human",
        },
        mutation: "upsert",
        object: {
          kind: "evidence",
          objectId: "evidence-synthetic-timeout",
          baseRevision: 0,
          resultRevision: 1,
          baseHash: null,
          resultHash: evidenceHash(payloadJson, 1),
          privacyClass: "owner_only",
        },
        payloadJson,
        tombstoneReason: null,
      },
    ],
  };
  return attachInvestigationSyncIntegrity(unsigned);
}

function destination(): InvestigationSyncDestinationStateV1 {
  return {
    schemaId: INVESTIGATION_SYNC_STATE_SCHEMA_ID,
    destinationInstallationId: "inst-syntheticshared",
    investigationId: "investigation-synthetic-001",
    checkpoint: {
      sourceInstallationId: "inst-syntheticnorth",
      throughSequence: 0,
      lastOperationId: null,
      lastOperationFingerprint: null,
    },
    acceptedPrivacyClasses: ["owner_only", "share_safe"],
    objects: [],
    appliedOperations: [],
  };
}

describe("investigation sync adversarial boundaries", () => {
  it("rejects unknown contract fields", () => {
    const raw = structuredClone(batchWithPayload()) as unknown as Record<string, unknown>;
    raw.autoApply = true;
    expect(() => parseInvestigationSyncBatch(raw)).toThrow(/unknown key/);
  });

  it.each([
    ['{"credentials":{"value":"synthetic"}}', /credential/],
    ['{"userRoles":["lead"]}', /role/],
    ['{"capabilities":["administer"]}', /capability/],
    ['{"membership":{"group":"operators"}}', /membership/],
  ])("rejects excluded authority payload %s", (payload, message) => {
    expect(() => batchWithPayload(payload)).not.toThrow();
    expect(() => parseInvestigationSyncBatch(batchWithPayload(payload))).toThrow(message);
  });

  it("rejects non-canonical payload JSON", () => {
    expect(() => parseInvestigationSyncBatch(batchWithPayload('{"z":1,"a":2}'))).toThrow(
      /canonical JSON key ordering/,
    );
  });

  it("rejects control and zero-width characters in identifiers and payload", () => {
    const identifier = structuredClone(batchWithPayload());
    identifier.operations[0]!.object.objectId = "evidence-synthetic\u200btimeout";
    expect(() => parseInvestigationSyncBatch(identifier)).toThrow(/opaque identifier|zero-width/);

    expect(() => parseInvestigationSyncBatch(batchWithPayload('{"message":"synthetic\\u0000text"}'))).toThrow(
      /control or zero-width/,
    );
  });

  it("rejects a tampered append-only chain", () => {
    const raw = structuredClone(batchWithPayload());
    raw.operations[0]!.previousOperationFingerprint = "0".repeat(64);
    expect(() => parseInvestigationSyncBatch(raw)).toThrow(/append-only chain mismatch|fingerprint mismatch/);
  });

  it("rejects a tampered batch fingerprint", () => {
    const raw = structuredClone(batchWithPayload());
    raw.batchFingerprint = "0".repeat(64);
    expect(() => parseInvestigationSyncBatch(raw)).toThrow(/batch fingerprint mismatch/);
  });

  it("blocks a stale destination cursor", () => {
    const state = destination();
    state.checkpoint = {
      sourceInstallationId: "inst-syntheticnorth",
      throughSequence: 3,
      lastOperationId: "syncop-synthetic000003",
      lastOperationFingerprint: "3".repeat(64),
    };
    state.appliedOperations = [
      {
        operationId: "syncop-synthetic000003",
        operationFingerprint: "3".repeat(64),
        sourceInstallationId: "inst-syntheticnorth",
        sourceSequence: 3,
      },
    ];
    const plan = planInvestigationSync(batchWithPayload(), state);
    expect(plan.outcome).toBe("blocked");
    expect(plan.conflicts.map((row) => row.code)).toEqual(["cursor_mismatch"]);
    expect(plan.checkpointAfter).toEqual(state.checkpoint);
  });

  it("blocks operation-id and source-sequence collisions deterministically", () => {
    const batch = batchWithPayload();
    const state = destination();
    state.appliedOperations = [
      {
        operationId: batch.operations[0]!.operationId,
        operationFingerprint: "4".repeat(64),
        sourceInstallationId: "inst-syntheticnorth",
        sourceSequence: 9,
      },
      {
        operationId: "syncop-synthetic999999",
        operationFingerprint: "5".repeat(64),
        sourceInstallationId: "inst-syntheticnorth",
        sourceSequence: 1,
      },
    ];
    state.checkpoint = {
      sourceInstallationId: "inst-syntheticnorth",
      throughSequence: 9,
      lastOperationId: batch.operations[0]!.operationId,
      lastOperationFingerprint: "4".repeat(64),
    };
    const plan = planInvestigationSync(batch, state);
    expect(plan.outcome).toBe("blocked");
    expect(plan.conflicts.map((row) => row.code)).toContain("operation_identity_collision");
    expect(plan.conflicts.map((row) => row.code)).toContain("source_sequence_collision");
  });

  it("blocks revision and base-hash conflicts", () => {
    const payload = '{"message":"Synthetic revised observation"}';
    const unsigned: InvestigationSyncBatchUnsignedV1 = {
      sourceInstallationId: "inst-syntheticnorth",
      investigationId: "investigation-synthetic-001",
      fromCursor: destination().checkpoint,
      operations: [
        {
          operationId: "syncop-synthetic000001",
          sourceInstallationId: "inst-syntheticnorth",
          sourceSequence: 1,
          emittedAt: "2026-08-24T12:00:00.000Z",
          investigationId: "investigation-synthetic-001",
          actor: {
            sourceActorId: "actor-synthetic-reviewer",
            displayName: "Synthetic Reviewer",
            kind: "human",
          },
          mutation: "upsert",
          object: {
            kind: "evidence",
            objectId: "evidence-synthetic-timeout",
            baseRevision: 2,
            resultRevision: 3,
            baseHash: "6".repeat(64),
            resultHash: evidenceHash(payload, 3),
            privacyClass: "owner_only",
          },
          payloadJson: payload,
          tombstoneReason: null,
        },
      ],
    };
    const state = destination();
    state.objects = [
      {
        sourceInstallationId: "inst-syntheticnorth",
        kind: "evidence",
        objectId: "evidence-synthetic-timeout",
        revision: 1,
        objectHash: "7".repeat(64),
        privacyClass: "owner_only",
        tombstoned: false,
      },
    ];
    expect(planInvestigationSync(attachInvestigationSyncIntegrity(unsigned), state).conflicts[0]?.code).toBe(
      "revision_conflict",
    );

    unsigned.operations[0]!.object.baseRevision = 1;
    unsigned.operations[0]!.object.resultRevision = 2;
    unsigned.operations[0]!.object.resultHash = evidenceHash(payload, 2);
    expect(planInvestigationSync(attachInvestigationSyncIntegrity(unsigned), state).conflicts[0]?.code).toBe(
      "base_hash_conflict",
    );
  });

  it("blocks owner-only to share-safe widening", () => {
    const payload = '{"message":"Synthetic revised observation"}';
    const unsigned: InvestigationSyncBatchUnsignedV1 = {
      sourceInstallationId: "inst-syntheticnorth",
      investigationId: "investigation-synthetic-001",
      fromCursor: destination().checkpoint,
      operations: [
        {
          operationId: "syncop-synthetic000001",
          sourceInstallationId: "inst-syntheticnorth",
          sourceSequence: 1,
          emittedAt: "2026-08-24T12:00:00.000Z",
          investigationId: "investigation-synthetic-001",
          actor: {
            sourceActorId: "actor-synthetic-reviewer",
            displayName: "Synthetic Reviewer",
            kind: "human",
          },
          mutation: "upsert",
          object: {
            kind: "evidence",
            objectId: "evidence-synthetic-timeout",
            baseRevision: 1,
            resultRevision: 2,
            baseHash: "7".repeat(64),
            resultHash: evidenceHash(payload, 2, "share_safe"),
            privacyClass: "share_safe",
          },
          payloadJson: payload,
          tombstoneReason: null,
        },
      ],
    };
    const state = destination();
    state.objects = [
      {
        sourceInstallationId: "inst-syntheticnorth",
        kind: "evidence",
        objectId: "evidence-synthetic-timeout",
        revision: 1,
        objectHash: "7".repeat(64),
        privacyClass: "owner_only",
        tombstoned: false,
      },
    ];
    expect(planInvestigationSync(attachInvestigationSyncIntegrity(unsigned), state).conflicts[0]?.code).toBe(
      "privacy_widening",
    );
  });

  it("blocks a privacy class the destination does not accept", () => {
    const state = destination();
    state.acceptedPrivacyClasses = ["share_safe"];
    const plan = planInvestigationSync(batchWithPayload(), state);
    expect(plan.outcome).toBe("blocked");
    expect(plan.conflicts[0]?.code).toBe("privacy_class_not_accepted");
  });

  it("namespaces identical raw object ids by source installation", () => {
    const state = destination();
    state.objects = [
      {
        sourceInstallationId: "inst-syntheticsouth",
        kind: "evidence",
        objectId: "evidence-synthetic-timeout",
        revision: 1,
        objectHash: "8".repeat(64),
        privacyClass: "owner_only",
        tombstoned: false,
      },
    ];
    expect(planInvestigationSync(batchWithPayload(), state).outcome).toBe("apply");
  });

  it("rejects a checkpoint not bound to applied history", () => {
    const state = destination();
    state.checkpoint = {
      sourceInstallationId: "inst-syntheticnorth",
      throughSequence: 1,
      lastOperationId: "syncop-synthetic000001",
      lastOperationFingerprint: "9".repeat(64),
    };
    expect(() => planInvestigationSync(batchWithPayload(), state)).toThrow(/checkpoint tip/);
  });

  it("blocks source loops and mixed partial replay", () => {
    const batch = batchWithPayload();
    const state = destination();
    state.destinationInstallationId = batch.sourceInstallationId;
    state.checkpoint = { ...batch.toCursor };
    state.appliedOperations = [
      {
        operationId: batch.operations[0]!.operationId,
        operationFingerprint: batch.operations[0]!.operationFingerprint,
        sourceInstallationId: batch.sourceInstallationId,
        sourceSequence: 1,
      },
    ];
    const second = structuredClone(batch);
    const plan = planInvestigationSync(second, state);
    expect(plan.outcome).toBe("blocked");
    expect(plan.conflicts.map((row) => row.code)).toContain("source_loop");
  });
});
