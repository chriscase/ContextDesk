import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  INVESTIGATION_SYNC_STATE_SCHEMA_ID,
  attachInvestigationSyncIntegrity,
  canonicalizeInvestigationSyncBatch,
  investigationSyncObjectHash,
  parseInvestigationSyncBatch,
  planInvestigationSync,
  type InvestigationSyncBatchUnsignedV1,
  type InvestigationSyncDestinationStateV1,
} from "./investigation-sync.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;
const here = dirname(fileURLToPath(import.meta.url));

const payload1 = '{"message":"Synthetic timeout observation"}';
const payload2 = '{"message":"Synthetic timeout observation confirmed"}';

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

function unsignedBatch(): InvestigationSyncBatchUnsignedV1 {
  return {
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
          resultHash: evidenceHash(payload1, 1),
          privacyClass: "owner_only",
        },
        payloadJson: payload1,
        tombstoneReason: null,
      },
      {
        operationId: "syncop-synthetic000002",
        sourceInstallationId: "inst-syntheticnorth",
        sourceSequence: 2,
        emittedAt: "2026-08-24T12:01:00.000Z",
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
          baseHash: evidenceHash(payload1, 1),
          resultHash: evidenceHash(payload2, 2),
          privacyClass: "owner_only",
        },
        payloadJson: payload2,
        tombstoneReason: null,
      },
    ],
  };
}

function emptyDestination(): InvestigationSyncDestinationStateV1 {
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

describe("investigation sync foundation", () => {
  it("keeps the JSON schema aligned with the strict parser", () => {
    const schema = JSON.parse(
      readFileSync(join(here, "..", "schemas", "investigation-sync.v1.json"), "utf8"),
    ) as unknown;
    const ajv = new (Ajv2020 as new (options: unknown) => {
      compile: (value: unknown) => (input: unknown) => boolean;
    })({ strict: true, allErrors: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(schema);
    const batch = attachInvestigationSyncIntegrity(unsignedBatch());
    expect(validate(batch)).toBe(true);
    expect(parseInvestigationSyncBatch(batch)).toEqual(batch);
  });

  it("parses a canonical append-only batch and plans both operations atomically", () => {
    const batch = attachInvestigationSyncIntegrity(unsignedBatch());
    const parsed = parseInvestigationSyncBatch(batch);
    const plan = planInvestigationSync(parsed, emptyDestination());

    expect(plan.outcome).toBe("apply");
    expect(plan.operations.map((row) => row.action)).toEqual(["apply", "apply"]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.checkpointAfter).toEqual(batch.toCursor);
    expect(plan.applyAuthorized).toBe(false);
    expect(plan.automaticSync).toBe(false);
    expect(plan.networkingIncluded).toBe(false);
    expect(plan.credentialsTransferred).toBe(false);
    expect(plan.membershipGranted).toBe(false);
    expect(plan.rolesGranted).toBe(false);
    expect(plan.capabilitiesGranted).toBe(false);
  });

  it("keeps canonical and operation fingerprints stable", () => {
    const first = attachInvestigationSyncIntegrity(unsignedBatch());
    const second = attachInvestigationSyncIntegrity({
      ...unsignedBatch(),
      operations: [...unsignedBatch().operations].reverse(),
    });

    expect(second).toEqual(first);
    expect(canonicalizeInvestigationSyncBatch(first)).toEqual(first);
    expect(first.operations[1]?.previousOperationFingerprint).toBe(
      first.operations[0]?.operationFingerprint,
    );
  });

  it("reports an exact replay as an idempotent no-op", () => {
    const batch = attachInvestigationSyncIntegrity(unsignedBatch());
    const destination = emptyDestination();
    destination.checkpoint = { ...batch.toCursor };
    destination.objects = [
      {
        sourceInstallationId: "inst-syntheticnorth",
        kind: "evidence",
        objectId: "evidence-synthetic-timeout",
        revision: 2,
        objectHash: evidenceHash(payload2, 2),
        privacyClass: "owner_only",
        tombstoned: false,
      },
    ];
    destination.appliedOperations = batch.operations.map((row) => ({
      operationId: row.operationId,
      operationFingerprint: row.operationFingerprint,
      sourceInstallationId: row.sourceInstallationId,
      sourceSequence: row.sourceSequence,
    }));

    const plan = planInvestigationSync(batch, destination);
    expect(plan.outcome).toBe("replay");
    expect(plan.operations.map((row) => row.action)).toEqual(["replay", "replay"]);
    expect(plan.checkpointAfter).toEqual(destination.checkpoint);
  });

  it("supports a fail-closed tombstone with CAS", () => {
    const payload = '{"message":"Synthetic note"}';
    const unsigned: InvestigationSyncBatchUnsignedV1 = {
      sourceInstallationId: "inst-syntheticnorth",
      investigationId: "investigation-synthetic-001",
      fromCursor: {
        sourceInstallationId: "inst-syntheticnorth",
        throughSequence: 2,
        lastOperationId: "syncop-synthetic000002",
        lastOperationFingerprint: "1".repeat(64),
      },
      operations: [
        {
          operationId: "syncop-synthetic000003",
          sourceInstallationId: "inst-syntheticnorth",
          sourceSequence: 3,
          emittedAt: "2026-08-24T12:02:00.000Z",
          investigationId: "investigation-synthetic-001",
          actor: {
            sourceActorId: "actor-synthetic-operator",
            displayName: "Synthetic Operator",
            kind: "human",
          },
          mutation: "tombstone",
          object: {
            kind: "contribution",
            objectId: "contribution-synthetic-note",
            baseRevision: 1,
            resultRevision: 2,
            baseHash: investigationSyncObjectHash({
              sourceInstallationId: "inst-syntheticnorth",
              investigationId: "investigation-synthetic-001",
              kind: "contribution",
              objectId: "contribution-synthetic-note",
              revision: 1,
              privacyClass: "share_safe",
              tombstoned: false,
              payloadJson: payload,
              tombstoneReason: null,
            }),
            resultHash: investigationSyncObjectHash({
              sourceInstallationId: "inst-syntheticnorth",
              investigationId: "investigation-synthetic-001",
              kind: "contribution",
              objectId: "contribution-synthetic-note",
              revision: 2,
              privacyClass: "share_safe",
              tombstoned: true,
              payloadJson: null,
              tombstoneReason: "Synthetic duplicate removed",
            }),
            privacyClass: "share_safe",
          },
          payloadJson: null,
          tombstoneReason: "Synthetic duplicate removed",
        },
      ],
    };
    const batch = attachInvestigationSyncIntegrity(unsigned);
    const destination = emptyDestination();
    destination.checkpoint = { ...unsigned.fromCursor };
    destination.appliedOperations = [
      {
        operationId: "syncop-synthetic000002",
        operationFingerprint: "1".repeat(64),
        sourceInstallationId: "inst-syntheticnorth",
        sourceSequence: 2,
      },
    ];
    destination.objects = [
      {
        sourceInstallationId: "inst-syntheticnorth",
        kind: "contribution",
        objectId: "contribution-synthetic-note",
        revision: 1,
        objectHash: investigationSyncObjectHash({
          sourceInstallationId: "inst-syntheticnorth",
          investigationId: "investigation-synthetic-001",
          kind: "contribution",
          objectId: "contribution-synthetic-note",
          revision: 1,
          privacyClass: "share_safe",
          tombstoned: false,
          payloadJson: payload,
          tombstoneReason: null,
        }),
        privacyClass: "share_safe",
        tombstoned: false,
      },
    ];

    expect(planInvestigationSync(batch, destination).outcome).toBe("apply");
  });
});
