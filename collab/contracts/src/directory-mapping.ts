/**
 * Provider-neutral directory claims -> profile field mapping and
 * normalization.
 *
 * This module is pure, synchronous, and framework-free: it never opens a
 * network connection, never handles a password, and never contacts a
 * directory server. Callers (the auth module's login-time sync, or an
 * admin "preview mapping" request) supply already-fetched claims as a
 * plain string map - LDAP attributes and OIDC claims look identical to
 * this module, which is what makes the mapping provider-neutral.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  PROFILE_CONTACT_EMAIL_MAX,
  PROFILE_DISPLAY_NAME_MAX,
  PROFILE_ROLE_TITLE_MAX,
  PROFILE_TEAM_MAX,
  hasDangerousUnicode,
} from "./user-profile.js";

export const DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID =
  "cd-collab.directory_attribute_map.v1" as const;

export const DIRECTORY_MAPPED_FIELDS = [
  "displayName",
  "roleTitle",
  "team",
  "contactEmail",
] as const;
export type DirectoryMappedField = (typeof DIRECTORY_MAPPED_FIELDS)[number];

export const DIRECTORY_ATTRIBUTE_NAME_MAX = 128;

export interface DirectoryAttributeMapV1 {
  schemaId: typeof DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID;
  /** logical profile field -> source claim/attribute name, e.g. "cn", "mail". */
  attributes: Record<DirectoryMappedField, string>;
}

/** Common LDAP attribute names; a reasonable starting point, not a live default. */
export const DEFAULT_DIRECTORY_ATTRIBUTE_MAP: DirectoryAttributeMapV1 = {
  schemaId: DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID,
  attributes: {
    displayName: "cn",
    roleTitle: "title",
    team: "departmentNumber",
    contactEmail: "mail",
  },
};

const FIELD_MAX_LENGTH: Record<DirectoryMappedField, number> = {
  displayName: PROFILE_DISPLAY_NAME_MAX,
  roleTitle: PROFILE_ROLE_TITLE_MAX,
  team: PROFILE_TEAM_MAX,
  contactEmail: PROFILE_CONTACT_EMAIL_MAX,
};

const attributeMapShape: ObjectShape = {
  schemaId: f.req(f.en(DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID)),
  attributes: f.req(
    f.obj(
      Object.fromEntries(
        DIRECTORY_MAPPED_FIELDS.map((field) => [field, f.req(f.nstr)]),
      ) as ObjectShape,
    ),
  ),
};

export function parseDirectoryAttributeMap(raw: unknown): DirectoryAttributeMapV1 {
  checkObject("$", attributeMapShape, raw);
  const map = raw as DirectoryAttributeMapV1;
  const seenAttributeNames = new Set<string>();
  for (const field of DIRECTORY_MAPPED_FIELDS) {
    const attributeName = map.attributes[field].trim();
    if (attributeName.length === 0 || attributeName.length > DIRECTORY_ATTRIBUTE_NAME_MAX) {
      throw new ContractViolation(
        `$.attributes.${field}`,
        `expected 1 to ${DIRECTORY_ATTRIBUTE_NAME_MAX} characters`,
      );
    }
    if (hasDangerousUnicode(attributeName)) {
      throw new ContractViolation(`$.attributes.${field}`, "control characters are not allowed");
    }
    const key = attributeName.toLowerCase();
    if (seenAttributeNames.has(key)) {
      throw new ContractViolation(
        `$.attributes.${field}`,
        "attribute names must be distinct across mapped fields (fail-closed on ambiguous mapping)",
      );
    }
    seenAttributeNames.add(key);
  }
  return map;
}

export function normalizeDirectoryClaimValue(value: string): string {
  return value.normalize("NFKC").trim();
}

export interface DirectoryClaimMappingResultV1 {
  fields: Partial<Record<DirectoryMappedField, string>>;
  /** Fields the map named but which were absent or empty in the supplied claims. */
  skipped: DirectoryMappedField[];
}

/**
 * Never throws on a missing/empty claim - that field is just skipped, since
 * directories legitimately omit optional attributes. Throws ContractViolation
 * on a claim value that IS present but unsafe (oversized or carrying
 * control/invisible characters): callers must treat that as a failed sync
 * for the whole record rather than accept a partially-unsafe profile.
 */
export function mapDirectoryClaimsToProfileFields(
  claims: Readonly<Record<string, string>>,
  map: DirectoryAttributeMapV1,
): DirectoryClaimMappingResultV1 {
  const fields: Partial<Record<DirectoryMappedField, string>> = {};
  const skipped: DirectoryMappedField[] = [];
  for (const field of DIRECTORY_MAPPED_FIELDS) {
    const attributeName = map.attributes[field];
    const raw = claims[attributeName];
    if (raw === undefined) {
      skipped.push(field);
      continue;
    }
    const normalized = normalizeDirectoryClaimValue(raw);
    if (normalized.length === 0) {
      skipped.push(field);
      continue;
    }
    if (normalized.length > FIELD_MAX_LENGTH[field] || hasDangerousUnicode(normalized)) {
      throw new ContractViolation(
        `$.claims.${attributeName}`,
        `directory value for ${field} is unsafe or exceeds ${FIELD_MAX_LENGTH[field]} characters`,
      );
    }
    fields[field] = normalized;
  }
  return { fields, skipped };
}

export const DIRECTORY_IDENTITY_RESOLUTIONS = ["create", "update", "collision"] as const;
export type DirectoryIdentityResolution = (typeof DIRECTORY_IDENTITY_RESOLUTIONS)[number];

export interface DirectoryIdentityLookupV1 {
  incomingUsername: string;
  incomingDirectorySubject: string;
  byUsername: { id: string; directorySubject: string | null } | null;
  byDirectorySubject: { id: string; username: string } | null;
}

/**
 * Fail-closed identity resolution: never silently merges two identities.
 * The store (which owns the two lookups) calls this and refuses the whole
 * sync attempt on "collision" rather than guessing which profile is right.
 */
export function resolveDirectoryIdentityCollision(
  input: DirectoryIdentityLookupV1,
): DirectoryIdentityResolution {
  const { byUsername, byDirectorySubject } = input;
  if (byUsername && byDirectorySubject && byUsername.id !== byDirectorySubject.id) {
    // The username belongs to one profile, the directory subject to a
    // different one: two distinct identities are colliding.
    return "collision";
  }
  if (byDirectorySubject) {
    // Known subject with a consistent (or as-yet-unclaimed) username:
    // update in place. This also covers an upstream username rename.
    return "update";
  }
  if (byUsername) {
    // The username is already taken by a profile with no directory subject
    // (a local account) or a different one. Refuse rather than take over
    // someone else's principal.
    return "collision";
  }
  return "create";
}
