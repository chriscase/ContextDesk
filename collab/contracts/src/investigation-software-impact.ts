/**
 * Investigation-scoped software impact records.
 *
 * Situation context (a later lane) can name one product/version/build this
 * investigation is *about*. Impact records answer a different question: which
 * named software identities are observed, suspected, confirmed, or ruled out
 * as affected. One investigation routinely carries several of those judgments
 * at once, and they change as evidence arrives.
 *
 * Two boundaries are load-bearing:
 *
 * 1. **No invented build ordering.** Records are listed in recording order.
 *    Version strings, build ids, and dates in the labels are display text.
 *    Nothing here compares them, ranks them, or infers that one build is
 *    later than another.
 * 2. **No content.** Product, version, build, component, and environment are
 *    single-line labels. Evidence, logs, email, chat, and notes stay in the
 *    investigation stages where they were captured.
 *
 * Status is a human epistemic claim, never inferred from a model lane, a
 * majority, or a version number. `ruled_out` is a first-class status, not the
 * absence of a row.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { isIsoInstant } from "./temporal.js";

export const SOFTWARE_IMPACT_SCHEMA_ID = "cd-collab.software_impact.v1" as const;
export const SOFTWARE_IMPACT_LIST_SCHEMA_ID = "cd-collab.software_impact_list.v1" as const;
export const SOFTWARE_IMPACT_SUGGESTIONS_SCHEMA_ID =
  "cd-collab.software_impact_suggestions.v1" as const;

export const SOFTWARE_IMPACT_STATUSES = [
  "observed",
  "suspected",
  "confirmed",
  "ruled_out",
] as const;
export type SoftwareImpactStatus = (typeof SOFTWARE_IMPACT_STATUSES)[number];

export const SOFTWARE_IMPACT_STATES = ["active", "released"] as const;
export type SoftwareImpactState = (typeof SOFTWARE_IMPACT_STATES)[number];

export const SOFTWARE_IMPACT_FIELDS = [
  "productName",
  "version",
  "build",
  "component",
  "environment",
] as const;
export type SoftwareImpactField = (typeof SOFTWARE_IMPACT_FIELDS)[number];

/** Recording order is the only honest list order this contract claims. */
export const SOFTWARE_IMPACT_ORDERING = "recorded_at" as const;
export type SoftwareImpactOrdering = typeof SOFTWARE_IMPACT_ORDERING;

export const SOFTWARE_IMPACT_VALUE_MAX_LENGTH = 200;
export const SOFTWARE_IMPACT_NOTE_MAX_LENGTH = 400;

export interface SoftwareImpactIdentityV1 {
  productName: string;
  version: string;
  build: string;
  component: string;
  environment: string;
}

export interface SoftwareImpactV1 extends SoftwareImpactIdentityV1 {
  schemaId: typeof SOFTWARE_IMPACT_SCHEMA_ID;
  id: string;
  investigationId: string;
  status: SoftwareImpactStatus;
  note: string;
  state: SoftwareImpactState;
  recordedAt: string;
  recordedBy: string;
  recordedByUsername: string;
  updatedAt: string;
  releasedAt: string | null;
}

export interface SoftwareImpactListV1 {
  schemaId: typeof SOFTWARE_IMPACT_LIST_SCHEMA_ID;
  investigationId: string;
  ordering: SoftwareImpactOrdering;
  records: SoftwareImpactV1[];
}

export interface SoftwareImpactSuggestionsV1 {
  schemaId: typeof SOFTWARE_IMPACT_SUGGESTIONS_SCHEMA_ID;
  field: SoftwareImpactField;
  values: string[];
}

export function isSoftwareImpactStatus(value: unknown): value is SoftwareImpactStatus {
  return (
    typeof value === "string" && (SOFTWARE_IMPACT_STATUSES as readonly string[]).includes(value)
  );
}

export function isSoftwareImpactField(value: unknown): value is SoftwareImpactField {
  return typeof value === "string" && (SOFTWARE_IMPACT_FIELDS as readonly string[]).includes(value);
}

// Matching control characters is the point: stored labels stay single-line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/;

export function normalizeSoftwareImpactValue(raw: unknown, path: string): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ContractViolation(path, "expected string");
  const trimmed = raw.trim();
  if (trimmed.length > SOFTWARE_IMPACT_VALUE_MAX_LENGTH) {
    throw new ContractViolation(path, `exceeds ${SOFTWARE_IMPACT_VALUE_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ContractViolation(path, "must be a single line of text");
  }
  return trimmed;
}

export function normalizeSoftwareImpactNote(raw: unknown, path = "$.note"): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new ContractViolation(path, "expected string");
  const trimmed = raw.trim();
  if (trimmed.length > SOFTWARE_IMPACT_NOTE_MAX_LENGTH) {
    throw new ContractViolation(path, `exceeds ${SOFTWARE_IMPACT_NOTE_MAX_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ContractViolation(path, "must be a single line of text");
  }
  return trimmed;
}

export function normalizeSoftwareImpactIdentity(
  raw: unknown,
  path = "$",
): SoftwareImpactIdentityV1 {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractViolation(path, "expected object");
  }
  const record = raw as Record<string, unknown>;
  const identity: SoftwareImpactIdentityV1 = {
    productName: normalizeSoftwareImpactValue(record.productName, `${path}.productName`),
    version: normalizeSoftwareImpactValue(record.version, `${path}.version`),
    build: normalizeSoftwareImpactValue(record.build, `${path}.build`),
    component: normalizeSoftwareImpactValue(record.component, `${path}.component`),
    environment: normalizeSoftwareImpactValue(record.environment, `${path}.environment`),
  };
  if (!SOFTWARE_IMPACT_FIELDS.some((field) => identity[field] !== "")) {
    throw new ContractViolation(
      path,
      "at least one of product, version, build, component, or environment is required",
    );
  }
  return identity;
}

/**
 * Equality key for one named software identity inside one investigation.
 * Comparison is case-insensitive and whitespace-trimmed so "Build 007" and
 * "build 007" are the same claim. It is not a version comparator.
 */
export function softwareImpactIdentityKey(identity: SoftwareImpactIdentityV1): string {
  return SOFTWARE_IMPACT_FIELDS.map((field) => identity[field].toLocaleLowerCase()).join("\u001f");
}

/** Human-readable identity. Field order is a display convention, not lineage. */
export function softwareImpactDisplayLabel(identity: SoftwareImpactIdentityV1): string {
  const parts: string[] = [];
  if (identity.productName) parts.push(identity.productName);
  if (identity.version) parts.push(identity.version);
  if (identity.build) parts.push(identity.build);
  if (identity.component) parts.push(identity.component);
  if (identity.environment) parts.push(identity.environment);
  return parts.join(" · ");
}

const impactShape: ObjectShape = {
  schemaId: f.req(f.en(SOFTWARE_IMPACT_SCHEMA_ID)),
  id: f.req(f.nstr),
  investigationId: f.req(f.nstr),
  productName: f.req(f.str),
  version: f.req(f.str),
  build: f.req(f.str),
  component: f.req(f.str),
  environment: f.req(f.str),
  status: f.req(f.en(...SOFTWARE_IMPACT_STATUSES)),
  note: f.req(f.str),
  state: f.req(f.en(...SOFTWARE_IMPACT_STATES)),
  recordedAt: f.req(f.nstr),
  recordedBy: f.req(f.nstr),
  recordedByUsername: f.req(f.nstr),
  updatedAt: f.req(f.nstr),
  releasedAt: f.nul(f.str),
};

export function parseSoftwareImpact(raw: unknown, path = "$"): SoftwareImpactV1 {
  checkObject(path, impactShape, raw);
  const parsed = raw as SoftwareImpactV1;
  normalizeSoftwareImpactIdentity(parsed, path);
  normalizeSoftwareImpactNote(parsed.note, `${path}.note`);
  if (!isIsoInstant(parsed.recordedAt)) {
    throw new ContractViolation(`${path}.recordedAt`, "expected an ISO-8601 instant");
  }
  if (!isIsoInstant(parsed.updatedAt)) {
    throw new ContractViolation(`${path}.updatedAt`, "expected an ISO-8601 instant");
  }
  if (parsed.releasedAt !== null && !isIsoInstant(parsed.releasedAt)) {
    throw new ContractViolation(`${path}.releasedAt`, "expected an ISO-8601 instant");
  }
  if (parsed.state === "released" && parsed.releasedAt === null) {
    throw new ContractViolation(`${path}.releasedAt`, "a released record must say when");
  }
  if (parsed.state === "active" && parsed.releasedAt !== null) {
    throw new ContractViolation(`${path}.releasedAt`, "an active record is not released");
  }
  return parsed;
}

const listShape: ObjectShape = {
  schemaId: f.req(f.en(SOFTWARE_IMPACT_LIST_SCHEMA_ID)),
  investigationId: f.req(f.nstr),
  ordering: f.req(f.en(SOFTWARE_IMPACT_ORDERING)),
  records: f.req(f.arr(f.obj(impactShape))),
};

export function parseSoftwareImpactList(raw: unknown): SoftwareImpactListV1 {
  checkObject("$", listShape, raw);
  const parsed = raw as SoftwareImpactListV1;
  parsed.records.forEach((row, index) => {
    parseSoftwareImpact(row, `$.records[${index}]`);
    if (row.investigationId !== parsed.investigationId) {
      throw new ContractViolation(
        `$.records[${index}].investigationId`,
        "record belongs to a different investigation",
      );
    }
  });
  return parsed;
}

const suggestionsShape: ObjectShape = {
  schemaId: f.req(f.en(SOFTWARE_IMPACT_SUGGESTIONS_SCHEMA_ID)),
  field: f.req(f.en(...SOFTWARE_IMPACT_FIELDS)),
  values: f.req(f.arr(f.str)),
};

export function parseSoftwareImpactSuggestions(raw: unknown): SoftwareImpactSuggestionsV1 {
  checkObject("$", suggestionsShape, raw);
  const parsed = raw as SoftwareImpactSuggestionsV1;
  parsed.values.forEach((value, index) => {
    normalizeSoftwareImpactValue(value, `$.values[${index}]`);
  });
  return parsed;
}
