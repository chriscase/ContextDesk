/**
 * Browser-safe input for recording a reference to an object that is reachable
 * only through a server-configured provider alias.
 *
 * The alias and relative object key are creation coordinates, not public
 * artifact identity. Responses must continue to use the ordinary evidence
 * envelopes and must never project provider instances or private locations.
 */
import { PRIVACY_CLASSES, type PrivacyClass } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { hasDangerousUnicode } from "./user-profile.js";

export const PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID =
  "cd-collab.provider_bound_reference_create.v1" as const;

export const PROVIDER_BOUND_REFERENCE_LIMITS = Object.freeze({
  providerAliasMaxChars: 64,
  /** Common ceiling that is valid for both filesystem and S3 providers. */
  objectKeyMaxBytes: 1_024,
  objectKeyMaxSegments: 32,
  objectKeySegmentMaxBytes: 255,
  displayNameMaxChars: 240,
  summaryMaxChars: 2_000,
  idempotencyKeyMinChars: 8,
  idempotencyKeyMaxChars: 128,
} as const);

export const PROVIDER_BOUND_REFERENCE_PRIVATE_FIELDS = Object.freeze([
  "providerInstanceId",
  "providerKind",
  "endpoint",
  "bucket",
  "prefix",
  "root",
  "rootDir",
  "credentials",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "locationFingerprint",
  "uri",
  "expectedHash",
  "verificationStatus",
] as const);

export interface ProviderBoundReferenceCreateV1 {
  readonly schemaId: typeof PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID;
  /** Lowercase operator-defined name for a server-private source provider. */
  readonly providerAlias: string;
  /** Canonical relative key inside that configured source; never a URI. */
  readonly objectKey: string;
  readonly displayName?: string;
  readonly summary: string;
  readonly privacyClass: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
  readonly idempotencyKey: string;
}

/** Server obligations that cannot be established by a request parser. */
export const PROVIDER_BOUND_REFERENCE_CONTEXT = Object.freeze({
  authorization: "server_authorizes_reference_creation_for_the_case",
  providerResolution: "server_resolves_alias_to_one_private_provider_instance",
  responsePrivacy:
    "artifact_and_timeline_never_project_object_key_provider_instance_or_private_coordinates",
  observationTarget: "only_private_stored_binding_may_drive_stat_or_head_object",
  existenceClaim: "creation_does_not_claim_that_the_object_exists",
  verificationClaim: "metadata_observation_never_claims_bytes_hash_or_verified_content",
} as const);

export const PROVIDER_BOUND_REFERENCE_IDEMPOTENCY = Object.freeze({
  lookupKey: Object.freeze([
    "authenticatedActorIdentityId",
    "caseId",
    "idempotencyKey",
  ] as const),
  intentFields: Object.freeze([
    "providerAlias",
    "objectKey",
    "displayName",
    "summary",
    "privacyClass",
    "clientTime",
    "sourceId",
  ] as const),
  automaticPostRetry: false as const,
  uncertainOutcome:
    "freeze_exact_request_then_get_reconciliation_before_manual_replay" as const,
} as const);

const createShape: ObjectShape = {
  schemaId: f.req(f.en(PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID)),
  providerAlias: f.req(f.nstr),
  objectKey: f.req(f.nstr),
  displayName: f.opt(f.nstr),
  summary: f.req(f.nstr),
  privacyClass: f.req(f.en(...PRIVACY_CLASSES)),
  clientTime: f.opt(f.nstr),
  sourceId: f.opt(f.nstr),
  idempotencyKey: f.req(f.nstr),
};

const PROVIDER_ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const RESERVED_ROOT_SEGMENTS = new Set([
  "blobs",
  "refs",
  "staging",
  ".staging",
  ".stream-staging",
  ".pending",
  ".contextdesk",
]);
const UTF8 = new TextEncoder();

// C0/DEL, bidi controls, zero-width marks, line separators, and BOM are not
// permitted in provider coordinates or their compact presentation fields.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

function assertPlainDataTree(
  raw: unknown,
  path: string,
  ancestors = new Set<object>(),
): void {
  if (typeof raw !== "object" || raw === null) return;
  const value = raw as object;
  if (ancestors.has(value)) {
    throw new ContractViolation(path, "cyclic values are not valid contract data");
  }
  const array = Array.isArray(raw);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new ContractViolation(path, "expected plain data with no inherited properties");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new ContractViolation(path, "symbol keys are not valid contract data");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array) {
    for (let index = 0; index < raw.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) {
        throw new ContractViolation(`${path}[${index}]`, "sparse arrays are not valid contract data");
      }
    }
  }
  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === "length") continue;
      const fieldPath = array ? `${path}[${key}]` : `${path}.${key}`;
      if (!descriptor.enumerable) {
        throw new ContractViolation(fieldPath, "non-enumerable properties are not valid contract data");
      }
      if (!("value" in descriptor)) {
        throw new ContractViolation(fieldPath, "accessor properties are not valid contract data");
      }
      assertPlainDataTree(descriptor.value, fieldPath, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function exactText(raw: string, path: string, maxChars: number): string {
  if (raw.length === 0 || raw.length > maxChars) {
    throw new ContractViolation(path, `expected 1..${maxChars} characters`);
  }
  if (
    raw.normalize("NFKC").trim() !== raw
    || UNSAFE_TEXT.test(raw)
    || hasDangerousUnicode(raw)
  ) {
    throw new ContractViolation(path, "expected bounded normalized single-line text");
  }
  return raw;
}

function providerAlias(raw: string): string {
  if (!PROVIDER_ALIAS_RE.test(raw)) {
    throw new ContractViolation(
      "$.providerAlias",
      "expected a lowercase ASCII alias of 1..64 letters, digits, or internal hyphens",
    );
  }
  return raw;
}

function instant(raw: string): string {
  const match = INSTANT_RE.exec(raw);
  if (!match) {
    throw new ContractViolation("$.clientTime", "expected an ISO-8601 instant with an explicit offset");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[7] as string;
  const calendarProbe = new Date(Date.UTC(year, month - 1, day));
  const realCalendar =
    month >= 1
    && month <= 12
    && day >= 1
    && day <= 31
    && hour <= 23
    && minute <= 59
    && second <= 59
    && calendarProbe.getUTCFullYear() === year
    && calendarProbe.getUTCMonth() + 1 === month
    && calendarProbe.getUTCDate() === day;
  const realOffset = offset === "Z" || (() => {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    return offsetMinutes <= 59 && offsetHours * 60 + offsetMinutes <= 14 * 60;
  })();
  if (!realCalendar || !realOffset || !Number.isFinite(Date.parse(raw))) {
    throw new ContractViolation("$.clientTime", "expected a real ISO-8601 instant");
  }
  return raw;
}

function objectKey(raw: string): string {
  if (
    raw.normalize("NFC") !== raw
    || raw.trim() !== raw
    || UNSAFE_TEXT.test(raw)
    || hasDangerousUnicode(raw)
    || raw.startsWith("/")
    || raw.endsWith("/")
    || raw.includes("//")
    || raw.includes("\\")
    || raw.includes(":")
    || raw.includes("?")
    || raw.includes("#")
    || raw.includes("%")
    || /^[A-Za-z]:/u.test(raw)
  ) {
    throw new ContractViolation("$.objectKey", "expected a canonical relative provider key");
  }
  const segments = raw.split("/");
  if (
    segments.length === 0
    || segments.length > PROVIDER_BOUND_REFERENCE_LIMITS.objectKeyMaxSegments
    || UTF8.encode(raw).byteLength > PROVIDER_BOUND_REFERENCE_LIMITS.objectKeyMaxBytes
  ) {
    throw new ContractViolation("$.objectKey", "provider key exceeds its size bounds");
  }
  segments.forEach((segment, index) => {
    if (
      segment === ""
      || segment === "."
      || segment === ".."
      || UTF8.encode(segment).byteLength
        > PROVIDER_BOUND_REFERENCE_LIMITS.objectKeySegmentMaxBytes
    ) {
      throw new ContractViolation(`$.objectKey[${index}]`, "invalid provider key segment");
    }
  });
  if (RESERVED_ROOT_SEGMENTS.has(segments[0]!.toLowerCase())) {
    throw new ContractViolation("$.objectKey", "provider key uses a reserved ContextDesk namespace");
  }
  return raw;
}

export function parseProviderBoundReferenceCreate(
  raw: unknown,
): ProviderBoundReferenceCreateV1 {
  assertPlainDataTree(raw, "$");
  checkObject("$", createShape, raw);
  const record = raw as Record<string, unknown>;
  const idempotencyKey = record.idempotencyKey as string;
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw new ContractViolation("$.idempotencyKey", "expected 8..128 safe characters");
  }
  const clientTime = record.clientTime as string | undefined;
  const parsedClientTime = clientTime === undefined ? undefined : instant(clientTime);
  const sourceId = record.sourceId as string | undefined;
  if (sourceId !== undefined && !UUID_RE.test(sourceId)) {
    throw new ContractViolation("$.sourceId", "expected a lowercase UUID");
  }
  const parsed: ProviderBoundReferenceCreateV1 = {
    schemaId: PROVIDER_BOUND_REFERENCE_CREATE_SCHEMA_ID,
    providerAlias: providerAlias(record.providerAlias as string),
    objectKey: objectKey(record.objectKey as string),
    ...(record.displayName === undefined
      ? {}
      : {
          displayName: exactText(
            record.displayName as string,
            "$.displayName",
            PROVIDER_BOUND_REFERENCE_LIMITS.displayNameMaxChars,
          ),
        }),
    summary: exactText(
      record.summary as string,
      "$.summary",
      PROVIDER_BOUND_REFERENCE_LIMITS.summaryMaxChars,
    ),
    privacyClass: record.privacyClass as PrivacyClass,
    ...(parsedClientTime === undefined ? {} : { clientTime: parsedClientTime }),
    ...(sourceId === undefined ? {} : { sourceId }),
    idempotencyKey,
  };
  return Object.freeze(parsed);
}
