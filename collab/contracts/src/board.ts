import type { ArtifactV1 } from "./artifact.js";
import type { ContributionV1 } from "./contribution.js";
import {
  AGREEMENT_NOT_CORRECTNESS,
  GOLD_STATES,
  type DecisionStatus,
  type ExperimentAgreementV1,
  type ExperimentDecisionV1,
  type GoldState,
} from "./experiment.js";
import { GOLD_IS_HUMAN_BENCHMARK, type GoldReferenceV1 } from "./gold.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { assertShareSafeTimestamp } from "./privacy.js";
import type { CorroborationState, ExternalRunV1 } from "./run.js";
import type { InteractionTraceV1 } from "./trace.js";

export const CASE_BOARD_SCHEMA_ID = "cd-collab.case_board.v1" as const;

export const CASE_BOARD_BUCKETS = [
  "known",
  "unknown",
  "agreed",
  "disputed",
  "newly_concluded",
] as const;
export type CaseBoardBucket = (typeof CASE_BOARD_BUCKETS)[number];

export const CASE_BOARD_CONFIDENCE = ["supported", "observed", "unknown"] as const;
export type CaseBoardConfidence = (typeof CASE_BOARD_CONFIDENCE)[number];

export const CASE_BOARD_SOURCE_KINDS = [
  "hypothesis",
  "artifact",
  "agreement",
  "decision",
  "gold",
  "trace",
  "import",
  "unknown",
] as const;
export type CaseBoardSourceKind = (typeof CASE_BOARD_SOURCE_KINDS)[number];

export interface CaseBoardFindingV1 {
  findingId: string;
  bucket: CaseBoardBucket;
  summary: string;
  evidenceRefs: string[];
  contributionRefs: string[];
  confidence: CaseBoardConfidence;
  unknowns: string[];
  sourceKind: CaseBoardSourceKind;
}

export interface CaseBoardGoldV1 {
  status: GoldState;
  version: number | null;
  goldId: string | null;
}

export interface CaseBoardV1 {
  schemaId: typeof CASE_BOARD_SCHEMA_ID;
  caseId: string;
  snapshotId: string | null;
  generatedAt: string;
  privacyClass: "owner_only";
  known: CaseBoardFindingV1[];
  unknown: CaseBoardFindingV1[];
  agreed: CaseBoardFindingV1[];
  disputed: CaseBoardFindingV1[];
  newlyConcluded: CaseBoardFindingV1[];
  gold: CaseBoardGoldV1;
  notes: string[];
}

export interface CaseBoardExperimentSource {
  experimentId: string;
  agreement: ExperimentAgreementV1;
  decisions: readonly Pick<
    ExperimentDecisionV1,
    "id" | "status" | "text" | "evidenceRefs" | "createdAt"
  >[];
  gold: GoldReferenceV1 | null;
  traces: readonly Pick<InteractionTraceV1, "traceId" | "completeness" | "unknowns" | "rawHash">[];
}

export interface DeriveCaseBoardInput {
  caseId: string;
  snapshotId: string | null;
  generatedAt: string;
  artifacts: readonly Pick<
    ArtifactV1,
    "id" | "contentHash" | "expectedHash" | "verificationStatus"
  >[];
  contributions: readonly Pick<
    ContributionV1,
    "id" | "kind" | "tombstoned" | "hypothesisStatus" | "hypothesisLinks" | "body"
  >[];
  experiments?: readonly CaseBoardExperimentSource[];
  imports?: readonly Pick<ExternalRunV1, "id" | "corroborationState" | "contributionId">[];
}

const findingShape: ObjectShape = {
  findingId: f.req(f.str),
  bucket: f.req(f.en(...CASE_BOARD_BUCKETS)),
  summary: f.req(f.str),
  evidenceRefs: f.req(f.arr(f.str)),
  contributionRefs: f.req(f.arr(f.str)),
  confidence: f.req(f.en(...CASE_BOARD_CONFIDENCE)),
  unknowns: f.req(f.arr(f.str)),
  sourceKind: f.req(f.en(...CASE_BOARD_SOURCE_KINDS)),
};

const goldShape: ObjectShape = {
  status: f.req(f.en(...GOLD_STATES)),
  version: f.nul(f.u64),
  goldId: f.nul(f.str),
};

export const caseBoardShape: ObjectShape = {
  schemaId: f.req(f.en(CASE_BOARD_SCHEMA_ID)),
  caseId: f.req(f.str),
  snapshotId: f.nul(f.str),
  generatedAt: f.req(f.str),
  privacyClass: f.req(f.en("owner_only")),
  known: f.req(f.arr(f.obj(findingShape))),
  unknown: f.req(f.arr(f.obj(findingShape))),
  agreed: f.req(f.arr(f.obj(findingShape))),
  disputed: f.req(f.arr(f.obj(findingShape))),
  newlyConcluded: f.req(f.arr(f.obj(findingShape))),
  gold: f.req(f.obj(goldShape)),
  notes: f.req(f.arr(f.str)),
};

function requireNonEmpty(path: string, value: string): void {
  if (!value.trim()) {
    throw new ContractViolation(path, "must not be empty");
  }
}

function uniqueRefs(path: string, values: string[]): string[] {
  const seen = new Set<string>();
  for (const [i, value] of values.entries()) {
    requireNonEmpty(`${path}[${i}]`, value);
    if (seen.has(value)) {
      throw new ContractViolation(`${path}[${i}]`, "duplicate value");
    }
    seen.add(value);
  }
  return values;
}

function findingsIn(
  bucket: CaseBoardBucket,
  rows: CaseBoardFindingV1[],
  seen: Set<string>,
): void {
  for (const [i, row] of rows.entries()) {
    const path = `$.${bucket === "newly_concluded" ? "newlyConcluded" : bucket}[${i}]`;
    requireNonEmpty(`${path}.findingId`, row.findingId);
    requireNonEmpty(`${path}.summary`, row.summary);
    uniqueRefs(`${path}.evidenceRefs`, row.evidenceRefs);
    uniqueRefs(`${path}.contributionRefs`, row.contributionRefs);
    uniqueRefs(`${path}.unknowns`, row.unknowns);
    if (row.bucket !== bucket) {
      throw new ContractViolation(`${path}.bucket`, `must be ${bucket}`);
    }
    if (seen.has(row.findingId)) {
      throw new ContractViolation(`${path}.findingId`, "duplicate findingId");
    }
    seen.add(row.findingId);
  }
}

export function parseCaseBoard(raw: unknown): CaseBoardV1 {
  checkObject("$", caseBoardShape, raw);
  const row = raw as CaseBoardV1;
  requireNonEmpty("$.caseId", row.caseId);
  if (row.snapshotId !== null) requireNonEmpty("$.snapshotId", row.snapshotId);
  assertShareSafeTimestamp("$.generatedAt", row.generatedAt);
  const seen = new Set<string>();
  findingsIn("known", row.known, seen);
  findingsIn("unknown", row.unknown, seen);
  findingsIn("agreed", row.agreed, seen);
  findingsIn("disputed", row.disputed, seen);
  findingsIn("newly_concluded", row.newlyConcluded, seen);
  if (!row.notes.includes(AGREEMENT_NOT_CORRECTNESS)) {
    throw new ContractViolation("$.notes", "must include the agreement-is-not-correctness caveat");
  }
  if (!row.notes.includes(GOLD_IS_HUMAN_BENCHMARK)) {
    throw new ContractViolation("$.notes", "must include the human-benchmark caveat");
  }
  if (row.gold.status === "present") {
    if (row.gold.goldId === null || !row.gold.goldId.trim()) {
      throw new ContractViolation("$.gold.goldId", "present gold requires a goldId");
    }
    if (row.gold.version === null || row.gold.version < 1) {
      throw new ContractViolation("$.gold.version", "present gold requires version >= 1");
    }
  } else if (row.gold.goldId !== null || row.gold.version !== null) {
    throw new ContractViolation("$.gold", "unknown or absent gold must not invent an identity");
  }
  return row;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))].sort((a, b) => a.localeCompare(b));
}

function finding(
  partial: Omit<CaseBoardFindingV1, "evidenceRefs" | "contributionRefs" | "unknowns"> & {
    evidenceRefs?: readonly string[];
    contributionRefs?: readonly string[];
    unknowns?: readonly string[];
  },
): CaseBoardFindingV1 {
  return {
    findingId: partial.findingId,
    bucket: partial.bucket,
    summary: partial.summary,
    evidenceRefs: sortedUnique(partial.evidenceRefs ?? []),
    contributionRefs: sortedUnique(partial.contributionRefs ?? []),
    confidence: partial.confidence,
    unknowns: sortedUnique(partial.unknowns ?? []),
    sourceKind: partial.sourceKind,
  };
}

function sortFindings(rows: CaseBoardFindingV1[]): CaseBoardFindingV1[] {
  return [...rows].sort((a, b) => a.findingId.localeCompare(b.findingId));
}

function splitHypothesisLinks(
  links: ContributionV1["hypothesisLinks"],
): { evidenceRefs: string[]; contributionRefs: string[] } {
  const evidenceRefs: string[] = [];
  const contributionRefs: string[] = [];
  for (const link of links ?? []) {
    if (link.kind === "artifact") evidenceRefs.push(link.id);
    else contributionRefs.push(link.id);
  }
  return { evidenceRefs, contributionRefs };
}

function goldFromExperiments(
  experiments: readonly CaseBoardExperimentSource[] | undefined,
): CaseBoardGoldV1 {
  if (!experiments) {
    return { status: "unknown", version: null, goldId: null };
  }
  const golds = experiments
    .map((row) => row.gold)
    .filter((row): row is GoldReferenceV1 => row !== null)
    .sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.goldId.localeCompare(b.goldId),
    );
  const latest = golds.at(-1);
  if (!latest) {
    return { status: "unknown", version: null, goldId: null };
  }
  return { status: "present", version: latest.version, goldId: latest.goldId };
}

function promotedDecisionIds(gold: GoldReferenceV1 | null): Set<string> {
  return gold ? new Set([gold.acceptedDecisionId]) : new Set();
}

function latestAccepted(decisions: CaseBoardExperimentSource["decisions"]): {
  id: string;
  status: DecisionStatus;
  text: string;
  evidenceRefs: readonly string[];
  createdAt: string;
} | null {
  const accepted = decisions
    .filter((row) => row.status === "accepted")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return accepted.at(-1) ?? null;
}

export function deriveCaseBoard(input: DeriveCaseBoardInput): CaseBoardV1 {
  const known: CaseBoardFindingV1[] = [];
  const unknown: CaseBoardFindingV1[] = [];
  const agreed: CaseBoardFindingV1[] = [];
  const disputed: CaseBoardFindingV1[] = [];
  const newlyConcluded: CaseBoardFindingV1[] = [];

  for (const contribution of input.contributions) {
    if (contribution.kind !== "hypothesis" || contribution.tombstoned) continue;
    const status = contribution.hypothesisStatus;
    if (status === "superseded" || status === null) continue;
    const links = splitHypothesisLinks(contribution.hypothesisLinks);
    const summary = contribution.body?.trim() || "hypothesis";
    if (status === "supported") {
      known.push(
        finding({
          findingId: `hyp-${contribution.id}`,
          bucket: "known",
          summary,
          evidenceRefs: links.evidenceRefs,
          contributionRefs: links.contributionRefs,
          confidence: "supported",
          sourceKind: "hypothesis",
        }),
      );
    } else if (status === "proposed") {
      unknown.push(
        finding({
          findingId: `hyp-${contribution.id}`,
          bucket: "unknown",
          summary,
          evidenceRefs: links.evidenceRefs,
          contributionRefs: links.contributionRefs,
          confidence: "unknown",
          unknowns: ["hypothesis remains proposed"],
          sourceKind: "hypothesis",
        }),
      );
    } else if (status === "contradicted") {
      disputed.push(
        finding({
          findingId: `hyp-${contribution.id}`,
          bucket: "disputed",
          summary,
          evidenceRefs: links.evidenceRefs,
          contributionRefs: links.contributionRefs,
          confidence: "observed",
          sourceKind: "hypothesis",
        }),
      );
    }
  }

  for (const artifact of input.artifacts) {
    const hashed = artifact.contentHash ?? artifact.expectedHash;
    const unreachable = artifact.verificationStatus === "unreachable";
    if (hashed !== null && !unreachable) continue;
    const unknowns = [
      hashed === null ? "content hash unknown" : "",
      unreachable ? "file-server reference unreachable" : "",
    ].filter((row) => row.length > 0);
    unknown.push(
      finding({
        findingId: `artifact-unknown-${artifact.id}`,
        bucket: "unknown",
        summary: "Evidence identity is incomplete",
        evidenceRefs: [artifact.id],
        confidence: "unknown",
        unknowns,
        sourceKind: "artifact",
      }),
    );
  }

  if (input.experiments) {
    for (const experiment of input.experiments) {
      for (const anchor of experiment.agreement.sharedAnchors) {
        agreed.push(
          finding({
            findingId: `agree-${experiment.experimentId}-${anchor.evidenceRef}`,
            bucket: "agreed",
            summary: `Shared agreement on ${anchor.evidenceRef} as ${anchor.role}`,
            evidenceRefs: [anchor.evidenceRef],
            confidence: "observed",
            sourceKind: "agreement",
          }),
        );
      }
      for (const conflict of experiment.agreement.roleConflicts) {
        disputed.push(
          finding({
            findingId: `conflict-${experiment.experimentId}-${conflict.evidenceRef}`,
            bucket: "disputed",
            summary: `Role conflict on ${conflict.evidenceRef}`,
            evidenceRefs: [conflict.evidenceRef],
            confidence: "observed",
            sourceKind: "agreement",
          }),
        );
      }
      const promoted = promotedDecisionIds(experiment.gold);
      const accepted = latestAccepted(experiment.decisions);
      if (accepted && !promoted.has(accepted.id)) {
        newlyConcluded.push(
          finding({
            findingId: `decision-${accepted.id}`,
            bucket: "newly_concluded",
            summary: accepted.text,
            evidenceRefs: accepted.evidenceRefs,
            confidence: "observed",
            sourceKind: "decision",
          }),
        );
      }
      for (const trace of experiment.traces) {
        const incomplete =
          trace.completeness !== "exact" ||
          trace.unknowns.length > 0 ||
          trace.rawHash === null;
        if (!incomplete) continue;
        unknown.push(
          finding({
            findingId: `trace-unknown-${trace.traceId}`,
            bucket: "unknown",
            summary: "Interaction trace is incomplete",
            confidence: "unknown",
            unknowns: [
              ...(trace.completeness !== "exact" ? [`completeness is ${trace.completeness}`] : []),
              ...trace.unknowns,
              ...(trace.rawHash === null ? ["raw hash unknown"] : []),
            ],
            sourceKind: "trace",
          }),
        );
      }
    }
  }

  if (input.imports) {
    for (const row of input.imports) {
      const state: CorroborationState = row.corroborationState;
      const base = {
        findingId: `import-${row.id}`,
        summary: `Imported run ${row.id}`,
        contributionRefs: [row.contributionId],
        sourceKind: "import" as const,
      };
      if (state === "corroborated") {
        known.push(
          finding({
            ...base,
            bucket: "known",
            confidence: "observed",
          }),
        );
      } else if (state === "contradicted") {
        disputed.push(
          finding({
            ...base,
            bucket: "disputed",
            confidence: "observed",
          }),
        );
      } else {
        unknown.push(
          finding({
            ...base,
            bucket: "unknown",
            confidence: "unknown",
            unknowns: ["imported run is unverified"],
            sourceKind: "import",
          }),
        );
      }
    }
  }

  const gold = goldFromExperiments(input.experiments);
  const notes: string[] = [AGREEMENT_NOT_CORRECTNESS, GOLD_IS_HUMAN_BENCHMARK];
  if (gold.status === "present") {
    notes.push("Gold reference recorded as a human benchmark, not case truth.");
  } else {
    notes.push("No gold reference was supplied; gold stays unknown.");
  }

  return parseCaseBoard({
    schemaId: CASE_BOARD_SCHEMA_ID,
    caseId: input.caseId,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt,
    privacyClass: "owner_only",
    known: sortFindings(known),
    unknown: sortFindings(unknown),
    agreed: sortFindings(agreed),
    disputed: sortFindings(disputed),
    newlyConcluded: sortFindings(newlyConcluded),
    gold,
    notes,
  });
}
