/**
 * Canonical installation-scoped user profile.
 *
 * Deliberately split in two:
 *  - AttributionIdentityV1 (auth.ts IdentityV1: id/username/displayName) is
 *    the immutable value already captured into durable records (comments,
 *    timeline events, decisions, ...). It never changes shape and this
 *    module does not redefine it.
 *  - UserProfileV1 here is the mutable, richer, *current* display profile:
 *    safe to change over time, never retroactively rewrites past attribution.
 *
 * Directory-sourced fields (displayName/roleTitle/team/contactEmail) are
 * read-only to the person they describe whenever provenance is "ldap" or
 * "oidc" - the directory owns them. Local-only fields (contactOther,
 * avatar, customAttributes) are always self-editable. isProfileFieldSelfEditable
 * and assertProfileUpdateAllowed are the single source of truth for that
 * rule; self-service and admin routes both call them instead of duplicating
 * the logic.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";

export const USER_PROFILE_CONTRACT_VERSION = 1 as const;

export const USER_PROFILE_SCHEMA_ID = "cd-collab.user_profile.v1" as const;
export const USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID =
  "cd-collab.user_profile_update_request.v1" as const;
export const USER_PROFILE_ERROR_SCHEMA_ID = "cd-collab.user_profile_error.v1" as const;

export const PROFILE_PROVENANCE = ["local", "ldap", "oidc", "imported_historical"] as const;
export type ProfileProvenance = (typeof PROFILE_PROVENANCE)[number];

export const PROFILE_STATUS = ["active", "suspended", "disabled"] as const;
export type ProfileStatus = (typeof PROFILE_STATUS)[number];

export const AVATAR_KINDS = ["initials", "url"] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

/**
 * Explicit directory-sync state, independent of provenance: a local profile
 * is always "not_synced"; an ldap/oidc profile moves synced -> stale -> error
 * as login-time sync succeeds, is skipped, or fails. Never inferred from
 * timestamps alone so an admin can see *why* a profile looks out of date.
 */
export const DIRECTORY_SYNC_STATUSES = [
  "not_synced",
  "synced",
  "stale",
  "error",
  "disabled",
] as const;
export type DirectorySyncStatus = (typeof DIRECTORY_SYNC_STATUSES)[number];

export const PROFILE_DISPLAY_NAME_MAX = 160;
export const PROFILE_ROLE_TITLE_MAX = 120;
export const PROFILE_TEAM_MAX = 120;
export const PROFILE_CONTACT_EMAIL_MAX = 254;
export const PROFILE_CONTACT_OTHER_MAX = 200;
export const PROFILE_AVATAR_VALUE_MAX = 2048;
export const PROFILE_DIRECTORY_SUBJECT_MAX = 512;
export const PROFILE_CUSTOM_ATTR_MAX_COUNT = 16;
export const PROFILE_CUSTOM_ATTR_KEY_MAX = 64;
export const PROFILE_CUSTOM_ATTR_VALUE_MAX = 512;
export const PROFILE_CUSTOM_ATTR_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * C0/DEL controls plus zero-width, bidi-embedding/override/isolate, and BOM
 * formatting characters. Deliberately expressed as numeric code-point ranges
 * rather than a regex literal: raw invisible/bidi-control characters must
 * never sit directly in source (unauditable, encoding-fragile, and easy to
 * corrupt in transit), and numeric ranges keep every blocked character
 * visible through its comment instead. This blocks the concrete
 * confusable/spoofing vectors named in the threat list (invisible characters
 * that make two names render identically, or that reverse displayed text
 * order). It is NOT full Unicode confusable-skeleton / homoglyph detection -
 * that is a documented non-claim, not a shipped guarantee.
 */
const DANGEROUS_UNICODE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x7f], // DEL
  [0x200b, 0x200f], // zero-width space/joiner/non-joiner, left-to-right mark, right-to-left mark
  [0x202a, 0x202e], // bidi embedding/override (LRE/RLE/PDF/LRO/RLO)
  [0x2060, 0x2069], // word joiner, invisible operators, bidi isolates (LRI/RLI/FSI/PDI)
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

export function hasDangerousUnicode(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    for (const [start, end] of DANGEROUS_UNICODE_RANGES) {
      if (code >= start && code <= end) return true;
    }
  }
  return false;
}

function assertSafeProfileText(path: string, value: string, maxLen: number): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new ContractViolation(path, "expected non-empty text");
  }
  if (normalized.length > maxLen) {
    throw new ContractViolation(path, `expected at most ${maxLen} normalized characters`);
  }
  if (hasDangerousUnicode(normalized)) {
    throw new ContractViolation(
      path,
      "control characters or invisible/bidi-override formatting characters are not allowed",
    );
  }
  return normalized;
}

export function normalizeDisplayName(value: string): string {
  return assertSafeProfileText("$.displayName", value, PROFILE_DISPLAY_NAME_MAX);
}

export interface AvatarMetaV1 {
  kind: AvatarKind;
  value: string;
}

function assertAvatar(path: string, avatar: AvatarMetaV1): AvatarMetaV1 {
  const value = avatar.value.trim();
  if (value.length === 0 || value.length > PROFILE_AVATAR_VALUE_MAX) {
    throw new ContractViolation(
      `${path}.value`,
      `expected 1 to ${PROFILE_AVATAR_VALUE_MAX} characters`,
    );
  }
  if (hasDangerousUnicode(value)) {
    throw new ContractViolation(`${path}.value`, "control characters are not allowed");
  }
  if (avatar.kind === "initials" && [...value].length > 4) {
    throw new ContractViolation(`${path}.value`, "initials must be at most 4 characters");
  }
  if (avatar.kind === "url") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ContractViolation(`${path}.value`, "expected an absolute URL");
    }
    if (parsed.protocol !== "https:") {
      throw new ContractViolation(`${path}.value`, "expected an https URL");
    }
  }
  return { kind: avatar.kind, value };
}

export interface CustomAttributeV1 {
  key: string;
  value: string;
}

export function normalizeCustomAttributes(
  path: string,
  attributes: readonly CustomAttributeV1[],
): CustomAttributeV1[] {
  if (attributes.length > PROFILE_CUSTOM_ATTR_MAX_COUNT) {
    throw new ContractViolation(
      path,
      `expected at most ${PROFILE_CUSTOM_ATTR_MAX_COUNT} custom attributes`,
    );
  }
  const seen = new Set<string>();
  const normalized = attributes.map((attribute, index) => {
    const key = attribute.key.trim();
    if (!PROFILE_CUSTOM_ATTR_KEY_PATTERN.test(key)) {
      throw new ContractViolation(
        `${path}[${index}].key`,
        `expected 1 to ${PROFILE_CUSTOM_ATTR_KEY_MAX} ASCII letters, digits, "_", or "-", starting with a letter or digit`,
      );
    }
    if (seen.has(key)) {
      throw new ContractViolation(`${path}[${index}].key`, "duplicate custom attribute key");
    }
    seen.add(key);
    const value = assertSafeProfileText(
      `${path}[${index}].value`,
      attribute.value,
      PROFILE_CUSTOM_ATTR_VALUE_MAX,
    );
    return { key, value };
  });
  normalized.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return normalized;
}

export interface UserProfileV1 {
  schemaId: typeof USER_PROFILE_SCHEMA_ID;
  id: string;
  username: string;
  displayName: string;
  roleTitle: string | null;
  team: string | null;
  contactEmail: string | null;
  contactOther: string | null;
  avatar: AvatarMetaV1 | null;
  status: ProfileStatus;
  provenance: ProfileProvenance;
  /** LDAP DN or OIDC subject; null for local and (usually) imported_historical profiles. */
  directorySubject: string | null;
  directorySyncStatus: DirectorySyncStatus;
  directorySyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  customAttributes: CustomAttributeV1[];
  /** Optimistic-concurrency token; callers must echo it back as expectedRevision. */
  revision: number;
}

const avatarShape: ObjectShape = {
  kind: f.req(f.en(...AVATAR_KINDS)),
  value: f.req(f.nstr),
};

const customAttributeShape: ObjectShape = {
  key: f.req(f.nstr),
  value: f.req(f.str),
};

const profileShape: ObjectShape = {
  schemaId: f.req(f.en(USER_PROFILE_SCHEMA_ID)),
  id: f.req(f.nstr),
  username: f.req(f.nstr),
  displayName: f.req(f.nstr),
  roleTitle: f.nul(f.str),
  team: f.nul(f.str),
  contactEmail: f.nul(f.str),
  contactOther: f.nul(f.str),
  avatar: f.nul(f.obj(avatarShape)),
  status: f.req(f.en(...PROFILE_STATUS)),
  provenance: f.req(f.en(...PROFILE_PROVENANCE)),
  directorySubject: f.nul(f.str),
  directorySyncStatus: f.req(f.en(...DIRECTORY_SYNC_STATUSES)),
  directorySyncedAt: f.nul(f.str),
  createdAt: f.req(f.nstr),
  updatedAt: f.req(f.nstr),
  lastSeenAt: f.nul(f.str),
  customAttributes: f.req(f.arr(f.obj(customAttributeShape))),
  revision: f.req(f.u64),
};

export function parseUserProfile(raw: unknown): UserProfileV1 {
  checkObject("$", profileShape, raw);
  const profile = raw as UserProfileV1;
  if (profile.displayName !== normalizeDisplayName(profile.displayName)) {
    throw new ContractViolation("$.displayName", "display name is not normalized");
  }
  if (profile.avatar) assertAvatar("$.avatar", profile.avatar);
  const normalizedAttrs = normalizeCustomAttributes("$.customAttributes", profile.customAttributes);
  if (JSON.stringify(normalizedAttrs) !== JSON.stringify(profile.customAttributes)) {
    throw new ContractViolation("$.customAttributes", "custom attributes are not normalized");
  }
  if (profile.provenance !== "local" && profile.directorySubject === null) {
    throw new ContractViolation(
      "$.directorySubject",
      "directory-provenance profiles require a directory subject",
    );
  }
  if (profile.provenance === "local" && profile.directorySyncStatus !== "not_synced") {
    throw new ContractViolation(
      "$.directorySyncStatus",
      'local profiles must report directorySyncStatus "not_synced"',
    );
  }
  return profile;
}

/**
 * Fields the directory owns once provenance is ldap/oidc. Local profiles
 * (and, for display purposes only, imported_historical stubs, which are
 * never self-editable regardless - see isProfileFieldSelfEditable) treat
 * the same fields as ordinary local-editable data.
 */
export const DIRECTORY_SYNCED_FIELDS = [
  "displayName",
  "roleTitle",
  "team",
  "contactEmail",
] as const;
export type DirectorySyncedField = (typeof DIRECTORY_SYNCED_FIELDS)[number];

/** Always local-editable by the profile owner, regardless of provenance. */
export const LOCAL_ONLY_FIELDS = ["contactOther", "avatar", "customAttributes"] as const;
export type LocalOnlyField = (typeof LOCAL_ONLY_FIELDS)[number];

export type SelfEditableField = DirectorySyncedField | LocalOnlyField;

export function isProfileFieldSelfEditable(
  field: SelfEditableField,
  provenance: ProfileProvenance,
): boolean {
  if (provenance === "imported_historical") return false;
  if ((LOCAL_ONLY_FIELDS as readonly string[]).includes(field)) return true;
  return provenance === "local";
}

export interface UserProfileUpdateRequestV1 {
  schemaId: typeof USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID;
  expectedRevision: number;
  displayName?: string;
  roleTitle?: string | null;
  team?: string | null;
  contactEmail?: string | null;
  contactOther?: string | null;
  avatar?: AvatarMetaV1 | null;
  customAttributes?: CustomAttributeV1[];
}

const updateRequestShape: ObjectShape = {
  schemaId: f.req(f.en(USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  displayName: f.opt(f.nstr),
  roleTitle: f.optNul(f.str),
  team: f.optNul(f.str),
  contactEmail: f.optNul(f.str),
  contactOther: f.optNul(f.str),
  avatar: f.optNul(f.obj(avatarShape)),
  customAttributes: f.opt(f.arr(f.obj(customAttributeShape))),
};

export function parseUserProfileUpdateRequest(raw: unknown): UserProfileUpdateRequestV1 {
  checkObject("$", updateRequestShape, raw);
  const request = raw as UserProfileUpdateRequestV1;
  const normalized: UserProfileUpdateRequestV1 = {
    schemaId: request.schemaId,
    expectedRevision: request.expectedRevision,
  };
  if (request.displayName !== undefined) {
    normalized.displayName = normalizeDisplayName(request.displayName);
  }
  if (request.roleTitle !== undefined) {
    normalized.roleTitle =
      request.roleTitle === null
        ? null
        : assertSafeProfileText("$.roleTitle", request.roleTitle, PROFILE_ROLE_TITLE_MAX);
  }
  if (request.team !== undefined) {
    normalized.team =
      request.team === null ? null : assertSafeProfileText("$.team", request.team, PROFILE_TEAM_MAX);
  }
  if (request.contactEmail !== undefined) {
    normalized.contactEmail =
      request.contactEmail === null
        ? null
        : assertContactEmail("$.contactEmail", request.contactEmail);
  }
  if (request.contactOther !== undefined) {
    normalized.contactOther =
      request.contactOther === null
        ? null
        : assertSafeProfileText("$.contactOther", request.contactOther, PROFILE_CONTACT_OTHER_MAX);
  }
  if (request.avatar !== undefined) {
    normalized.avatar = request.avatar === null ? null : assertAvatar("$.avatar", request.avatar);
  }
  if (request.customAttributes !== undefined) {
    normalized.customAttributes = normalizeCustomAttributes(
      "$.customAttributes",
      request.customAttributes,
    );
  }
  return normalized;
}

function assertContactEmail(path: string, value: string): string {
  const normalized = assertSafeProfileText(path, value, PROFILE_CONTACT_EMAIL_MAX);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ContractViolation(path, "expected an email address");
  }
  return normalized;
}

/**
 * The single source of truth for "can this update be applied": throws
 * naming the first disallowed field instead of silently dropping it, so a
 * rejected request never looks like a partial success. Self-service and
 * admin-on-behalf-of-self routes both call this against the same request
 * contract rather than re-deriving the rule.
 */
export function assertProfileUpdateAllowed(
  current: Pick<UserProfileV1, "provenance">,
  request: UserProfileUpdateRequestV1,
): void {
  for (const field of DIRECTORY_SYNCED_FIELDS) {
    if (field in request && request[field] !== undefined) {
      if (!isProfileFieldSelfEditable(field, current.provenance)) {
        throw new ContractViolation(
          `$.${field}`,
          `field is directory-owned for provenance "${current.provenance}" and is read-only`,
        );
      }
    }
  }
}

export type UserProfileErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "stale_revision"
  | "field_not_editable"
  | "duplicate_principal"
  | "suspended"
  | "unavailable";

export interface UserProfileErrorV1 {
  schemaId: typeof USER_PROFILE_ERROR_SCHEMA_ID;
  error: UserProfileErrorCode;
}

const errorShape: ObjectShape = {
  schemaId: f.req(f.en(USER_PROFILE_ERROR_SCHEMA_ID)),
  error: f.req(
    f.en(
      "invalid_request",
      "not_found",
      "forbidden",
      "stale_revision",
      "field_not_editable",
      "duplicate_principal",
      "suspended",
      "unavailable",
    ),
  ),
};

export function parseUserProfileError(raw: unknown): UserProfileErrorV1 {
  checkObject("$", errorShape, raw);
  return raw as UserProfileErrorV1;
}
