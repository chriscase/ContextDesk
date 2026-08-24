import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  BUILTIN_EXTERNAL_IMPORT_CONNECTOR,
  BUILTIN_GATEWAY_COMPARE_CONNECTOR,
  BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
  appendStrategyRunAttempt,
  emptyStrategyRunHistory,
  parseStrategyConnector,
  parseStrategyRunRequest,
  parseStrategyRunResult,
  planInvestigationStrategyRun,
  projectInvestigationStrategyComparison,
  strategyRunRequestFingerprint,
  type StrategyHostCatalogV1,
  type StrategyRunRequestV1,
  type StrategyRunResultV1,
} from "./investigation-strategy-connector.js";

const SNAPSHOT = "11".repeat(32);
const OTHER_SNAPSHOT = "22".repeat(32);

function host(overlay: Partial<StrategyHostCatalogV1> = {}): StrategyHostCatalogV1 {
  return {
    schemaId: "cd-collab.investigation_strategy_host_catalog.v1",
    availableCapabilities: ["snapshot_store", "evidence_inventory", "synthetic_executor"],
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

function unsigned(overlay: Partial<StrategyRunRequestV1> = {}): Omit<StrategyRunRequestV1, "requestFingerprint"> {
  return {
    schemaId: "cd-collab.investigation_strategy_run_request.v1",
    investigationId: "inv-synth-queue",
    jobId: "job-synth-1",
    strategyId: "strategy.synthetic-next-inspect",
    question: "Which synthetic signal precedes the stall?",
    snapshotId: "snap-synth-root",
    snapshotFingerprint: SNAPSHOT,
    snapshotLineageClass: "root",
    parentSnapshotId: null,
    evidenceIds: ["ev-synth-worker", "ev-synth-queue"],
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
  const body = unsigned(overlay);
  return { ...body, requestFingerprint: strategyRunRequestFingerprint(body) };
}

function result(overlay: Partial<StrategyRunResultV1> = {}): StrategyRunResultV1 {
  const req = request();
  return {
    schemaId: "cd-collab.investigation_strategy_run_result.v1",
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
    unknowns: [],
    evidenceRefs: ["ev-synth-queue"],
    traceRef: null,
    usage: { status: "unknown" },
    cost: { status: "unknown" },
    provenanceKind: "host_run",
    humanFinding: false,
    originalExternalProvenance: null,
    ...overlay,
  };
}

describe("investigation strategy connector adversarial", () => {
  it("rejects unknown fields and credential-shaped keys", () => {
    expect(() => parseStrategyConnector({ ...BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR, extra: true })).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseStrategyConnector({ ...BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR, endpoint: "https://provider.example" }),
    ).toThrow();
    expect(() => parseStrategyRunRequest({ ...request(), api_key: "secret" })).toThrow();
  });

  it("blocks dangling evidence and mismatched snapshots before any execution", () => {
    const dangling = planInvestigationStrategyRun({
      connector: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
      request: request({ evidenceIds: ["ev-synth-missing"] }),
      host: host(),
    });
    expect(dangling.status).toBe("blocked");
    expect(dangling.reasons.some((row) => row.code === "dangling_evidence")).toBe(true);
    expect(dangling.contactedProvider).toBe(false);

    const mismatched = planInvestigationStrategyRun({
      connector: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
      request: request({ snapshotFingerprint: OTHER_SNAPSHOT }),
      host: host(),
    });
    expect(mismatched.status).toBe("blocked");
    expect(mismatched.reasons.some((row) => row.code === "mismatched_snapshot")).toBe(true);
  });

  it("fails closed on connector-version drift", () => {
    const plan = planInvestigationStrategyRun({
      connector: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
      request: request({ connectorVersion: "1.0.1" }),
      host: host(),
    });
    expect(plan.status).toBe("blocked");
    expect(plan.reasons.some((row) => row.code === "connector_version_drift")).toBe(true);
  });

  it("reports unknown capability without contacting a provider", () => {
    const plan = planInvestigationStrategyRun({
      connector: BUILTIN_GATEWAY_COMPARE_CONNECTOR,
      request: request({
        connectorId: BUILTIN_GATEWAY_COMPARE_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_GATEWAY_COMPARE_CONNECTOR.version,
        profileId: "profile-synth-qwen",
        operatorConsent: { snapshotBoundRun: true, providerEgress: true },
      }),
      host: host({
        availableCapabilities: ["snapshot_store", "evidence_inventory"],
        unknownCapabilities: ["gateway_bridge"],
      }),
    });
    expect(plan.status).toBe("unknown_capability");
    expect(plan.contactedProvider).toBe(false);
    expect(plan.reasons.some((row) => row.code === "unknown_capability")).toBe(true);
  });

  it("refuses declared-provider egress without consent and for share_safe requests", () => {
    const noConsent = planInvestigationStrategyRun({
      connector: BUILTIN_GATEWAY_COMPARE_CONNECTOR,
      request: request({
        connectorId: BUILTIN_GATEWAY_COMPARE_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_GATEWAY_COMPARE_CONNECTOR.version,
        profileId: "profile-synth-qwen",
        operatorConsent: { snapshotBoundRun: true, providerEgress: false },
      }),
      host: host({
        availableCapabilities: [
          "snapshot_store",
          "evidence_inventory",
          "gateway_bridge",
          "profile_catalog",
        ],
      }),
    });
    expect(noConsent.status).toBe("blocked");
    expect(noConsent.reasons.some((row) => row.code === "privacy_egress_refusal")).toBe(true);

    const shareSafe = planInvestigationStrategyRun({
      connector: BUILTIN_GATEWAY_COMPARE_CONNECTOR,
      request: request({
        connectorId: BUILTIN_GATEWAY_COMPARE_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_GATEWAY_COMPARE_CONNECTOR.version,
        profileId: "profile-synth-qwen",
        privacyClass: "share_safe",
        operatorConsent: { snapshotBoundRun: true, providerEgress: true },
      }),
      host: host({
        availableCapabilities: [
          "snapshot_store",
          "evidence_inventory",
          "gateway_bridge",
          "profile_catalog",
        ],
      }),
    });
    expect(shareSafe.status).toBe("blocked");
    expect(shareSafe.reasons.some((row) => row.code === "privacy_egress_refusal")).toBe(true);
  });

  it("rejects duplicate attempts and revision overwrite", () => {
    const first = result();
    const history = appendStrategyRunAttempt(emptyStrategyRunHistory(first.requestFingerprint), first);
    expect(() => appendStrategyRunAttempt(history, first)).toThrow(/duplicate attempt/);
    expect(() =>
      appendStrategyRunAttempt(history, result({ attemptId: "attempt-synth-2", revision: 1 })),
    ).toThrow(/append the next revision|never overwrite|contiguous/);
  });

  it("accepts partial output and rejects supported claims that omit citations", () => {
    const partial = parseStrategyRunResult(
      result({
        status: "partial",
        unknowns: ["later synthetic evidence"],
      }),
      BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
    );
    expect(partial.status).toBe("partial");
    expect(() =>
      parseStrategyRunResult(
        result({
          claims: [
            {
              claimId: "claim-uncited",
              text: "An unsupported synthetic assertion.",
              evidenceRefs: [],
              status: "supported",
            },
          ],
        }),
        BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
      ),
    ).toThrow(/evidence citations/);
  });

  it("blocks a conflicting job strategy and question", () => {
    const plan = planInvestigationStrategyRun({
      connector: BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
      request: request({ strategyId: "strategy.other-synth" }),
      host: host(),
    });
    expect(plan.status).toBe("blocked");
    expect(plan.reasons.some((row) => row.code === "conflicting_job_strategy")).toBe(true);
  });

  it("preserves imported provenance and never promotes imported output to a human finding", () => {
    const imported = parseStrategyRunResult(
      result({
        connectorId: BUILTIN_EXTERNAL_IMPORT_CONNECTOR.connectorId,
        connectorVersion: BUILTIN_EXTERNAL_IMPORT_CONNECTOR.version,
        provenanceKind: "external_import",
        originalExternalProvenance: "pasted-synthetic-chat-2042-03-04",
        requestFingerprint: strategyRunRequestFingerprint(
          unsigned({
            connectorId: BUILTIN_EXTERNAL_IMPORT_CONNECTOR.connectorId,
            connectorVersion: BUILTIN_EXTERNAL_IMPORT_CONNECTOR.version,
          }),
        ),
      }),
      BUILTIN_EXTERNAL_IMPORT_CONNECTOR,
    );
    expect(imported.humanFinding).toBe(false);
    expect(imported.originalExternalProvenance).toBe("pasted-synthetic-chat-2042-03-04");
    expect(() =>
      parseStrategyRunResult({ ...imported, humanFinding: true }, BUILTIN_EXTERNAL_IMPORT_CONNECTOR),
    ).toThrow(/human finding/);
    expect(() =>
      parseStrategyRunResult(
        { ...imported, originalExternalProvenance: null },
        BUILTIN_EXTERNAL_IMPORT_CONNECTOR,
      ),
    ).toThrow(/original external provenance/);
  });

  it("refuses comparison across snapshots or strategies and does not invent a winner", () => {
    const first = result();
    expect(() =>
      projectInvestigationStrategyComparison([
        first,
        result({ attemptId: "attempt-b", revision: 2, snapshotFingerprint: OTHER_SNAPSHOT }),
      ]),
    ).toThrow(/mismatched snapshots/);
    expect(() =>
      projectInvestigationStrategyComparison([
        first,
        result({ attemptId: "attempt-b", revision: 2, strategyId: "strategy.other-synth" }),
      ]),
    ).toThrow(/conflicting job strategies/);
    expect(() => projectInvestigationStrategyComparison([first])).toThrow(/at least two attempts/);
  });

  it("rejects a planted fingerprint and missing frozen-snapshot consent", () => {
    const raw = request();
    expect(() => parseStrategyRunRequest({ ...raw, requestFingerprint: "00".repeat(32) })).toThrow(
      /request fingerprint mismatch/,
    );
    expect(() =>
      parseStrategyRunRequest({
        ...request(),
        operatorConsent: { snapshotBoundRun: false, providerEgress: false },
      }),
    ).toThrow(ContractViolation);
  });
});
