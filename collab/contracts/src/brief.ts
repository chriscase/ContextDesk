import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { CASE_SEVERITIES, CASE_STATUSES, PRIVACY_CLASSES } from "./case.js";
import {
  ENTITY_KINDS,
  INVOLVEMENT_RELATIONSHIPS,
  INVOLVEMENT_STATES,
  type EntityKind,
  type InvolvementRelationship,
  type InvolvementState,
} from "./investigation-entity.js";
import {
  INVESTIGATION_RESOURCE_KINDS,
  INVESTIGATION_PROVENANCE_CLASSES,
  type InvestigationProvenanceClassV1,
  type InvestigationResourceKindV1,
} from "./investigation-activity.js";
import { REFERENCE_STATES, type ReferenceState } from "./investigation-reference.js";
import { RESOLUTION_BASES, type ResolutionBasis } from "./investigation-resolution.js";
import {
  OCCURRED_AT_PRECISIONS,
  OCCURRED_AT_ZONES,
  type OccurredAtPrecision,
  type OccurredAtZone,
} from "./temporal.js";
import { HYPOTHESIS_STATUSES } from "./contribution.js";
import { CORROBORATION_STATES } from "./run.js";

export const BRIEF_SCHEMA_ID = "cd-collab.brief.v1" as const;
export const IMPORTED_RESPONSE_PRESENTATION = "imported_response" as const;

export interface BriefHeaderV1 {
  caseId: string;
  title: string;
  severity: string;
  status: string;
  legalHold: boolean;
  retentionClass: string;
}

export interface BriefTimelineEventV1 {
  seq: number;
  kind: string;
  actorLabel: string;
  targetId: string | null;
  payloadDigest: string;
}

export interface BriefLinkV1 {
  kind: string;
  id: string;
}

export interface BriefHypothesisV1 {
  id: string;
  status: string;
  body: string | null;
  contentHash: string;
  sourceLabel: string;
  supporting: BriefLinkV1[];
  contradicting: BriefLinkV1[];
}

export interface BriefActionV1 {
  id: string;
  body: string | null;
  contentHash: string;
  actorLabel: string;
  sourceLabel: string;
}

export interface BriefEvidenceV1 {
  id: string;
  kind: string;
  filename: string | null;
  contentHash: string | null;
  sourceLabel: string;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  verificationStatus: string | null;
  content: string | null;
  bytesIncluded: boolean;
}

export interface BriefAttributionV1 {
  actorLabel: string;
  action: string;
  targetKind: string;
  targetId: string | null;
}

/**
 * An entity an investigation involves, as it leaves the tool.
 *
 * `entityRef` is the label only when the registry marked that label
 * share-safe. Otherwise it is a stable pseudonymous handle derived from the
 * entity id: a share-safe export can still show that two investigations
 * concern the same party without disclosing who that party is.
 */
export interface BriefInvolvementV1 {
  entityRef: string;
  labelDisclosed: boolean;
  kind: EntityKind;
  relationship: InvolvementRelationship;
  state: InvolvementState;
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
}

/**
 * A citation this investigation makes. The pointer travels; the cited
 * investigation's title does not leave the tool in a share-safe export,
 * because it is another investigation's content rather than this one's.
 */
export interface BriefReferenceV1 {
  toInvestigationId: string;
  resourceKind: InvestigationResourceKindV1;
  locator: string;
  citedTitle: string | null;
  note: string;
  state: ReferenceState;
}

/**
 * The record behind a resolved status. Basis and provenance always travel so a
 * downstream reader can tell human reasoning from a model decision; the
 * reasoning itself is owner-only content and is withheld from a share-safe
 * export, with the count of open unknowns kept so the conclusion is not made
 * to look more complete than it was.
 */
export interface BriefResolutionV1 {
  basis: ResolutionBasis;
  provenance: InvestigationProvenanceClassV1;
  revision: number;
  actorLabel: string;
  rationale: string | null;
  rationaleIncluded: boolean;
  unknownCount: number;
  unknowns: string[] | null;
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
}

export interface BriefImportedRunV1 {
  id: string;
  sourceLabel: string;
  corroborationState: string;
  snapshotBinding: string | null;
  presentation: typeof IMPORTED_RESPONSE_PRESENTATION;
  outputIncluded: boolean;
  outputText: string | null;
}

export interface BriefMemorySummaryV1 {
  latestSnapshotLabel: string | null;
  latestSnapshotFingerprint: string | null;
  parentSnapshotLabel: string | null;
  evidenceCount: number;
  lineageDepth: number;
  boardCounts: {
    known: number;
    unknown: number;
    agreed: number;
    disputed: number;
    newlyConcluded: number;
  };
  agreementNotice: "Agreement is not proof of correctness.";
}

export interface BriefV1 {
  schemaId: typeof BRIEF_SCHEMA_ID;
  privacyClass: (typeof PRIVACY_CLASSES)[number];
  header: BriefHeaderV1;
  timeline: BriefTimelineEventV1[];
  hypotheses: BriefHypothesisV1[];
  actions: BriefActionV1[];
  evidence: BriefEvidenceV1[];
  attributions: BriefAttributionV1[];
  importedRuns: BriefImportedRunV1[];
  /**
   * Optional so a brief written before the investigation record graph existed
   * still parses. A server that has the graph always emits them, and an empty
   * array means "nothing recorded", not "not supported".
   */
  involvement?: BriefInvolvementV1[];
  references?: BriefReferenceV1[];
  resolution?: BriefResolutionV1 | null;
  memory?: BriefMemorySummaryV1;
}

const linkShape: ObjectShape = {
  kind: f.req(f.str),
  id: f.req(f.str),
};

const headerShape: ObjectShape = {
  caseId: f.req(f.str),
  title: f.req(f.str),
  severity: f.req(f.en(...CASE_SEVERITIES)),
  status: f.req(f.en(...CASE_STATUSES)),
  legalHold: f.req(f.bool),
  retentionClass: f.req(f.str),
};

const timelineShape: ObjectShape = {
  seq: f.req(f.u64),
  kind: f.req(f.str),
  actorLabel: f.req(f.str),
  targetId: f.nul(f.str),
  payloadDigest: f.req(f.str),
};

const hypothesisShape: ObjectShape = {
  id: f.req(f.str),
  status: f.req(f.en(...HYPOTHESIS_STATUSES)),
  body: f.nul(f.str),
  contentHash: f.req(f.str),
  sourceLabel: f.req(f.str),
  supporting: f.req(f.arr(f.obj(linkShape))),
  contradicting: f.req(f.arr(f.obj(linkShape))),
};

const actionShape: ObjectShape = {
  id: f.req(f.str),
  body: f.nul(f.str),
  contentHash: f.req(f.str),
  actorLabel: f.req(f.str),
  sourceLabel: f.req(f.str),
};

const evidenceShape: ObjectShape = {
  id: f.req(f.str),
  kind: f.req(f.str),
  filename: f.nul(f.str),
  contentHash: f.nul(f.str),
  sourceLabel: f.req(f.str),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  verificationStatus: f.nul(f.str),
  content: f.nul(f.str),
  bytesIncluded: f.req(f.bool),
};

const attributionShape: ObjectShape = {
  actorLabel: f.req(f.str),
  action: f.req(f.str),
  targetKind: f.req(f.str),
  targetId: f.nul(f.str),
};

const importedRunShape: ObjectShape = {
  id: f.req(f.str),
  sourceLabel: f.req(f.str),
  corroborationState: f.req(f.en(...CORROBORATION_STATES)),
  snapshotBinding: f.nul(f.str),
  presentation: f.req(f.en(IMPORTED_RESPONSE_PRESENTATION)),
  outputIncluded: f.req(f.bool),
  outputText: f.nul(f.str),
};

const boardCountsShape: ObjectShape = {
  known: f.req(f.u64),
  unknown: f.req(f.u64),
  agreed: f.req(f.u64),
  disputed: f.req(f.u64),
  newlyConcluded: f.req(f.u64),
};

const memoryShape: ObjectShape = {
  latestSnapshotLabel: f.nul(f.str),
  latestSnapshotFingerprint: f.nul(f.str),
  parentSnapshotLabel: f.nul(f.str),
  evidenceCount: f.req(f.u64),
  lineageDepth: f.req(f.u64),
  boardCounts: f.req(f.obj(boardCountsShape)),
  agreementNotice: f.req(f.en("Agreement is not proof of correctness.")),
};

const briefInvolvementShape: ObjectShape = {
  entityRef: f.req(f.nstr),
  labelDisclosed: f.req(f.bool),
  kind: f.req(f.en(...ENTITY_KINDS)),
  relationship: f.req(f.en(...INVOLVEMENT_RELATIONSHIPS)),
  state: f.req(f.en(...INVOLVEMENT_STATES)),
  occurredAt: f.nul(f.str),
  occurredAtPrecision: f.req(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.req(f.en(...OCCURRED_AT_ZONES)),
};

const briefReferenceShape: ObjectShape = {
  toInvestigationId: f.req(f.nstr),
  resourceKind: f.req(f.en(...INVESTIGATION_RESOURCE_KINDS)),
  locator: f.req(f.nstr),
  citedTitle: f.nul(f.str),
  note: f.req(f.str),
  state: f.req(f.en(...REFERENCE_STATES)),
};

const briefResolutionShape: ObjectShape = {
  basis: f.req(f.en(...RESOLUTION_BASES)),
  provenance: f.req(f.en(...INVESTIGATION_PROVENANCE_CLASSES)),
  revision: f.req(f.u64),
  actorLabel: f.req(f.str),
  rationale: f.nul(f.str),
  rationaleIncluded: f.req(f.bool),
  unknownCount: f.req(f.u64),
  unknowns: f.nul(f.arr(f.str)),
  occurredAt: f.nul(f.str),
  occurredAtPrecision: f.req(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.req(f.en(...OCCURRED_AT_ZONES)),
  recordedAt: f.req(f.nstr),
};

export const briefShape: ObjectShape = {
  schemaId: f.req(f.en(BRIEF_SCHEMA_ID)),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  header: f.req(f.obj(headerShape)),
  timeline: f.req(f.arr(f.obj(timelineShape))),
  hypotheses: f.req(f.arr(f.obj(hypothesisShape))),
  actions: f.req(f.arr(f.obj(actionShape))),
  evidence: f.req(f.arr(f.obj(evidenceShape))),
  attributions: f.req(f.arr(f.obj(attributionShape))),
  importedRuns: f.req(f.arr(f.obj(importedRunShape))),
  involvement: f.opt(f.arr(f.obj(briefInvolvementShape))),
  references: f.opt(f.arr(f.obj(briefReferenceShape))),
  resolution: f.optNul(f.obj(briefResolutionShape)),
  memory: f.opt(f.obj(memoryShape)),
};

export function parseBrief(raw: unknown): BriefV1 {
  checkObject("$", briefShape, raw);
  const parsed = raw as BriefV1;
  // Default-deny, checked rather than assumed: a share-safe brief must not
  // carry an undisclosed entity label, another investigation's title, or the
  // reasoning behind a conclusion.
  if (parsed.privacyClass === "share_safe") {
    (parsed.involvement ?? []).forEach((row, index) => {
      if (!row.labelDisclosed && row.entityRef.startsWith(SHARE_SAFE_ENTITY_HANDLE_PREFIX)) return;
      if (!row.labelDisclosed) {
        throw new ContractViolation(
          `$.involvement[${index}].entityRef`,
          "an undisclosed entity must travel as a pseudonymous handle",
        );
      }
    });
    (parsed.references ?? []).forEach((row, index) => {
      if (row.citedTitle !== null) {
        throw new ContractViolation(
          `$.references[${index}].citedTitle`,
          "a share-safe brief must not disclose another investigation's title",
        );
      }
    });
    if (parsed.resolution && parsed.resolution.rationaleIncluded) {
      throw new ContractViolation(
        "$.resolution.rationale",
        "resolution reasoning is owner-only content",
      );
    }
  }
  if (parsed.resolution) {
    const withheld = !parsed.resolution.rationaleIncluded;
    if (withheld && parsed.resolution.rationale !== null) {
      throw new ContractViolation(
        "$.resolution.rationale",
        "a withheld rationale must be absent, not partially included",
      );
    }
    if (!withheld && parsed.resolution.rationale === null) {
      throw new ContractViolation(
        "$.resolution.rationale",
        "an included rationale must carry the reasoning",
      );
    }
  }
  return parsed;
}

/** Marks a pseudonymous entity reference in a share-safe brief. */
export const SHARE_SAFE_ENTITY_HANDLE_PREFIX = "entity:" as const;
