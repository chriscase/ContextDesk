/**
 * Provider-neutral composable investigation strategy connector contract.
 * Pure JSON functions: no provider I/O, no credentials, no UI, no persistence.
 */
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { AGREEMENT_NOT_CORRECTNESS, SNAPSHOT_LINEAGE_CLASSES, type SnapshotLineageClass } from "./experiment.js";
import {
  assertNoCredentialLeakage,
  canonicalJson,
  sha256Text,
} from "./investigation-portable.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { TEXTUAL_SIMILARITY_NOT_WINNER } from "./trace.js";

export const STRATEGY_CONNECTOR_SCHEMA_ID =
  "cd-collab.investigation_strategy_connector.v1" as const;
export const STRATEGY_RUN_REQUEST_SCHEMA_ID =
  "cd-collab.investigation_strategy_run_request.v1" as const;
export const STRATEGY_RUN_RESULT_SCHEMA_ID =
  "cd-collab.investigation_strategy_run_result.v1" as const;
export const STRATEGY_RUN_HISTORY_SCHEMA_ID =
  "cd-collab.investigation_strategy_run_history.v1" as const;
export const STRATEGY_PLAN_SCHEMA_ID =
  "cd-collab.investigation_strategy_plan.v1" as const;
export const STRATEGY_COMPARISON_PROJECTION_SCHEMA_ID =
  "cd-collab.investigation_strategy_comparison.v1" as const;
export const STRATEGY_HOST_CATALOG_SCHEMA_ID =
  "cd-collab.investigation_strategy_host_catalog.v1" as const;

export const STRATEGY_EXECUTION_MODES = ["host_run", "external_import", "manual"] as const;
export type StrategyExecutionMode = (typeof STRATEGY_EXECUTION_MODES)[number];

export const STRATEGY_INPUT_KINDS = [
  "frozen_snapshot",
  "selected_evidence",
  "operator_question",
  "imported_run",
] as const;
export type StrategyInputKind = (typeof STRATEGY_INPUT_KINDS)[number];

export const STRATEGY_HOST_CAPABILITIES = [
  "snapshot_store",
  "evidence_inventory",
  "synthetic_executor",
  "gateway_bridge",
  "profile_catalog",
  "trace_store",
] as const;
export type StrategyHostCapability = (typeof STRATEGY_HOST_CAPABILITIES)[number];

export const STRATEGY_EGRESS = ["none", "host_local", "declared_provider"] as const;
export type StrategyEgress = (typeof STRATEGY_EGRESS)[number];

export const STRATEGY_TRACE_SUPPORT = ["none", "optional", "required"] as const;
export type StrategyTraceSupport = (typeof STRATEGY_TRACE_SUPPORT)[number];

export const STRATEGY_METRIC_SUPPORT = ["unknown_only", "observed"] as const;
export type StrategyMetricSupport = (typeof STRATEGY_METRIC_SUPPORT)[number];

export const STRATEGY_CANCELLATION = ["none", "cooperative", "immediate"] as const;
export type StrategyCancellation = (typeof STRATEGY_CANCELLATION)[number];

export const STRATEGY_PLAN_STATUSES = [
  "can_execute",
  "must_import",
  "blocked",
  "unknown_capability",
] as const;
export type StrategyPlanStatus = (typeof STRATEGY_PLAN_STATUSES)[number];

export const STRATEGY_RUN_STATUSES = ["completed", "partial", "failed", "cancelled"] as const;
export type StrategyRunStatus = (typeof STRATEGY_RUN_STATUSES)[number];

export const STRATEGY_CLAIM_STATUSES = ["supported", "unsupported", "unknown"] as const;
export type StrategyClaimStatus = (typeof STRATEGY_CLAIM_STATUSES)[number];

export const STRATEGY_METRIC_STATUSES = ["unknown", "known"] as const;
export type StrategyMetricStatus = (typeof STRATEGY_METRIC_STATUSES)[number];

export const STRATEGY_PROVENANCE_KINDS = ["host_run", "external_import", "manual"] as const;
export type StrategyProvenanceKind = (typeof STRATEGY_PROVENANCE_KINDS)[number];

export const CONSENSUS_IS_NOT_TRUTH = "Consensus is not truth." as const;
export const NO_WINNER_SELECTED = "No winner is selected." as const;
export const IMPORTED_OUTPUT_IS_NOT_A_HUMAN_FINDING =
  "Imported or generated connector output is not a human finding." as const;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONNECTOR_ID_RE = /^[a-z][a-z0-9._-]{1,63}$/;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const HOST_CAP_RE = /^[a-z][a-z0-9_]{1,63}$/;
const OUTPUT_SCHEMA_RE = /^cd-collab\.[a-z0-9._-]+\.v[0-9]+$/;

export interface StrategyConnectorV1 {
  schemaId: typeof STRATEGY_CONNECTOR_SCHEMA_ID;
  connectorId: string;
  version: string;
  displayName: string;
  executionMode: StrategyExecutionMode;
  supportedInputKinds: StrategyInputKind[];
  requiredHostCapabilities: string[];
  egress: StrategyEgress;
  privacyClass: PrivacyClass;
  outputSchemaId: string;
  traceSupport: StrategyTraceSupport;
  costSupport: StrategyMetricSupport;
  usageSupport: StrategyMetricSupport;
  cancellation: StrategyCancellation;
}

export interface StrategyOperatorConsentV1 {
  snapshotBoundRun: true;
  providerEgress: boolean;
}

export interface StrategyRunRequestV1 {
  schemaId: typeof STRATEGY_RUN_REQUEST_SCHEMA_ID;
  investigationId: string;
  jobId: string;
  strategyId: string;
  question: string;
  snapshotId: string;
  snapshotFingerprint: string;
  snapshotLineageClass: SnapshotLineageClass;
  parentSnapshotId: string | null;
  evidenceIds: string[];
  connectorId: string;
  connectorVersion: string;
  profileId: string | null;
  modelId: string | null;
  privacyClass: PrivacyClass;
  operatorConsent: StrategyOperatorConsentV1;
  requestFingerprint: string;
}

export interface StrategyClaimV1 {
  claimId: string;
  text: string;
  evidenceRefs: string[];
  status: StrategyClaimStatus;
}

export interface StrategyMetricV1 {
  status: StrategyMetricStatus;
  tokens?: number;
  amountMilli?: number;
}

export interface StrategyRunResultV1 {
  schemaId: typeof STRATEGY_RUN_RESULT_SCHEMA_ID;
  attemptId: string;
  revision: number;
  requestFingerprint: string;
  investigationId: string;
  jobId: string;
  strategyId: string;
  snapshotFingerprint: string;
  connectorId: string;
  connectorVersion: string;
  status: StrategyRunStatus;
  claims: StrategyClaimV1[];
  unknowns: string[];
  evidenceRefs: string[];
  traceRef: string | null;
  usage: StrategyMetricV1;
  cost: StrategyMetricV1;
  provenanceKind: StrategyProvenanceKind;
  humanFinding: false;
  originalExternalProvenance: string | null;
}

export interface StrategyRunHistoryV1 {
  schemaId: typeof STRATEGY_RUN_HISTORY_SCHEMA_ID;
  requestFingerprint: string;
  attempts: StrategyRunResultV1[];
}

export interface StrategyPlanReasonV1 {
  code: string;
  path: string;
  detail: string;
}

export interface StrategyPlanV1 {
  schemaId: typeof STRATEGY_PLAN_SCHEMA_ID;
  status: StrategyPlanStatus;
  connectorId: string;
  connectorVersion: string;
  requestFingerprint: string;
  executionMode: StrategyExecutionMode;
  contactedProvider: false;
  reasons: StrategyPlanReasonV1[];
}

export interface StrategyHostSnapshotV1 {
  id: string;
  fingerprint: string;
  parentSnapshotId: string | null;
  lineageClass: SnapshotLineageClass;
  evidenceIds: string[];
}

export interface StrategyHostCatalogV1 {
  schemaId: typeof STRATEGY_HOST_CATALOG_SCHEMA_ID;
  availableCapabilities: string[];
  unknownCapabilities: string[];
  deniedCapabilities: string[];
  evidenceIds: string[];
  snapshots: StrategyHostSnapshotV1[];
  job: { jobId: string; strategyId: string; question: string } | null;
}

export interface StrategyComparisonProjectionV1 {
  schemaId: typeof STRATEGY_COMPARISON_PROJECTION_SCHEMA_ID;
  snapshotFingerprint: string;
  strategyId: string;
  attempts: Array<{
    attemptId: string;
    revision: number;
    connectorId: string;
    requestFingerprint: string;
    status: StrategyRunStatus;
  }>;
  sharedEvidence: string[];
  uniqueEvidence: Array<{ attemptId: string; evidenceRefs: string[] }>;
  claimAgreement: Array<{ textHash: string; attemptIds: string[] }>;
  unknowns: string[];
  notes: string[];
  winnerSelected: false;
  consensusAsTruth: false;
}

const connectorShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_CONNECTOR_SCHEMA_ID)),
  connectorId: f.req(f.nstr),
  version: f.req(f.nstr),
  displayName: f.req(f.nstr),
  executionMode: f.req(f.en(...STRATEGY_EXECUTION_MODES)),
  supportedInputKinds: f.req(f.arr(f.en(...STRATEGY_INPUT_KINDS))),
  requiredHostCapabilities: f.req(f.arr(f.nstr)),
  egress: f.req(f.en(...STRATEGY_EGRESS)),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  outputSchemaId: f.req(f.nstr),
  traceSupport: f.req(f.en(...STRATEGY_TRACE_SUPPORT)),
  costSupport: f.req(f.en(...STRATEGY_METRIC_SUPPORT)),
  usageSupport: f.req(f.en(...STRATEGY_METRIC_SUPPORT)),
  cancellation: f.req(f.en(...STRATEGY_CANCELLATION)),
};

const requestShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_RUN_REQUEST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  jobId: f.req(f.nstr),
  strategyId: f.req(f.nstr),
  question: f.req(f.nstr),
  snapshotId: f.req(f.nstr),
  snapshotFingerprint: f.req(f.nstr),
  snapshotLineageClass: f.req(f.en(...SNAPSHOT_LINEAGE_CLASSES)),
  parentSnapshotId: f.nul(f.nstr),
  evidenceIds: f.req(f.arr(f.nstr)),
  connectorId: f.req(f.nstr),
  connectorVersion: f.req(f.nstr),
  profileId: f.nul(f.nstr),
  modelId: f.nul(f.nstr),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  operatorConsent: f.req(
    f.obj({
      snapshotBoundRun: f.req(f.bool),
      providerEgress: f.req(f.bool),
    }),
  ),
  requestFingerprint: f.req(f.nstr),
};

const claimShape: ObjectShape = {
  claimId: f.req(f.nstr),
  text: f.req(f.nstr),
  evidenceRefs: f.req(f.arr(f.nstr)),
  status: f.req(f.en(...STRATEGY_CLAIM_STATUSES)),
};

const metricShape: ObjectShape = {
  status: f.req(f.en(...STRATEGY_METRIC_STATUSES)),
  tokens: f.opt(f.u64),
  amountMilli: f.opt(f.u64),
};

const resultShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_RUN_RESULT_SCHEMA_ID)),
  attemptId: f.req(f.nstr),
  revision: f.req(f.u64),
  requestFingerprint: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  jobId: f.req(f.nstr),
  strategyId: f.req(f.nstr),
  snapshotFingerprint: f.req(f.nstr),
  connectorId: f.req(f.nstr),
  connectorVersion: f.req(f.nstr),
  status: f.req(f.en(...STRATEGY_RUN_STATUSES)),
  claims: f.req(f.arr(f.obj(claimShape))),
  unknowns: f.req(f.arr(f.str)),
  evidenceRefs: f.req(f.arr(f.nstr)),
  traceRef: f.nul(f.nstr),
  usage: f.req(f.obj(metricShape)),
  cost: f.req(f.obj(metricShape)),
  provenanceKind: f.req(f.en(...STRATEGY_PROVENANCE_KINDS)),
  humanFinding: f.req(f.bool),
  originalExternalProvenance: f.nul(f.nstr),
};

const historyShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_RUN_HISTORY_SCHEMA_ID)),
  requestFingerprint: f.req(f.nstr),
  attempts: f.req(f.arr(f.obj(resultShape))),
};

const hostSnapshotShape: ObjectShape = {
  id: f.req(f.nstr),
  fingerprint: f.req(f.nstr),
  parentSnapshotId: f.nul(f.nstr),
  lineageClass: f.req(f.en(...SNAPSHOT_LINEAGE_CLASSES)),
  evidenceIds: f.req(f.arr(f.nstr)),
};

const hostCatalogShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_HOST_CATALOG_SCHEMA_ID)),
  availableCapabilities: f.req(f.arr(f.nstr)),
  unknownCapabilities: f.req(f.arr(f.nstr)),
  deniedCapabilities: f.req(f.arr(f.nstr)),
  evidenceIds: f.req(f.arr(f.nstr)),
  snapshots: f.req(f.arr(f.obj(hostSnapshotShape))),
  job: f.nul(
    f.obj({
      jobId: f.req(f.nstr),
      strategyId: f.req(f.nstr),
      question: f.req(f.nstr),
    }),
  ),
};

const comparisonShape: ObjectShape = {
  schemaId: f.req(f.en(STRATEGY_COMPARISON_PROJECTION_SCHEMA_ID)),
  snapshotFingerprint: f.req(f.nstr),
  strategyId: f.req(f.nstr),
  attempts: f.req(
    f.arr(
      f.obj({
        attemptId: f.req(f.nstr),
        revision: f.req(f.u64),
        connectorId: f.req(f.nstr),
        requestFingerprint: f.req(f.nstr),
        status: f.req(f.en(...STRATEGY_RUN_STATUSES)),
      }),
    ),
  ),
  sharedEvidence: f.req(f.arr(f.nstr)),
  uniqueEvidence: f.req(
    f.arr(
      f.obj({
        attemptId: f.req(f.nstr),
        evidenceRefs: f.req(f.arr(f.nstr)),
      }),
    ),
  ),
  claimAgreement: f.req(
    f.arr(
      f.obj({
        textHash: f.req(f.nstr),
        attemptIds: f.req(f.arr(f.nstr)),
      }),
    ),
  ),
  unknowns: f.req(f.arr(f.str)),
  notes: f.req(f.arr(f.nstr)),
  winnerSelected: f.req(f.bool),
  consensusAsTruth: f.req(f.bool),
};

function uniqueSorted(path: string, values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const [i, value] of values.entries()) {
    if (seen.has(value)) {
      throw new ContractViolation(`${path}[${i}]`, "duplicate id");
    }
    seen.add(value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

function requireSha256(path: string, value: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new ContractViolation(path, "expected a lowercase SHA-256 hex digest");
  }
}

function requireConnectorId(path: string, value: string): void {
  if (!CONNECTOR_ID_RE.test(value)) {
    throw new ContractViolation(path, "expected a stable connector identity");
  }
}

function requireVersion(path: string, value: string): void {
  if (!VERSION_RE.test(value)) {
    throw new ContractViolation(path, "expected a dotted numeric version");
  }
}

function requireCapabilityName(path: string, value: string): void {
  if (!HOST_CAP_RE.test(value)) {
    throw new ContractViolation(path, "expected a host capability name");
  }
}

function parseMetric(
  path: string,
  raw: StrategyMetricV1,
  support: StrategyMetricSupport,
  kind: "usage" | "cost",
): StrategyMetricV1 {
  if (raw.status === "unknown") {
    if (raw.tokens !== undefined || raw.amountMilli !== undefined) {
      throw new ContractViolation(path, "unknown metrics must not carry a quantity");
    }
    return { status: "unknown" };
  }
  if (support === "unknown_only") {
    throw new ContractViolation(path, "connector does not support observed metrics");
  }
  if (kind === "usage") {
    if (raw.tokens === undefined) {
      throw new ContractViolation(path, "known usage requires a token quantity");
    }
    if (raw.amountMilli !== undefined) {
      throw new ContractViolation(path, "usage must not carry a cost quantity");
    }
    return { status: "known", tokens: raw.tokens };
  }
  if (raw.amountMilli === undefined) {
    throw new ContractViolation(path, "known cost requires an amount");
  }
  if (raw.tokens !== undefined) {
    throw new ContractViolation(path, "cost must not carry a usage quantity");
  }
  return { status: "known", amountMilli: raw.amountMilli };
}

export function strategyRunRequestFingerprint(
  request: Omit<StrategyRunRequestV1, "schemaId" | "requestFingerprint" | "jobId" | "operatorConsent">,
): string {
  return sha256Text(
    canonicalJson({
      investigationId: request.investigationId,
      strategyId: request.strategyId,
      question: request.question,
      snapshotFingerprint: request.snapshotFingerprint,
      snapshotLineageClass: request.snapshotLineageClass,
      parentSnapshotId: request.parentSnapshotId,
      evidenceIds: [...request.evidenceIds].sort((a, b) => a.localeCompare(b)),
      connectorId: request.connectorId,
      connectorVersion: request.connectorVersion,
      profileId: request.profileId,
      modelId: request.modelId,
    }),
  );
}

export function parseStrategyConnector(raw: unknown): StrategyConnectorV1 {
  checkObject("$", connectorShape, raw);
  assertNoCredentialLeakage(raw);
  const row = raw as StrategyConnectorV1;
  requireConnectorId("$.connectorId", row.connectorId);
  requireVersion("$.version", row.version);
  if (!OUTPUT_SCHEMA_RE.test(row.outputSchemaId)) {
    throw new ContractViolation("$.outputSchemaId", "expected a cd-collab schema id");
  }
  if (row.supportedInputKinds.length === 0) {
    throw new ContractViolation("$.supportedInputKinds", "at least one input kind is required");
  }
  uniqueSorted("$.supportedInputKinds", row.supportedInputKinds);
  uniqueSorted("$.requiredHostCapabilities", row.requiredHostCapabilities);
  for (const [i, cap] of row.requiredHostCapabilities.entries()) {
    requireCapabilityName(`$.requiredHostCapabilities[${i}]`, cap);
  }
  if (!row.supportedInputKinds.includes("frozen_snapshot")) {
    throw new ContractViolation("$.supportedInputKinds", "frozen_snapshot is required");
  }
  return row;
}

export function parseStrategyRunRequest(raw: unknown): StrategyRunRequestV1 {
  checkObject("$", requestShape, raw);
  assertNoCredentialLeakage(raw);
  const row = raw as StrategyRunRequestV1;
  requireConnectorId("$.connectorId", row.connectorId);
  requireVersion("$.connectorVersion", row.connectorVersion);
  requireSha256("$.snapshotFingerprint", row.snapshotFingerprint);
  requireSha256("$.requestFingerprint", row.requestFingerprint);
  if (row.operatorConsent.snapshotBoundRun !== true) {
    throw new ContractViolation("$.operatorConsent.snapshotBoundRun", "exact frozen snapshot consent is required");
  }
  if (row.snapshotLineageClass === "root" && row.parentSnapshotId !== null) {
    throw new ContractViolation("$.parentSnapshotId", "root snapshots have no parent");
  }
  if (row.snapshotLineageClass === "derived" && row.parentSnapshotId === null) {
    throw new ContractViolation("$.parentSnapshotId", "derived snapshots require a parent");
  }
  const evidenceIds = uniqueSorted("$.evidenceIds", row.evidenceIds);
  const expected = strategyRunRequestFingerprint({ ...row, evidenceIds });
  if (row.requestFingerprint !== expected) {
    throw new ContractViolation("$.requestFingerprint", "request fingerprint mismatch");
  }
  return { ...row, evidenceIds, operatorConsent: { snapshotBoundRun: true, providerEgress: row.operatorConsent.providerEgress } };
}

function parseResultAgainstSupport(
  raw: unknown,
  support?: Pick<StrategyConnectorV1, "traceSupport" | "costSupport" | "usageSupport" | "cancellation" | "executionMode">,
): StrategyRunResultV1 {
  checkObject("$", resultShape, raw);
  assertNoCredentialLeakage(raw);
  const row = raw as StrategyRunResultV1;
  requireSha256("$.requestFingerprint", row.requestFingerprint);
  requireSha256("$.snapshotFingerprint", row.snapshotFingerprint);
  requireConnectorId("$.connectorId", row.connectorId);
  requireVersion("$.connectorVersion", row.connectorVersion);
  if (row.revision < 1) {
    throw new ContractViolation("$.revision", "revision must start at 1");
  }
  if (row.humanFinding !== false) {
    throw new ContractViolation("$.humanFinding", IMPORTED_OUTPUT_IS_NOT_A_HUMAN_FINDING);
  }
  uniqueSorted("$.evidenceRefs", row.evidenceRefs);
  uniqueSorted(
    "$.claims",
    row.claims.map((claim) => claim.claimId),
  );
  for (const [i, claim] of row.claims.entries()) {
    uniqueSorted(`$.claims[${i}].evidenceRefs`, claim.evidenceRefs);
    if (claim.status === "supported" && claim.evidenceRefs.length === 0) {
      throw new ContractViolation(`$.claims[${i}].evidenceRefs`, "supported claims require evidence citations");
    }
    for (const [j, ref] of claim.evidenceRefs.entries()) {
      if (!row.evidenceRefs.includes(ref)) {
        throw new ContractViolation(`$.claims[${i}].evidenceRefs[${j}]`, "citation is not in the result evidence set");
      }
    }
  }
  if (support) {
    row.usage = parseMetric("$.usage", row.usage, support.usageSupport, "usage");
    row.cost = parseMetric("$.cost", row.cost, support.costSupport, "cost");
    if (support.traceSupport === "none" && row.traceRef !== null) {
      throw new ContractViolation("$.traceRef", "connector does not support traces");
    }
    if (support.traceSupport === "required" && row.traceRef === null) {
      throw new ContractViolation("$.traceRef", "connector requires a trace reference");
    }
    if (row.status === "cancelled" && support.cancellation === "none") {
      throw new ContractViolation("$.status", "connector does not support cancellation");
    }
    if (row.provenanceKind !== support.executionMode) {
      throw new ContractViolation("$.provenanceKind", "provenance must match connector execution mode");
    }
  } else {
    row.usage = parseMetric("$.usage", row.usage, "observed", "usage");
    row.cost = parseMetric("$.cost", row.cost, "observed", "cost");
  }
  if (
    (row.provenanceKind === "external_import" || row.provenanceKind === "manual") &&
    row.originalExternalProvenance === null
  ) {
    throw new ContractViolation(
      "$.originalExternalProvenance",
      "imported or manual results must retain original external provenance",
    );
  }
  return { ...row, humanFinding: false };
}

export function parseStrategyRunResult(raw: unknown, connector?: StrategyConnectorV1): StrategyRunResultV1 {
  return parseResultAgainstSupport(raw, connector);
}

export function parseStrategyRunHistory(raw: unknown, connector?: StrategyConnectorV1): StrategyRunHistoryV1 {
  checkObject("$", historyShape, raw);
  const row = raw as StrategyRunHistoryV1;
  requireSha256("$.requestFingerprint", row.requestFingerprint);
  if (row.attempts.length === 0) {
    throw new ContractViolation("$.attempts", "history is append-only and must contain at least one attempt");
  }
  const seenAttempts = new Set<string>();
  row.attempts.forEach((attempt, i) => {
    const parsed = parseResultAgainstSupport(attempt, connector);
    if (parsed.requestFingerprint !== row.requestFingerprint) {
      throw new ContractViolation(`$.attempts[${i}].requestFingerprint`, "attempt does not belong to this request");
    }
    if (parsed.revision !== i + 1) {
      throw new ContractViolation(`$.attempts[${i}].revision`, "revisions must be contiguous and append-only");
    }
    if (seenAttempts.has(parsed.attemptId)) {
      throw new ContractViolation(`$.attempts[${i}].attemptId`, "duplicate attempt");
    }
    seenAttempts.add(parsed.attemptId);
    row.attempts[i] = parsed;
  });
  return row;
}

export function parseStrategyHostCatalog(raw: unknown): StrategyHostCatalogV1 {
  checkObject("$", hostCatalogShape, raw);
  assertNoCredentialLeakage(raw);
  const row = raw as StrategyHostCatalogV1;
  uniqueSorted("$.availableCapabilities", row.availableCapabilities);
  uniqueSorted("$.unknownCapabilities", row.unknownCapabilities);
  uniqueSorted("$.deniedCapabilities", row.deniedCapabilities);
  uniqueSorted("$.evidenceIds", row.evidenceIds);
  const snapshotIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const [i, snapshot] of row.snapshots.entries()) {
    requireSha256(`$.snapshots[${i}].fingerprint`, snapshot.fingerprint);
    if (snapshotIds.has(snapshot.id) || fingerprints.has(snapshot.fingerprint)) {
      throw new ContractViolation(`$.snapshots[${i}]`, "duplicate snapshot identity");
    }
    snapshotIds.add(snapshot.id);
    fingerprints.add(snapshot.fingerprint);
    uniqueSorted(`$.snapshots[${i}].evidenceIds`, snapshot.evidenceIds);
  }
  return row;
}

export function parseStrategyPlan(raw: unknown): StrategyPlanV1 {
  checkObject(
    "$",
    {
      schemaId: f.req(f.en(STRATEGY_PLAN_SCHEMA_ID)),
      status: f.req(f.en(...STRATEGY_PLAN_STATUSES)),
      connectorId: f.req(f.nstr),
      connectorVersion: f.req(f.nstr),
      requestFingerprint: f.req(f.nstr),
      executionMode: f.req(f.en(...STRATEGY_EXECUTION_MODES)),
      contactedProvider: f.req(f.bool),
      reasons: f.req(
        f.arr(
          f.obj({
            code: f.req(f.nstr),
            path: f.req(f.nstr),
            detail: f.req(f.nstr),
          }),
        ),
      ),
    },
    raw,
  );
  const row = raw as StrategyPlanV1;
  if (row.contactedProvider !== false) {
    throw new ContractViolation("$.contactedProvider", "planner must not contact a provider");
  }
  return row;
}

export function parseStrategyComparisonProjection(raw: unknown): StrategyComparisonProjectionV1 {
  checkObject("$", comparisonShape, raw);
  const row = raw as StrategyComparisonProjectionV1;
  if (row.winnerSelected !== false) {
    throw new ContractViolation("$.winnerSelected", NO_WINNER_SELECTED);
  }
  if (row.consensusAsTruth !== false) {
    throw new ContractViolation("$.consensusAsTruth", CONSENSUS_IS_NOT_TRUTH);
  }
  if (!row.notes.includes(AGREEMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation("$.notes", "agreement-is-not-correctness note is required");
  }
  if (!row.notes.includes(NO_WINNER_SELECTED) || !row.notes.includes(CONSENSUS_IS_NOT_TRUTH)) {
    throw new ContractViolation("$.notes", "comparison must refuse winner and consensus-as-truth claims");
  }
  requireSha256("$.snapshotFingerprint", row.snapshotFingerprint);
  return row;
}

function reason(code: string, path: string, detail: string): StrategyPlanReasonV1 {
  return { code, path, detail };
}

export function planInvestigationStrategyRun(input: {
  connector: unknown;
  request: unknown;
  host: unknown;
}): StrategyPlanV1 {
  const connector = parseStrategyConnector(input.connector);
  const request = parseStrategyRunRequest(input.request);
  const host = parseStrategyHostCatalog(input.host);
  const reasons: StrategyPlanReasonV1[] = [];

  if (request.connectorId !== connector.connectorId || request.connectorVersion !== connector.version) {
    reasons.push(reason("connector_version_drift", "$.request.connectorVersion", "connector identity or version does not match"));
  }
  if (request.strategyId && host.job && host.job.strategyId !== request.strategyId) {
    reasons.push(reason("conflicting_job_strategy", "$.request.strategyId", "request strategy does not match the job"));
  }
  if (host.job && host.job.question !== request.question) {
    reasons.push(reason("conflicting_job_strategy", "$.request.question", "request question does not match the job"));
  }
  if (host.job && host.job.jobId !== request.jobId) {
    reasons.push(reason("conflicting_job_strategy", "$.request.jobId", "request is not bound to the host job"));
  }

  const snapshot =
    host.snapshots.find((row) => row.id === request.snapshotId) ??
    host.snapshots.find((row) => row.fingerprint === request.snapshotFingerprint);
  if (!snapshot) {
    reasons.push(reason("mismatched_snapshot", "$.request.snapshotId", "frozen snapshot is not in the host catalog"));
  } else {
    if (snapshot.fingerprint !== request.snapshotFingerprint) {
      reasons.push(reason("mismatched_snapshot", "$.request.snapshotFingerprint", "snapshot fingerprint does not match the frozen snapshot"));
    }
    if (snapshot.lineageClass !== request.snapshotLineageClass) {
      reasons.push(reason("mismatched_snapshot", "$.request.snapshotLineageClass", "snapshot lineage does not match the frozen snapshot"));
    }
    if (snapshot.parentSnapshotId !== request.parentSnapshotId) {
      reasons.push(reason("mismatched_snapshot", "$.request.parentSnapshotId", "snapshot parent does not match the frozen snapshot"));
    }
    for (const [i, evidenceId] of request.evidenceIds.entries()) {
      if (!snapshot.evidenceIds.includes(evidenceId)) {
        reasons.push(
          reason("dangling_evidence", `$.request.evidenceIds[${i}]`, "selected evidence is not in the frozen snapshot"),
        );
      }
    }
  }

  if (connector.egress === "declared_provider") {
    if (request.privacyClass === "share_safe") {
      reasons.push(reason("privacy_egress_refusal", "$.request.privacyClass", "share_safe requests cannot use declared-provider egress"));
    }
    if (!request.operatorConsent.providerEgress) {
      reasons.push(reason("privacy_egress_refusal", "$.request.operatorConsent.providerEgress", "declared-provider egress requires operator consent"));
    }
  }

  if (connector.requiredHostCapabilities.includes("profile_catalog") && request.profileId === null) {
    reasons.push(reason("missing_profile", "$.request.profileId", "connector requires a host-owned profile identity"));
  }

  let unknownCapability = false;
  for (const [i, cap] of connector.requiredHostCapabilities.entries()) {
    if (host.deniedCapabilities.includes(cap)) {
      reasons.push(reason("capability_denied", `$.connector.requiredHostCapabilities[${i}]`, `${cap} is denied on this host`));
    } else if (host.unknownCapabilities.includes(cap) || !host.availableCapabilities.includes(cap)) {
      unknownCapability = true;
      reasons.push(reason("unknown_capability", `$.connector.requiredHostCapabilities[${i}]`, `${cap} is not a known available host capability`));
    }
  }

  const blocking = reasons.some((row) =>
    [
      "connector_version_drift",
      "conflicting_job_strategy",
      "mismatched_snapshot",
      "dangling_evidence",
      "privacy_egress_refusal",
      "capability_denied",
      "missing_profile",
    ].includes(row.code),
  );

  let status: StrategyPlanStatus;
  if (blocking) status = "blocked";
  else if (unknownCapability) status = "unknown_capability";
  else if (connector.executionMode === "host_run") status = "can_execute";
  else status = "must_import";

  return {
    schemaId: STRATEGY_PLAN_SCHEMA_ID,
    status,
    connectorId: connector.connectorId,
    connectorVersion: connector.version,
    requestFingerprint: request.requestFingerprint,
    executionMode: connector.executionMode,
    contactedProvider: false,
    reasons,
  };
}

export function emptyStrategyRunHistory(requestFingerprint: string): StrategyRunHistoryV1 {
  requireSha256("$.requestFingerprint", requestFingerprint);
  return {
    schemaId: STRATEGY_RUN_HISTORY_SCHEMA_ID,
    requestFingerprint,
    attempts: [],
  };
}

export function appendStrategyRunAttempt(
  history: StrategyRunHistoryV1,
  attemptRaw: unknown,
  connector?: StrategyConnectorV1,
): StrategyRunHistoryV1 {
  const attempt = parseStrategyRunResult(attemptRaw, connector);
  if (history.attempts.length === 0) {
    if (attempt.revision !== 1) {
      throw new ContractViolation("$.revision", "the first attempt must be revision 1");
    }
    if (attempt.requestFingerprint !== history.requestFingerprint) {
      throw new ContractViolation("$.requestFingerprint", "attempt does not belong to this request");
    }
    return {
      schemaId: STRATEGY_RUN_HISTORY_SCHEMA_ID,
      requestFingerprint: history.requestFingerprint,
      attempts: [attempt],
    };
  }
  const parsed = parseStrategyRunHistory(history, connector);
  if (attempt.requestFingerprint !== parsed.requestFingerprint) {
    throw new ContractViolation("$.requestFingerprint", "attempt does not belong to this request");
  }
  if (parsed.attempts.some((row) => row.attemptId === attempt.attemptId)) {
    throw new ContractViolation("$.attemptId", "duplicate attempt");
  }
  const expectedRevision = parsed.attempts.length + 1;
  if (attempt.revision !== expectedRevision) {
    throw new ContractViolation("$.revision", "later runs must append the next revision and never overwrite");
  }
  return {
    schemaId: STRATEGY_RUN_HISTORY_SCHEMA_ID,
    requestFingerprint: parsed.requestFingerprint,
    attempts: [...parsed.attempts, attempt],
  };
}

export function projectInvestigationStrategyComparison(
  results: readonly StrategyRunResultV1[],
): StrategyComparisonProjectionV1 {
  if (results.length < 2) {
    throw new ContractViolation("$", "comparison requires at least two attempts");
  }
  const snapshotFingerprint = results[0]?.snapshotFingerprint;
  const strategyId = results[0]?.strategyId;
  if (!snapshotFingerprint || !strategyId) {
    throw new ContractViolation("$", "comparison requires snapshot and strategy identity");
  }
  for (const [i, row] of results.entries()) {
    parseStrategyRunResult(row);
    if (row.snapshotFingerprint !== snapshotFingerprint) {
      throw new ContractViolation(`$[ ${i} ].snapshotFingerprint`, "mismatched snapshots cannot be compared");
    }
    if (row.strategyId !== strategyId) {
      throw new ContractViolation(`$[ ${i} ].strategyId`, "conflicting job strategies cannot be compared");
    }
  }
  const sorted = [...results].sort(
    (a, b) => a.revision - b.revision || a.attemptId.localeCompare(b.attemptId),
  );
  const owners = new Map<string, string[]>();
  for (const row of sorted) {
    for (const ref of row.evidenceRefs) {
      const list = owners.get(ref) ?? [];
      list.push(row.attemptId);
      owners.set(ref, list);
    }
  }
  const sharedEvidence = [...owners.entries()]
    .filter(([, attemptIds]) => new Set(attemptIds).size > 1)
    .map(([ref]) => ref)
    .sort((a, b) => a.localeCompare(b));
  const uniqueEvidence = sorted.map((row) => ({
    attemptId: row.attemptId,
    evidenceRefs: row.evidenceRefs
      .filter((ref) => !sharedEvidence.includes(ref))
      .sort((a, b) => a.localeCompare(b)),
  }));
  const byText = new Map<string, string[]>();
  for (const row of sorted) {
    for (const claim of row.claims) {
      const hash = sha256Text(claim.text);
      const list = byText.get(hash) ?? [];
      list.push(row.attemptId);
      byText.set(hash, list);
    }
  }
  const claimAgreement = [...byText.entries()]
    .map(([textHash, attemptIds]) => ({
      textHash,
      attemptIds: [...new Set(attemptIds)].sort((a, b) => a.localeCompare(b)),
    }))
    .filter((row) => row.attemptIds.length > 1)
    .sort((a, b) => a.textHash.localeCompare(b.textHash));
  const unknowns = [...new Set(sorted.flatMap((row) => row.unknowns))].sort((a, b) => a.localeCompare(b));
  return {
    schemaId: STRATEGY_COMPARISON_PROJECTION_SCHEMA_ID,
    snapshotFingerprint,
    strategyId,
    attempts: sorted.map((row) => ({
      attemptId: row.attemptId,
      revision: row.revision,
      connectorId: row.connectorId,
      requestFingerprint: row.requestFingerprint,
      status: row.status,
    })),
    sharedEvidence,
    uniqueEvidence,
    claimAgreement,
    unknowns,
    notes: [
      AGREEMENT_NOT_CORRECTNESS,
      TEXTUAL_SIMILARITY_NOT_WINNER,
      CONSENSUS_IS_NOT_TRUTH,
      NO_WINNER_SELECTED,
      IMPORTED_OUTPUT_IS_NOT_A_HUMAN_FINDING,
    ],
    winnerSelected: false,
    consensusAsTruth: false,
  };
}

export const BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR: StrategyConnectorV1 = {
  schemaId: STRATEGY_CONNECTOR_SCHEMA_ID,
  connectorId: "builtin.synthetic_triage",
  version: "1.0.0",
  displayName: "Built-in synthetic triage",
  executionMode: "host_run",
  supportedInputKinds: ["frozen_snapshot", "selected_evidence", "operator_question"],
  requiredHostCapabilities: ["snapshot_store", "evidence_inventory", "synthetic_executor"],
  egress: "none",
  privacyClass: "owner_only",
  outputSchemaId: STRATEGY_RUN_RESULT_SCHEMA_ID,
  traceSupport: "optional",
  costSupport: "unknown_only",
  usageSupport: "unknown_only",
  cancellation: "cooperative",
};

export const BUILTIN_GATEWAY_COMPARE_CONNECTOR: StrategyConnectorV1 = {
  schemaId: STRATEGY_CONNECTOR_SCHEMA_ID,
  connectorId: "builtin.gateway_compare",
  version: "1.0.0",
  displayName: "Gateway-backed comparison lanes",
  executionMode: "host_run",
  supportedInputKinds: ["frozen_snapshot", "selected_evidence", "operator_question"],
  requiredHostCapabilities: ["snapshot_store", "evidence_inventory", "gateway_bridge", "profile_catalog"],
  egress: "declared_provider",
  privacyClass: "owner_only",
  outputSchemaId: STRATEGY_RUN_RESULT_SCHEMA_ID,
  traceSupport: "optional",
  costSupport: "unknown_only",
  usageSupport: "unknown_only",
  cancellation: "cooperative",
};

export const BUILTIN_EXTERNAL_IMPORT_CONNECTOR: StrategyConnectorV1 = {
  schemaId: STRATEGY_CONNECTOR_SCHEMA_ID,
  connectorId: "builtin.external_import",
  version: "1.0.0",
  displayName: "Manual imported run",
  executionMode: "external_import",
  supportedInputKinds: ["frozen_snapshot", "selected_evidence", "operator_question", "imported_run"],
  requiredHostCapabilities: ["snapshot_store", "evidence_inventory"],
  egress: "none",
  privacyClass: "owner_only",
  outputSchemaId: STRATEGY_RUN_RESULT_SCHEMA_ID,
  traceSupport: "optional",
  costSupport: "unknown_only",
  usageSupport: "unknown_only",
  cancellation: "none",
};

export const BUILTIN_MANUAL_NOTES_CONNECTOR: StrategyConnectorV1 = {
  schemaId: STRATEGY_CONNECTOR_SCHEMA_ID,
  connectorId: "builtin.manual_notes",
  version: "1.0.0",
  displayName: "Operator-authored structured notes",
  executionMode: "manual",
  supportedInputKinds: ["frozen_snapshot", "selected_evidence", "operator_question"],
  requiredHostCapabilities: ["snapshot_store", "evidence_inventory"],
  egress: "none",
  privacyClass: "owner_only",
  outputSchemaId: STRATEGY_RUN_RESULT_SCHEMA_ID,
  traceSupport: "none",
  costSupport: "unknown_only",
  usageSupport: "unknown_only",
  cancellation: "none",
};

export const CONTEXTDESK_STRATEGY_CONNECTORS: readonly StrategyConnectorV1[] = [
  BUILTIN_SYNTHETIC_TRIAGE_CONNECTOR,
  BUILTIN_GATEWAY_COMPARE_CONNECTOR,
  BUILTIN_EXTERNAL_IMPORT_CONNECTOR,
  BUILTIN_MANUAL_NOTES_CONNECTOR,
];
