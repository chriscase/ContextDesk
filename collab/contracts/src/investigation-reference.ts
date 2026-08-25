/**
 * Authorized references from one investigation to another.
 *
 * Long-lived work repeats. The outage being looked at this week is often the
 * one that was looked at eighteen months ago, and the useful move is to cite
 * that older case rather than re-litigate it. A reference is that citation:
 * a pointer, plus the reason it was made.
 *
 * Three properties make a citation trustworthy enough to leave in a record
 * someone will read years later:
 *
 * 1. **It preserves the original.** A reference copies nothing. It never
 *    mutates, re-hosts, or summarises the cited investigation, and creating
 *    one leaves no trace in the cited case's own content. Withdrawing a
 *    reference marks it withdrawn; it never erases that the citation was
 *    made.
 * 2. **It deep-links.** The stored `locator` is the canonical in-app
 *    pathname for the cited investigation or the exact resource inside it,
 *    derived from the same shared function the activity feed uses, so a
 *    citation lands on a visible record rather than a guessed URL.
 * 3. **It is authorized twice.** Once when written — the author must be able
 *    to read the cited investigation — and again on every read. Access is not
 *    inherited by citation: a reader who cannot open the cited case sees the
 *    reference exists and where it points, and does not see its title. That
 *    is `visibility: "restricted"`, and it is the fail-closed default whenever
 *    the cited case cannot be resolved for this reader.
 *
 * The recorded title is immutable historical attribution, exactly as
 * involvement links record the entity label they were written with: renaming
 * the cited investigation later never rewrites what this citation said.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  INVESTIGATION_RESOURCE_KINDS,
  deriveInvestigationResourcePathname,
  isInvestigationUuid,
  type InvestigationResourceKindV1,
} from "./investigation-activity.js";
import {
  OCCURRED_AT_PRECISIONS,
  OCCURRED_AT_ZONES,
  assertOccurrenceFields,
  isIsoInstant,
  type OccurredAtPrecision,
  type OccurredAtZone,
} from "./temporal.js";

export const INVESTIGATION_REFERENCE_SCHEMA_ID =
  "cd-collab.investigation_reference.v1" as const;
export const INVESTIGATION_REFERENCE_LIST_SCHEMA_ID =
  "cd-collab.investigation_reference_list.v1" as const;

export const REFERENCE_VISIBILITIES = ["resolved", "restricted"] as const;
export type ReferenceVisibility = (typeof REFERENCE_VISIBILITIES)[number];

export const REFERENCE_STATES = ["active", "withdrawn"] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];

export const REFERENCE_NOTE_MAX_LENGTH = 600;

/** Shown in place of a title the reader is not authorized to see. */
export const RESTRICTED_REFERENCE_TITLE = "Restricted investigation" as const;

export interface InvestigationReferenceV1 {
  schemaId: typeof INVESTIGATION_REFERENCE_SCHEMA_ID;
  id: string;
  /** The investigation doing the citing. Always readable by the caller. */
  fromInvestigationId: string;
  /** The cited investigation. Readability is re-checked on every read. */
  toInvestigationId: string;
  resourceKind: InvestigationResourceKindV1;
  resourceId: string;
  /** Canonical in-app deep link, derived — never free-typed. */
  locator: string;
  note: string;
  /** Immutable: the cited investigation's title when the citation was made. */
  recordedTitle: string;
  /** Live title, or null when this reader may not open the cited case. */
  currentTitle: string | null;
  visibility: ReferenceVisibility;
  state: ReferenceState;
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  withdrawnAt: string | null;
}

export interface InvestigationReferenceListV1 {
  schemaId: typeof INVESTIGATION_REFERENCE_LIST_SCHEMA_ID;
  investigationId: string;
  /** Citations this investigation makes. */
  outbound: InvestigationReferenceV1[];
  /**
   * Citations other investigations make *of* this one. Present so a reader
   * can see that older work is still being relied on; entries the reader may
   * not open are restricted the same way outbound ones are.
   */
  inbound: InvestigationReferenceV1[];
}

export function isReferenceResourceKind(value: unknown): value is InvestigationResourceKindV1 {
  return (
    typeof value === "string" && (INVESTIGATION_RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

const CONTROL_CHARACTERS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/;

export function normalizeReferenceNote(raw: unknown, path = "$.note"): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ContractViolation(path, "expected string");
  const trimmed = raw.trim();
  if (trimmed.length > REFERENCE_NOTE_MAX_LENGTH) {
    throw new ContractViolation(path, `note exceeds ${REFERENCE_NOTE_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ContractViolation(path, "control characters are not allowed");
  }
  return trimmed;
}

/**
 * The canonical deep link for a citation. Delegates to the shared activity
 * locator so references, the activity feed, and Overview all address the same
 * destination; a reference can never point somewhere the rest of the app
 * would not.
 */
export function referenceLocator(
  toInvestigationId: string,
  resourceKind: InvestigationResourceKindV1,
  resourceId: string,
): string {
  return deriveInvestigationResourcePathname(toInvestigationId, resourceKind, resourceId);
}

/**
 * A citation of a whole investigation addresses the investigation itself, so
 * the resource identity is the investigation id.
 */
export function wholeInvestigationReferenceTarget(toInvestigationId: string): {
  resourceKind: InvestigationResourceKindV1;
  resourceId: string;
} {
  return { resourceKind: "investigation", resourceId: toInvestigationId };
}

export const investigationReferenceShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_REFERENCE_SCHEMA_ID)),
  id: f.req(f.nstr),
  fromInvestigationId: f.req(f.nstr),
  toInvestigationId: f.req(f.nstr),
  resourceKind: f.req(f.en(...INVESTIGATION_RESOURCE_KINDS)),
  resourceId: f.req(f.nstr),
  locator: f.req(f.nstr),
  note: f.req(f.str),
  recordedTitle: f.req(f.nstr),
  currentTitle: f.nul(f.str),
  visibility: f.req(f.en(...REFERENCE_VISIBILITIES)),
  state: f.req(f.en(...REFERENCE_STATES)),
  occurredAt: f.nul(f.str),
  occurredAtPrecision: f.req(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.req(f.en(...OCCURRED_AT_ZONES)),
  recordedAt: f.req(f.nstr),
  recordedBy: f.req(f.nstr),
  recordedByUsername: f.req(f.nstr),
  withdrawnAt: f.nul(f.str),
};

export function parseInvestigationReference(
  raw: unknown,
  path = "$",
): InvestigationReferenceV1 {
  checkObject(path, investigationReferenceShape, raw);
  const parsed = raw as InvestigationReferenceV1;
  if (!isInvestigationUuid(parsed.fromInvestigationId)) {
    throw new ContractViolation(`${path}.fromInvestigationId`, "expected an RFC 4122 UUID");
  }
  if (!isInvestigationUuid(parsed.toInvestigationId)) {
    throw new ContractViolation(`${path}.toInvestigationId`, "expected an RFC 4122 UUID");
  }
  if (parsed.fromInvestigationId === parsed.toInvestigationId) {
    throw new ContractViolation(
      `${path}.toInvestigationId`,
      "a cross-investigation reference must cite a different investigation",
    );
  }
  const derived = referenceLocator(
    parsed.toInvestigationId,
    parsed.resourceKind,
    parsed.resourceId,
  );
  if (parsed.locator !== derived) {
    throw new ContractViolation(
      `${path}.locator`,
      "locator must match the derived resource destination",
    );
  }
  if (parsed.visibility === "restricted" && parsed.currentTitle !== null) {
    throw new ContractViolation(
      `${path}.currentTitle`,
      "a restricted reference must not disclose the cited title",
    );
  }
  if (!isIsoInstant(parsed.recordedAt)) {
    throw new ContractViolation(`${path}.recordedAt`, "expected a full ISO-8601 instant");
  }
  assertOccurrenceFields(parsed, path);
  if (parsed.state === "withdrawn" && parsed.withdrawnAt === null) {
    throw new ContractViolation(`${path}.withdrawnAt`, "a withdrawn reference must record when");
  }
  if (parsed.state === "active" && parsed.withdrawnAt !== null) {
    throw new ContractViolation(`${path}.withdrawnAt`, "an active reference is not withdrawn");
  }
  return parsed;
}

const investigationReferenceListShape: ObjectShape = {
  schemaId: f.req(f.en(INVESTIGATION_REFERENCE_LIST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  outbound: f.req(f.arr(f.obj(investigationReferenceShape))),
  inbound: f.req(f.arr(f.obj(investigationReferenceShape))),
};

export function parseInvestigationReferenceList(
  raw: unknown,
): InvestigationReferenceListV1 {
  checkObject("$", investigationReferenceListShape, raw);
  const parsed = raw as InvestigationReferenceListV1;
  parsed.outbound.forEach((row, index) => {
    parseInvestigationReference(row, `$.outbound[${index}]`);
    if (row.fromInvestigationId !== parsed.investigationId) {
      throw new ContractViolation(
        `$.outbound[${index}].fromInvestigationId`,
        "outbound references must originate from this investigation",
      );
    }
  });
  parsed.inbound.forEach((row, index) => {
    parseInvestigationReference(row, `$.inbound[${index}]`);
    if (row.toInvestigationId !== parsed.investigationId) {
      throw new ContractViolation(
        `$.inbound[${index}].toInvestigationId`,
        "inbound references must cite this investigation",
      );
    }
  });
  return parsed;
}
