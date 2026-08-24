import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import * as contractBarrel from "./index.js";
import { AGREEMENT_NOT_CORRECTNESS } from "./experiment.js";
import {
  BUILTIN_EXTERNAL_IMPORT_CONNECTOR,
  BUILTIN_GATEWAY_COMPARE_CONNECTOR,
  BUILTIN_MANUAL_NOTES_CONNECTOR,
  BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
  CONTEXTDESK_STRATEGY_CONNECTORS,
  CONSENSUS_IS_NOT_TRUTH,
  IMPORTED_OUTPUT_IS_NOT_A_HUMAN_FINDING,
  NO_WINNER_SELECTED,
  STRATEGY_CONNECTOR_SCHEMA_ID,
  STRATEGY_PLAN_SCHEMA_ID,
  STRATEGY_RUN_REQUEST_SCHEMA_ID,
  STRATEGY_RUN_RESULT_SCHEMA_ID,
  appendStrategyRunAttempt,
  emptyStrategyRunHistory,
  parseStrategyComparisonProjection,
  parseStrategyConnector,
  parseStrategyHostCatalog,
  parseStrategyPlan,
  parseStrategyRunHistory,
  parseStrategyRunRequest,
  planInvestigationStrategyRun,
  projectInvestigationStrategyComparison,
  strategyRunRequestFingerprint,
  type StrategyHostCatalogV1,
  type StrategyRunRequestV1,
  type StrategyRunResultV1,
} from "./investigation-strategy-connector.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = "11".repeat(32);

function hostCatalog(overlay: Partial<StrategyHostCatalogV1> = {}): StrategyHostCatalogV1 {
  return {
    schemaId: "cd-collab.investigation_strategy_host_catalog.v1",
    availableCapabilities: [
      "snapshot_store",
      "evidence_inventory",
      "synthetic_executor",
      "gateway_bridge",
      "profile_catalog",
      "trace_store",
    ],
    unknownCapabilities: [],
    deniedCapabilities: [],
    evidenceIds: ["ev-synth-worker", "ev-synth-queue"],
    snapshots: [
      {
        id: "snap-synth-root",
        fingerprint: SNAPSHOT,
        parentSnapshotId: null,
        lineageClass: "root",
        evidenceIds: ["ev-synth-worker", "ev-synth-queue"],
      },
    ],
    job: {
      jobId: "job-synth-1",
      strategyId: "strategy.synthetic-next-inspect",
      question: "Which synthetic signal precedes the stall?",
    },
    ...overlay,
  };
}

function unsignedRequest(
  overlay: Partial<StrategyRunRequestV1> = {},
): Omit<StrategyRunRequestV1, "requestFingerprint"> {
  return {
    schemaId: STRATEGY_RUN_REQUEST_SCHEMA_ID,
    investigationId: "inv-synth-queue",
    jobId: "job-synth-1",
    strategyId: "strategy.synthetic-next-inspect",
    question: "Which synthetic signal precedes the stall?",
    snapshotId: "snap-synth-root",
    snapshotFingerprint: SNAPSHOT,
    snapshotLineageClass: "root",
    parentSnapshotId: null,
    evidenceIds: ["ev-synth-queue", "ev-synth-worker"],
    connectorId: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR.connectorId,
    connectorVersion: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR.version,
    profileId: null,
    modelId: null,
    privacyClass: "owner_only",
    operatorConsent: { snapshotBoundRun: true, providerEgress: false },
    ...overlay,
  };
}

function request(overlay: Partial<StrategyRunRequestV1> = {}): StrategyRunRequestV1 {
  const unsigned = unsignedRequest(overlay);
  return {
    ...unsigned,
    requestFingerprint: strategyRunRequestFingerprint(unsigned),
  };
}

function result(overlay: Partial<StrategyRunResultV1> = {}): StrategyRunResultV1 {
  const req = request();
  return {
    schemaId: STRATEGY_RUN_RESULT_SCHEMA_ID,
    attemptId: "attempt-synth-1",
    revision: 1,
    requestFingerprint: req.requestFingerprint,
    investigationId: req.investigationId,
    jobId: req.jobId,
    strategyId: req.strategyId,
    snapshotFingerprint: req.snapshotFingerprint,
    connectorId: req.connectorId,
    connectorVersion: req.connectorVersion,
    status: "completed",
    claims: [
      {
        claimId: "claim-synth-depth",
        text: "Synthetic queue depth rose before workers stalled.",
        evidenceRefs: ["ev-synth-queue"],
        status: "supported",
      },
    ],
    unknowns: ["provider usage"],
    evidenceRefs: ["ev-synth-queue", "ev-synth-worker"],
    traceRef: null,
    usage: { status: "unknown" },
    cost: { status: "unknown" },
    provenanceKind: "host_run",
    humanFinding: false,
    originalExternalProvenance: null,
    ...overlay,
  };
}

describe("investigation strategy connector contract", () => {
  it("is exported from the public package barrel", () => {
    expect(contractBarrel.STRATEGY_CONNECTOR_SCHEMA_ID).toBe(STRATEGY_CONNECTOR_SCHEMA_ID);
    expect(contractBarrel.parseStrategyConnector).toBe(parseStrategyConnector);
    expect(contractBarrel.planInvestigationStrategyRun).toBe(planInvestigationStrategyRun);
    expect(contractBarrel.projectInvestigationStrategyComparison).toBe(
      projectInvestigationStrategyComparison,
    );
  });

  it("parses the built-in ContextDesk connectors without provider configuration", () => {
    for (const connector of CONTEXTDESK_STRATEGY_CONNECTORS) {
      expect(parseStrategyConnector(structuredClone(connector)).connectorId).toBe(connector.connectorId);
    }
    expect(JSON.stringify(CONTEXTDESK_STRATEGY_CONNECTORS)).not.toMatch(/endpoint|api[_-]?key|secret/i);
  });

  it("fingerprints equivalent inputs identically and ignores job/attempt identity", () => {
    const first = request();
    const second = request({ jobId: "job-synth-other" });
    expect(first.requestFingerprint).toBe(second.requestFingerprint);
    expect(parseStrategyRunRequest(first).requestFingerprint).toBe(first.requestFingerprint);
    const mutated = structuredClone(first);
    mutated.question = "A different synthetic question.";
    expect(strategyRunRequestFingerprint(mutated)).not.toBe(first.requestFingerprint);
  });

  it("does not mutate caller-owned request objects", () => {
    const raw = request();
    const evidence = raw.evidenceIds;
    parseStrategyRunRequest(raw);
    expect(raw.evidenceIds).toBe(evidence);
    expect(raw.evidenceIds).toEqual(["ev-synth-queue", "ev-synth-worker"]);
  });

  it("plans a host-run synthetic connector as executable without contacting a provider", () => {
    const plan = planInvestigationStrategyRun({
      connector: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
      request: request(),
      host: hostCatalog(),
    });
    expect(plan.status).toBe("can_execute");
    expect(plan.contactedProvider).toBe(false);
    expect(plan.schemaId).toBe(STRATEGY_PLAN_SCHEMA_ID);
    expect(parseStrategyPlan(plan).reasons).toEqual([]);
  });

  it("plans gateway, import, and manual connectors onto the same frozen snapshot", () => {
    const gateway = planInvestigationStrategyRun({
      connector: BUILTIN_GATEWAY_COMPARE_CONNECTOR,
      request: request({
        connectorId: BUILTIN_GATEWAY_COMPARE_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_GATEWAY_COMPARE_CONNECTOR.version,
        profileId: "profile-synth-qwen",
        operatorConsent: { snapshotBoundRun: true, providerEgress: true },
      }),
      host: hostCatalog(),
    });
    expect(gateway.status).toBe("can_execute");

    const imported = planInvestigationStrategyRun({
      connector: BUILTIN_EXTERNAL_IMPORT_CONNECTOR,
      request: request({
        connectorId: BUILTIN_EXTERNAL_IMPORT_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_EXTERNAL_IMPORT_CONNECTOR.version,
      }),
      host: hostCatalog(),
    });
    expect(imported.status).toBe("must_import");

    const manual = planInvestigationStrategyRun({
      connector: BUILTIN_MANUAL_NOTES_CONNECTOR,
      request: request({
        connectorId: BUILTIN_MANUAL_NOTES_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_MANUAL_NOTES_CONNECTOR.version,
      }),
      host: hostCatalog(),
    });
    expect(manual.status).toBe("must_import");
  });

  it("appends reruns instead of overwriting and keeps the request fingerprint", () => {
    const first = result();
    const history = appendStrategyRunAttempt(emptyStrategyRunHistory(first.requestFingerprint), first);
    const second = result({
      attemptId: "attempt-synth-2",
      revision: 2,
      status: "partial",
      claims: [
        {
          claimId: "claim-synth-later",
          text: "A later synthetic attempt still cites the frozen queue warning.",
          evidenceRefs: ["ev-synth-worker"],
          status: "supported",
        },
      ],
    });
    const appended = appendStrategyRunAttempt(history, second);
    expect(appended.attempts).toHaveLength(2);
    expect(appended.attempts[0]?.attemptId).toBe("attempt-synth-1");
    expect(parseStrategyRunHistory(appended).attempts[1]?.revision).toBe(2);
  });

  it("projects a deterministic comparison without selecting a winner", () => {
    const first = result();
    const second = result({
      attemptId: "attempt-synth-2",
      revision: 2,
      evidenceRefs: ["ev-synth-queue"],
      claims: [
        {
          claimId: "claim-synth-depth-b",
          text: "Synthetic queue depth rose before workers stalled.",
          evidenceRefs: ["ev-synth-queue"],
          status: "supported",
        },
      ],
    });
    const comparison = projectInvestigationStrategyComparison([second, first]);
    expect(comparison.attempts.map((row) => row.attemptId)).toEqual([
      "attempt-synth-1",
      "attempt-synth-2",
    ]);
    expect(comparison.sharedEvidence).toEqual(["ev-synth-queue"]);
    expect(comparison.winnerSelected).toBe(false);
    expect(comparison.consensusAsTruth).toBe(false);
    expect(comparison.notes).toEqual(
      expect.arrayContaining([
        AGREEMENT_NOT_CORRECTNESS,
        CONSENSUS_IS_NOT_TRUTH,
        NO_WINNER_SELECTED,
        IMPORTED_OUTPUT_IS_NOT_A_HUMAN_FINDING,
      ]),
    );
    expect(parseStrategyComparisonProjection(comparison).claimAgreement).toHaveLength(1);
  });

  it("round-trips the connector schema with Ajv", () => {
    const schema = JSON.parse(
      readFileSync(join(here, "..", "schemas", "investigation-strategy-connector.v1.json"), "utf8"),
    ) as object;
    const ajv = new (Ajv2020 as new (opts: object) => { compile: (schema: object) => (data: unknown) => boolean })({
      strict: true,
      allErrors: true,
    });
    (addFormats as (ajv: unknown) => void)(ajv);
    const validate = ajv.compile(schema);
    expect(validate(BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR)).toBe(true);
    expect(validate({ ...BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR, extra: true })).toBe(false);
  });

  it("parses a host catalog without treating it as authorization", () => {
    const catalog = parseStrategyHostCatalog(hostCatalog());
    expect(catalog.snapshots[0]?.fingerprint).toBe(SNAPSHOT);
    expect(() => parseStrategyHostCatalog({ ...hostCatalog(), extra: true })).toThrow(/unknown key/);
  });
});
