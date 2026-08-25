/**
 * Human-only resolution records.
 *
 * An investigation can be resolved by a person reasoning from notes and
 * evidence, with no model run and no experiment anywhere in the case. That is
 * an ordinary, respectable outcome — most historical and manual investigations
 * end that way — and the workspace must not treat it as second-class or force
 * it through a comparison that never happened.
 *
 * What it must not be is *silent*. Before this contract, moving an
 * investigation to `resolved` wrote a status and nothing else: no stated
 * reason, no named decider, no record of what stayed unknown. A year later the
 * case says "resolved" and cannot say why, which is exactly the failure the
 * rest of this workspace exists to prevent.
 *
 * So `resolved` requires a resolution record, and the record carries what a
 * later reader needs:
 *
 * - **basis** — how the conclusion was reached: `human_only` reasoning, an
 *   accepted `experiment_decision`, or a `reasoned_exception` when the case is
 *   being closed without a substantive conclusion (duplicate, withdrawn,
 *   overtaken by events). The exception is modelled explicitly rather than
 *   left as an undocumented status flip.
 * - **provenance** — typed the same way activity is, so a restored historical
 *   record is never mistaken for fresh human reasoning.
 * - **rationale** — required in every basis, including exceptions.
 * - **unknowns** — what is still not known. Recording this is what keeps a
 *   resolution honest instead of implying the question was fully answered.
 * - **revision guard** — resolutions are insert-only and versioned, so two
 *   people resolving concurrently conflict loudly instead of overwriting each
 *   other, and superseding a resolution preserves the earlier one.
 *
 * A resolution is not evidence and never becomes a contribution. It cites
 * evidence by identity; it does not absorb it.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { CASE_STATUSES, type CaseStatus } from "./case.js";
import {
  INVESTIGATION_PROVENANCE_CLASSES,
  type InvestigationProvenanceClassV1,
} from "./investigation-activity.js";
import {
  OCCURRED_AT_PRECISIONS,
  OCCURRED_AT_ZONES,
  assertOccurrenceFields,
  isIsoInstant,
  type OccurredAtPrecision,
  type OccurredAtZone,
} from "./temporal.js";

export const RESOLUTION_SCHEMA_ID = "cd-collab.investigation_resolution.v1" as const;
export const RESOLUTION_LIST_SCHEMA_ID =
  "cd-collab.investigation_resolution_list.v1" as const;

export const RESOLUTION_BASES = [
  "human_only",
  "experiment_decision",
  "reasoned_exception",
] as const;
export type ResolutionBasis = (typeof RESOLUTION_BASES)[number];

/**
 * Statuses that may not be entered without an active resolution record.
 * `monitoring` and `archived` stay unguarded on purpose: neither claims the
 * question was answered.
 */
export const STATUSES_REQUIRING_RESOLUTION: readonly CaseStatus[] = ["resolved"];

export function statusRequiresResolution(status: string): boolean {
  return (STATUSES_REQUIRING_RESOLUTION as readonly string[]).includes(status);
}

export const RESOLUTION_RATIONALE_MAX_LENGTH = 4000;
export const RESOLUTION_UNKNOWN_MAX_LENGTH = 400;
export const RESOLUTION_MAX_UNKNOWNS = 50;
export const RESOLUTION_EXCEPTION_MAX_LENGTH = 600;

export interface InvestigationResolutionV1 {
  schemaId: typeof RESOLUTION_SCHEMA_ID;
  id: string;
  investigationId: string;
  /** 1-based and insert-only. Superseding appends; it never edits. */
  revision: number;
  predecessorRevision: number | null;
  basis: ResolutionBasis;
  provenance: InvestigationProvenanceClassV1;
  /** The status this resolution authorises. */
  status: CaseStatus;
  rationale: string;
  /** What remains unknown. An empty list is a claim, so it is recorded as one. */
  unknowns: string[];
  /** Set only when basis is experiment_decision. */
  experimentDecisionId: string | null;
  /** Set only when basis is reasoned_exception. */
  exceptionReason: string | null;
  /**
   * Evidence and contributions this reasoning rests on, by identity. Citing
   * does not copy, and a citation never becomes supporting evidence on its own.
   */
  citedArtifactIds: string[];
  citedContributionIds: string[];
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  supersededAt: string | null;
}

export interface InvestigationResolutionListV1 {
  schemaId: typeof RESOLUTION_LIST_SCHEMA_ID;
  investigationId: string;
  /** Newest first. The head is the active resolution, if any. */
  resolutions: InvestigationResolutionV1[];
}

export function isResolutionBasis(value: unknown): value is ResolutionBasis {
  return typeof value === "string" && (RESOLUTION_BASES as readonly string[]).includes(value);
}

const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/;

export function normalizeRationale(raw: unknown, path = "$.rationale"): string {
  if (typeof raw !== "string") throw new ContractViolation(path, "expected string");
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ContractViolation(path, "a resolution must record why it was reached");
  }
  if (trimmed.length > RESOLUTION_RATIONALE_MAX_LENGTH) {
    throw new ContractViolation(
      path,
      `rationale exceeds ${RESOLUTION_RATIONALE_MAX_LENGTH} characters`,
    );
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ContractViolation(path, "control characters are not allowed");
  }
  return trimmed;
}

export function normalizeUnknowns(raw: unknown, path = "$.unknowns"): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ContractViolation(path, "expected array");
  if (raw.length > RESOLUTION_MAX_UNKNOWNS) {
    throw new ContractViolation(path, `at most ${RESOLUTION_MAX_UNKNOWNS} unknowns`);
  }
  const out: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== "string") {
      throw new ContractViolation(`${path}[${index}]`, "expected string");
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) return;
    if (trimmed.length > RESOLUTION_UNKNOWN_MAX_LENGTH) {
      throw new ContractViolation(
        `${path}[${index}]`,
        `exceeds ${RESOLUTION_UNKNOWN_MAX_LENGTH} characters`,
      );
    }
    if (CONTROL_CHARACTERS.test(trimmed)) {
      throw new ContractViolation(`${path}[${index}]`, "control characters are not allowed");
    }
    out.push(trimmed);
  });
  return out;
}

/**
 * Cross-field rules that make a resolution mean one specific thing. Each
 * basis owns exactly the fields it needs and must leave the others null, so
 * "human reasoning" can never be quietly relabelled as a model decision.
 */
export function assertResolutionBasis(row: {
  basis: ResolutionBasis;
  experimentDecisionId: string | null;
  exceptionReason: string | null;
  provenance: InvestigationProvenanceClassV1;
}, path = "$"): void {
  if (row.basis === "experiment_decision") {
    if (!row.experimentDecisionId) {
      throw new ContractViolation(
        `${path}.experimentDecisionId`,
        "an experiment_decision resolution must name the accepted decision",
      );
    }
    if (row.exceptionReason !== null) {
      throw new ContractViolation(
        `${path}.exceptionReason`,
        "an experiment_decision resolution is not an exception",
      );
    }
    return;
  }
  if (row.experimentDecisionId !== null) {
    throw new ContractViolation(
      `${path}.experimentDecisionId`,
      `a ${row.basis} resolution must not cite an experiment decision`,
    );
  }
  if (row.basis === "reasoned_exception") {
    if (!row.exceptionReason || row.exceptionReason.trim().length === 0) {
      throw new ContractViolation(
        `${path}.exceptionReason`,
        "a reasoned_exception must say what the exception is",
      );
    }
    if (row.exceptionReason.length > RESOLUTION_EXCEPTION_MAX_LENGTH) {
      throw new ContractViolation(`${path}.exceptionReason`, "exception reason is too long");
    }
    return;
  }
  if (row.exceptionReason !== null) {
    throw new ContractViolation(
      `${path}.exceptionReason`,
      "a human_only resolution is not an exception",
    );
  }
  if (row.provenance === "ai_generated") {
    throw new ContractViolation(
      `${path}.provenance`,
      "a human_only resolution cannot claim ai_generated provenance",
    );
  }
}

export const resolutionShape: ObjectShape = {
  schemaId: f.req(f.en(RESOLUTION_SCHEMA_ID)),
  id: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  revision: f.req(f.u64),
  predecessorRevision: f.nul(f.u64),
  basis: f.req(f.en(...RESOLUTION_BASES)),
  provenance: f.req(f.en(...INVESTIGATION_PROVENANCE_CLASSES)),
  status: f.req(f.en(...CASE_STATUSES)),
  rationale: f.req(f.nstr),
  unknowns: f.req(f.arr(f.str)),
  experimentDecisionId: f.nul(f.str),
  exceptionReason: f.nul(f.str),
  citedArtifactIds: f.req(f.arr(f.str)),
  citedContributionIds: f.req(f.arr(f.str)),
  occurredAt: f.nul(f.str),
  occurredAtPrecision: f.req(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.req(f.en(...OCCURRED_AT_ZONES)),
  recordedAt: f.req(f.nstr),
  recordedBy: f.req(f.nstr),
  recordedByUsername: f.req(f.nstr),
  supersededAt: f.nul(f.str),
};

export function parseInvestigationResolution(
  raw: unknown,
  path = "$",
): InvestigationResolutionV1 {
  checkObject(path, resolutionShape, raw);
  const parsed = raw as InvestigationResolutionV1;
  if (parsed.revision < 1) {
    throw new ContractViolation(`${path}.revision`, "revisions are 1-based");
  }
  if (parsed.revision === 1) {
    if (parsed.predecessorRevision !== null) {
      throw new ContractViolation(
        `${path}.predecessorRevision`,
        "the first resolution has no predecessor",
      );
    }
  } else if (parsed.predecessorRevision !== parsed.revision - 1) {
    throw new ContractViolation(
      `${path}.predecessorRevision`,
      "a resolution must supersede the revision immediately before it",
    );
  }
  if (!statusRequiresResolution(parsed.status)) {
    throw new ContractViolation(
      `${path}.status`,
      `a resolution record only authorises ${STATUSES_REQUIRING_RESOLUTION.join(", ")}`,
    );
  }
  normalizeRationale(parsed.rationale, `${path}.rationale`);
  assertResolutionBasis(parsed, path);
  if (!isIsoInstant(parsed.recordedAt)) {
    throw new ContractViolation(`${path}.recordedAt`, "expected a full ISO-8601 instant");
  }
  assertOccurrenceFields(parsed, path);
  if (parsed.supersededAt !== null && !isIsoInstant(parsed.supersededAt)) {
    throw new ContractViolation(`${path}.supersededAt`, "expected a full ISO-8601 instant");
  }
  return parsed;
}

const resolutionListShape: ObjectShape = {
  schemaId: f.req(f.en(RESOLUTION_LIST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  resolutions: f.req(f.arr(f.obj(resolutionShape))),
};

export function parseInvestigationResolutionList(
  raw: unknown,
): InvestigationResolutionListV1 {
  checkObject("$", resolutionListShape, raw);
  const parsed = raw as InvestigationResolutionListV1;
  parsed.resolutions.forEach((row, index) => {
    parseInvestigationResolution(row, `$.resolutions[${index}]`);
    if (row.investigationId !== parsed.investigationId) {
      throw new ContractViolation(
        `$.resolutions[${index}].investigationId`,
        "resolution belongs to a different investigation",
      );
    }
  });
  for (let index = 1; index < parsed.resolutions.length; index += 1) {
    const newer = parsed.resolutions[index - 1];
    const older = parsed.resolutions[index];
    if (!newer || !older) continue;
    if (newer.revision <= older.revision) {
      throw new ContractViolation(
        `$.resolutions[${index}]`,
        "resolutions are ordered newest revision first",
      );
    }
  }
  // At most one resolution is active, and if one is, it is the newest. A
  // fully superseded history is legitimate: it is what an investigation looks
  // like after being reopened, and the earlier reasoning stays readable.
  const activeIndexes = parsed.resolutions
    .map((row, index) => (row.supersededAt === null ? index : -1))
    .filter((index) => index >= 0);
  if (activeIndexes.length > 1) {
    throw new ContractViolation(
      "$.resolutions",
      "an investigation has at most one active resolution",
    );
  }
  if (activeIndexes.length === 1 && activeIndexes[0] !== 0) {
    throw new ContractViolation(
      `$.resolutions[${activeIndexes[0]}].supersededAt`,
      "the active resolution must be the newest revision",
    );
  }
  return parsed;
}

/**
 * The resolution currently authorising a status, or null when there is none —
 * which is also what a reopened investigation looks like, by design.
 */
export function activeResolution(
  list: readonly InvestigationResolutionV1[],
): InvestigationResolutionV1 | null {
  return list.find((row) => row.supersededAt === null) ?? null;
}
