/**
 * Reusable investigation entities, and the links that involve them in a case.
 *
 * An entity is a *label for something an investigation is about*: an
 * organization, a customer, a person, a service, a system, or something that
 * fits none of those. The registry is global and reusable so the same system
 * or counterparty can be named across years of investigations without being
 * retyped — and so a long-running investigation can still say who it concerns
 * after everyone who opened it has moved on.
 *
 * Two boundaries hold this apart from the rest of the workspace and must stay
 * explicit, because both are easy to erode one convenient field at a time:
 *
 * 1. **Entities are not attribution.** The Attribution catalog (`source.ts`)
 *    records *where a piece of information came from* — a person, an external
 *    tool, an internal system, or an honest unknown. The entity registry
 *    records *who or what the investigation is about*. A vendor can be both,
 *    and they stay two separate rows with two separate lifecycles.
 * 2. **Neither registry holds content.** Evidence, logs, email, chat, notes,
 *    and imported output stay investigation-scoped, in the investigation
 *    where they were captured. What is global here is a label, a kind, and an
 *    optional one-line profile — never a payload. ENTITY_PROFILE_MAX_LENGTH
 *    keeps that honest by construction: a field that cannot hold a log will
 *    not quietly become the place someone pastes one.
 *
 * Nothing here is customer-centric. `customer` is one kind among six, and no
 * route, projection, or display path treats it specially.
 *
 * Involvement links carry immutable historical attribution. A link records
 * the label and kind the entity had *at the moment it was linked*. Renaming
 * or retiring an entity later never rewrites what an older investigation
 * said, so history stays readable as it was written; the current registry
 * value travels beside it so a reader can see the drift instead of guessing.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import {
  OCCURRED_AT_PRECISIONS,
  OCCURRED_AT_ZONES,
  assertOccurrenceFields,
  isIsoInstant,
  type OccurredAtPrecision,
  type OccurredAtZone,
} from "./temporal.js";

export const ENTITY_KINDS = [
  "organization",
  "customer",
  "person",
  "service",
  "system",
  "other",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_LIFECYCLES = ["active", "retired"] as const;
export type EntityLifecycle = (typeof ENTITY_LIFECYCLES)[number];

/**
 * How an entity relates to one investigation. Deliberately about the
 * investigation, not about a commercial relationship.
 */
export const INVOLVEMENT_RELATIONSHIPS = [
  "affected",
  "reporting",
  "responsible",
  "observing",
  "referenced",
  "other",
] as const;
export type InvolvementRelationship = (typeof INVOLVEMENT_RELATIONSHIPS)[number];

/** Involvement ends by being released, never by being deleted. */
export const INVOLVEMENT_STATES = ["active", "released"] as const;
export type InvolvementState = (typeof INVOLVEMENT_STATES)[number];

export const ENTITY_SCHEMA_ID = "cd-collab.investigation_entity.v1" as const;
export const ENTITY_LIST_SCHEMA_ID = "cd-collab.investigation_entity_list.v1" as const;
export const INVOLVEMENT_SCHEMA_ID = "cd-collab.investigation_involvement.v1" as const;
export const INVOLVEMENT_LIST_SCHEMA_ID =
  "cd-collab.investigation_involvement_list.v1" as const;
export const INVOLVEMENT_INDEX_SCHEMA_ID =
  "cd-collab.investigation_involvement_index.v1" as const;

export const ENTITY_LABEL_MAX_LENGTH = 200;
/** Small on purpose: a profile is a descriptor, never a place to park content. */
export const ENTITY_PROFILE_MAX_LENGTH = 400;
export const ENTITY_REFERENCE_MAX_LENGTH = 120;
export const INVOLVEMENT_NOTE_MAX_LENGTH = 400;

/**
 * Optional descriptive fields. Absent is the default and stays meaningful:
 * "nobody has written this down" is different from "this is empty".
 */
export interface EntityProfileV1 {
  summary: string;
  /** A local identifier a reader would recognise — a ticket, an account label. */
  reference: string;
}

export interface InvestigationEntityV1 {
  schemaId: typeof ENTITY_SCHEMA_ID;
  id: string;
  kind: EntityKind;
  label: string;
  profile: EntityProfileV1 | null;
  /**
   * Whether this label may leave the tool in a share-safe export. Defaults to
   * owner_only: a name is disclosure until someone decides otherwise.
   */
  privacyClass: PrivacyClass;
  lifecycle: EntityLifecycle;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface InvestigationEntityListV1 {
  schemaId: typeof ENTITY_LIST_SCHEMA_ID;
  entities: InvestigationEntityV1[];
}

export interface InvestigationInvolvementV1 {
  schemaId: typeof INVOLVEMENT_SCHEMA_ID;
  id: string;
  investigationId: string;
  entityId: string;
  relationship: InvolvementRelationship;
  state: InvolvementState;
  note: string;
  /** Immutable historical attribution: the entity as it was named when linked. */
  recordedLabel: string;
  recordedKind: EntityKind;
  /** Live registry values, or null when the entity is no longer resolvable. */
  currentLabel: string | null;
  currentKind: EntityKind | null;
  currentLifecycle: EntityLifecycle | null;
  occurredAt: string | null;
  occurredAtPrecision: OccurredAtPrecision;
  occurredAtZone: OccurredAtZone;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  releasedAt: string | null;
}

export interface InvestigationInvolvementListV1 {
  schemaId: typeof INVOLVEMENT_LIST_SCHEMA_ID;
  investigationId: string;
  involvements: InvestigationInvolvementV1[];
}

/** Entity to investigation index backing the investigation-list filter. */
export interface InvolvementIndexEntryV1 {
  investigationId: string;
  entityId: string;
  relationship: InvolvementRelationship;
  state: InvolvementState;
}

export interface InvolvementIndexV1 {
  schemaId: typeof INVOLVEMENT_INDEX_SCHEMA_ID;
  entries: InvolvementIndexEntryV1[];
}

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}

export function isEntityLifecycle(value: unknown): value is EntityLifecycle {
  return typeof value === "string" && (ENTITY_LIFECYCLES as readonly string[]).includes(value);
}

export function isInvolvementRelationship(value: unknown): value is InvolvementRelationship {
  return (
    typeof value === "string" && (INVOLVEMENT_RELATIONSHIPS as readonly string[]).includes(value)
  );
}

/** Control characters and separators that must never enter a stored label. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/;

/**
 * A label is a single line of human text. Newlines and control characters are
 * rejected rather than stripped: silently rewriting what someone typed into a
 * historical record is worse than refusing it.
 */
export function normalizeEntityLabel(raw: unknown, path = "$.label"): string {
  if (typeof raw !== "string") throw new ContractViolation(path, "expected string");
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new ContractViolation(path, "expected a non-empty label");
  if (trimmed.length > ENTITY_LABEL_MAX_LENGTH) {
    throw new ContractViolation(path, `label exceeds ${ENTITY_LABEL_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ContractViolation(path, "label must be a single line of text");
  }
  return trimmed;
}

function normalizeBoundedText(raw: unknown, max: number, path: string): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ContractViolation(path, "expected string");
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    throw new ContractViolation(
      path,
      `exceeds ${max} characters; investigation content belongs in the investigation, not the registry`,
    );
  }
  // Single-line on purpose, newlines included. A descriptor field that
  // accepts line breaks is where a pasted log ends up, and that is exactly
  // the content this registry must not hold.
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ContractViolation(
      path,
      "must be a single line; investigation content belongs in the investigation, not the registry",
    );
  }
  return trimmed;
}

export function normalizeEntityProfile(raw: unknown, path = "$.profile"): EntityProfileV1 | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "summary" && key !== "reference") {
      throw new ContractViolation(`${path}.${key}`, "unknown key (contract drift)");
    }
  }
  const summary = normalizeBoundedText(record.summary, ENTITY_PROFILE_MAX_LENGTH, `${path}.summary`);
  const reference = normalizeBoundedText(
    record.reference,
    ENTITY_REFERENCE_MAX_LENGTH,
    `${path}.reference`,
  );
  if (summary === "" && reference === "") return null;
  return { summary, reference };
}

export function normalizeInvolvementNote(raw: unknown, path = "$.note"): string {
  return normalizeBoundedText(raw, INVOLVEMENT_NOTE_MAX_LENGTH, path);
}

/**
 * True when the registry has moved on since this involvement was recorded.
 * The UI shows both values rather than silently preferring either one.
 */
export function involvementLabelDrifted(link: {
  recordedLabel: string;
  recordedKind: EntityKind;
  currentLabel: string | null;
  currentKind: EntityKind | null;
}): boolean {
  if (link.currentLabel === null) return false;
  return link.currentLabel !== link.recordedLabel || link.currentKind !== link.recordedKind;
}

const profileShape: ObjectShape = {
  summary: f.req(f.str),
  reference: f.req(f.str),
};

export const entityShape: ObjectShape = {
  schemaId: f.req(f.en(ENTITY_SCHEMA_ID)),
  id: f.req(f.nstr),
  kind: f.req(f.en(...ENTITY_KINDS)),
  label: f.req(f.nstr),
  profile: f.nul(f.obj(profileShape)),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  lifecycle: f.req(f.en(...ENTITY_LIFECYCLES)),
  createdAt: f.req(f.nstr),
  createdBy: f.req(f.nstr),
  updatedAt: f.req(f.nstr),
};

export function parseInvestigationEntity(raw: unknown, path = "$"): InvestigationEntityV1 {
  checkObject(path, entityShape, raw);
  const parsed = raw as InvestigationEntityV1;
  normalizeEntityLabel(parsed.label, `${path}.label`);
  if (!isIsoInstant(parsed.createdAt)) {
    throw new ContractViolation(`${path}.createdAt`, "expected an ISO-8601 instant");
  }
  if (!isIsoInstant(parsed.updatedAt)) {
    throw new ContractViolation(`${path}.updatedAt`, "expected an ISO-8601 instant");
  }
  if (parsed.profile) {
    if (parsed.profile.summary.length > ENTITY_PROFILE_MAX_LENGTH) {
      throw new ContractViolation(`${path}.profile.summary`, "profile summary is too long");
    }
    if (parsed.profile.reference.length > ENTITY_REFERENCE_MAX_LENGTH) {
      throw new ContractViolation(`${path}.profile.reference`, "profile reference is too long");
    }
  }
  return parsed;
}

const entityListShape: ObjectShape = {
  schemaId: f.req(f.en(ENTITY_LIST_SCHEMA_ID)),
  entities: f.req(f.arr(f.obj(entityShape))),
};

export function parseInvestigationEntityList(raw: unknown): InvestigationEntityListV1 {
  checkObject("$", entityListShape, raw);
  const parsed = raw as InvestigationEntityListV1;
  parsed.entities.forEach((entity, index) =>
    parseInvestigationEntity(entity, `$.entities[${index}]`),
  );
  return parsed;
}

export const involvementShape: ObjectShape = {
  schemaId: f.req(f.en(INVOLVEMENT_SCHEMA_ID)),
  id: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  entityId: f.req(f.nstr),
  relationship: f.req(f.en(...INVOLVEMENT_RELATIONSHIPS)),
  state: f.req(f.en(...INVOLVEMENT_STATES)),
  note: f.req(f.str),
  recordedLabel: f.req(f.nstr),
  recordedKind: f.req(f.en(...ENTITY_KINDS)),
  currentLabel: f.nul(f.str),
  currentKind: f.nul(f.en(...ENTITY_KINDS)),
  currentLifecycle: f.nul(f.en(...ENTITY_LIFECYCLES)),
  occurredAt: f.nul(f.str),
  occurredAtPrecision: f.req(f.en(...OCCURRED_AT_PRECISIONS)),
  occurredAtZone: f.req(f.en(...OCCURRED_AT_ZONES)),
  recordedAt: f.req(f.nstr),
  recordedBy: f.req(f.nstr),
  recordedByUsername: f.req(f.nstr),
  releasedAt: f.nul(f.str),
};

export function parseInvestigationInvolvement(
  raw: unknown,
  path = "$",
): InvestigationInvolvementV1 {
  checkObject(path, involvementShape, raw);
  const parsed = raw as InvestigationInvolvementV1;
  if (!isIsoInstant(parsed.recordedAt)) {
    throw new ContractViolation(`${path}.recordedAt`, "expected a full ISO-8601 instant");
  }
  assertOccurrenceFields(parsed, path);
  if (parsed.state === "released" && parsed.releasedAt === null) {
    throw new ContractViolation(`${path}.releasedAt`, "a released involvement must record when");
  }
  if (parsed.state === "active" && parsed.releasedAt !== null) {
    throw new ContractViolation(`${path}.releasedAt`, "an active involvement is not released");
  }
  return parsed;
}

const involvementListShape: ObjectShape = {
  schemaId: f.req(f.en(INVOLVEMENT_LIST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  involvements: f.req(f.arr(f.obj(involvementShape))),
};

export function parseInvestigationInvolvementList(
  raw: unknown,
): InvestigationInvolvementListV1 {
  checkObject("$", involvementListShape, raw);
  const parsed = raw as InvestigationInvolvementListV1;
  parsed.involvements.forEach((row, index) => {
    parseInvestigationInvolvement(row, `$.involvements[${index}]`);
    if (row.investigationId !== parsed.investigationId) {
      throw new ContractViolation(
        `$.involvements[${index}].investigationId`,
        "involvement belongs to a different investigation",
      );
    }
  });
  return parsed;
}

const involvementIndexEntryShape: ObjectShape = {
  investigationId: f.req(f.nstr),
  entityId: f.req(f.nstr),
  relationship: f.req(f.en(...INVOLVEMENT_RELATIONSHIPS)),
  state: f.req(f.en(...INVOLVEMENT_STATES)),
};

const involvementIndexShape: ObjectShape = {
  schemaId: f.req(f.en(INVOLVEMENT_INDEX_SCHEMA_ID)),
  entries: f.req(f.arr(f.obj(involvementIndexEntryShape))),
};

export function parseInvolvementIndex(raw: unknown): InvolvementIndexV1 {
  checkObject("$", involvementIndexShape, raw);
  return raw as InvolvementIndexV1;
}
