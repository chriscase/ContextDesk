import { Buffer } from "node:buffer";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  LDAP_USER_RESOLUTION_MODES,
  assertLdapAttributeName,
  assertLdapNetbiosDomain,
  assertLdapUpnSuffix,
  parseLdapUserResolutionModes,
  type LdapUserResolutionMode,
} from "./ldap-admin.js";

export const SETUP_CLAIM_REQUEST_SCHEMA_ID =
  "cd-collab.setup_claim_request.v1" as const;
export const SETUP_TRANSITION_REQUEST_SCHEMA_ID =
  "cd-collab.setup_transition_request.v1" as const;
export const SETUP_STATE_SCHEMA_ID = "cd-collab.setup_state.v1" as const;
export const SETUP_STATUS_SCHEMA_ID = "cd-collab.setup_status.v1" as const;
export const SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID =
  "cd-collab.setup_deployment_draft_request.v1" as const;
export const SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID =
  "cd-collab.setup_deployment_summary.v1" as const;

export const SETUP_PHASES = [
  "awaiting_owner",
  "claimed",
  "draft",
  "verifying",
  "failed",
  "ready_to_commit",
  "recovery_required",
  "restart_required",
  "configured",
] as const;
export type SetupPhase = (typeof SETUP_PHASES)[number];

export const MAX_SETUP_REQUEST_BYTES = 4 * 1024;
export const MAX_SETUP_STATE_FILE_BYTES = 64 * 1024;
export const MAX_SETUP_HISTORY_ENTRIES = 256;
export const MAX_SETUP_ID_CHARS = 128;
export const MAX_SETUP_LABEL_CHARS = 128;
export const MAX_SETUP_FAILURE_CODE_CHARS = 64;
export const MAX_SETUP_PATH_CHARS = 1_024;
export const MAX_SETUP_URL_CHARS = 2_048;

export const SETUP_DEPLOYMENT_PROFILES = [
  "single_node",
  "postgres_ldap",
] as const;
export type SetupDeploymentProfile =
  (typeof SETUP_DEPLOYMENT_PROFILES)[number];

export const SETUP_SECRET_REFERENCE_KINDS = ["file", "handle"] as const;
export type SetupSecretReferenceKind =
  (typeof SETUP_SECRET_REFERENCE_KINDS)[number];

export const SETUP_SECRET_PURPOSES = [
  "initial_admin_password",
  "database_url",
  "migrate_database_url",
  "ldap_bind_password",
  "gateway_api_key",
] as const;
export type SetupSecretPurpose = (typeof SETUP_SECRET_PURPOSES)[number];

export const SETUP_STORAGE_KINDS = ["sqlite", "postgres"] as const;
export type SetupStorageKind = (typeof SETUP_STORAGE_KINDS)[number];

export const SETUP_AUTHENTICATION_KINDS = ["local", "ldap"] as const;
export type SetupAuthenticationKind =
  (typeof SETUP_AUTHENTICATION_KINDS)[number];

export interface SetupClaimRequestV1 {
  schemaId: typeof SETUP_CLAIM_REQUEST_SCHEMA_ID;
  expectedRevision: number;
  ownerToken: string;
  claimantLabel: string;
}

export interface SetupTransitionRequestV1 {
  schemaId: typeof SETUP_TRANSITION_REQUEST_SCHEMA_ID;
  expectedRevision: number;
  targetPhase: SetupPhase;
  failureCode: string | null;
}

export interface SetupStateEntryV1 {
  stateId: string;
  revision: number;
  phase: SetupPhase;
  occurredAtUnixMs: number;
  claimId: string | null;
  claimantLabel: string | null;
  failureCode: string | null;
}

/** Owner-only persisted state. Never return this shape from an HTTP boundary. */
export interface PersistedSetupStateV1 {
  schemaId: typeof SETUP_STATE_SCHEMA_ID;
  deploymentId: string;
  ownerTokenDigest: string;
  history: SetupStateEntryV1[];
}

/** Share-safe projection. Deliberately excludes token material and filesystem paths. */
export interface SetupStatusV1 {
  schemaId: typeof SETUP_STATUS_SCHEMA_ID;
  stateId: string;
  revision: number;
  phase: SetupPhase;
  claimed: boolean;
  failureCode: string | null;
}

/**
 * Untrusted reference syntax only—not a validated capability and not proven
 * secret-free. Slice B rejects every filesystem-backed reference at its
 * JavaScript boundary. Slice C must authoritatively resolve host-issued opaque
 * handles and enforce their purpose; contract parsing proves neither property.
 */
export interface SetupSecretReferenceV1 {
  kind: SetupSecretReferenceKind;
  purpose: SetupSecretPurpose;
  fileRef: string | null;
  handle: string | null;
}

/** Public trust material is deliberately distinct from a secret reference. */
export interface SetupTrustedCertificateReferenceV1 {
  kind: "trusted_certificate_file";
  purpose: "ldap_ca_certificate";
  fileRef: string;
}

export interface SetupSqliteStorageV1 {
  kind: "sqlite";
  sqlitePath: string;
  databaseUrlRef: null;
  migrateDatabaseUrlRef: null;
}

export interface SetupPostgresStorageV1 {
  kind: "postgres";
  sqlitePath: null;
  databaseUrlRef: SetupSecretReferenceV1;
  migrateDatabaseUrlRef: SetupSecretReferenceV1;
}

export type SetupStorageV1 = SetupSqliteStorageV1 | SetupPostgresStorageV1;

export interface SetupLocalAuthenticationV1 {
  initialAdminUsername: string;
  initialAdminDisplayName: string;
  initialAdminPasswordRef: SetupSecretReferenceV1;
}

export interface SetupLdapAuthenticationV1 {
  url: string;
  starttls: boolean;
  caCertificateRef: SetupTrustedCertificateReferenceV1 | null;
  userDnTemplate: string | null;
  userSearchBase: string | null;
  userSearchFilter: string;
  groupSearchBase: string;
  groupSearchFilter: string;
  bindDn: string | null;
  bindPasswordRef: SetupSecretReferenceV1 | null;
  adminGroup: string;
  /** Absent means the host derives modes from template vs search-base. */
  userResolutionModes?: LdapUserResolutionMode[];
  upnSuffix?: string | null;
  netbiosDomain?: string | null;
  memberAttribute?: string | null;
  displayNameAttr?: string;
  roleTitleAttr?: string;
  teamAttr?: string;
  emailAttr?: string;
}

export interface SetupAuthenticationV1 {
  kind: SetupAuthenticationKind;
  local: SetupLocalAuthenticationV1 | null;
  ldap: SetupLdapAuthenticationV1 | null;
}

export interface SetupGatewayV1 {
  kind: "openai_compatible";
  profileId: string;
  label: string;
  baseUrl: string;
  modelId: string;
  apiKeyRef: SetupSecretReferenceV1;
}

export interface SetupDeploymentDraftRequestV1 {
  schemaId: typeof SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID;
  basedOnRevision: number;
  draftRevision: number;
  deploymentProfile: SetupDeploymentProfile;
  dataRoot: string;
  evidenceRoot: string;
  storage: SetupStorageV1;
  authentication: SetupAuthenticationV1;
  gateway: SetupGatewayV1 | null;
}

export interface SetupDeploymentSummaryV1 {
  schemaId: typeof SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID;
  basedOnRevision: number;
  draftRevision: number;
  deploymentProfile: SetupDeploymentProfile;
  storage: SetupStorageKind;
  authentication: SetupAuthenticationKind;
  gateway: "not_configured" | "openai_compatible";
  storageVerification: "not_run";
  authenticationVerification: "not_run";
  gatewayVerification: "not_configured" | "not_run";
  committed: false;
}

const claimRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_CLAIM_REQUEST_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  ownerToken: f.req(f.str),
  claimantLabel: f.req(f.str),
};

const transitionRequestShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_TRANSITION_REQUEST_SCHEMA_ID)),
  expectedRevision: f.req(f.u64),
  targetPhase: f.req(f.en(...SETUP_PHASES)),
  failureCode: f.nul(f.str),
};

const stateEntryShape: ObjectShape = {
  stateId: f.req(f.str),
  revision: f.req(f.u64),
  phase: f.req(f.en(...SETUP_PHASES)),
  occurredAtUnixMs: f.req(f.u64),
  claimId: f.nul(f.str),
  claimantLabel: f.nul(f.str),
  failureCode: f.nul(f.str),
};

const persistedStateShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_STATE_SCHEMA_ID)),
  deploymentId: f.req(f.str),
  ownerTokenDigest: f.req(f.str),
  history: f.req(f.arr(f.obj(stateEntryShape))),
};

const statusShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_STATUS_SCHEMA_ID)),
  stateId: f.req(f.str),
  revision: f.req(f.u64),
  phase: f.req(f.en(...SETUP_PHASES)),
  claimed: f.req(f.bool),
  failureCode: f.nul(f.str),
};

const secretReferenceShape: ObjectShape = {
  kind: f.req(f.en(...SETUP_SECRET_REFERENCE_KINDS)),
  purpose: f.req(f.en(...SETUP_SECRET_PURPOSES)),
  fileRef: f.nul(f.str),
  handle: f.nul(f.str),
};

const trustedCertificateReferenceShape: ObjectShape = {
  kind: f.req(f.en("trusted_certificate_file")),
  purpose: f.req(f.en("ldap_ca_certificate")),
  fileRef: f.req(f.str),
};

const storageShape: ObjectShape = {
  kind: f.req(f.en(...SETUP_STORAGE_KINDS)),
  sqlitePath: f.nul(f.str),
  databaseUrlRef: f.nul(f.obj(secretReferenceShape)),
  migrateDatabaseUrlRef: f.nul(f.obj(secretReferenceShape)),
};

const localAuthenticationShape: ObjectShape = {
  initialAdminUsername: f.req(f.str),
  initialAdminDisplayName: f.req(f.str),
  initialAdminPasswordRef: f.req(f.obj(secretReferenceShape)),
};

const ldapAuthenticationShape: ObjectShape = {
  url: f.req(f.str),
  starttls: f.req(f.bool),
  caCertificateRef: f.nul(f.obj(trustedCertificateReferenceShape)),
  userDnTemplate: f.nul(f.str),
  userSearchBase: f.nul(f.str),
  userSearchFilter: f.req(f.str),
  groupSearchBase: f.req(f.str),
  groupSearchFilter: f.req(f.str),
  bindDn: f.nul(f.str),
  bindPasswordRef: f.nul(f.obj(secretReferenceShape)),
  adminGroup: f.req(f.str),
  userResolutionModes: f.opt(f.arr(f.en(...LDAP_USER_RESOLUTION_MODES))),
  upnSuffix: f.optNul(f.str),
  netbiosDomain: f.optNul(f.str),
  memberAttribute: f.optNul(f.str),
  displayNameAttr: f.opt(f.str),
  roleTitleAttr: f.opt(f.str),
  teamAttr: f.opt(f.str),
  emailAttr: f.opt(f.str),
};

const authenticationShape: ObjectShape = {
  kind: f.req(f.en(...SETUP_AUTHENTICATION_KINDS)),
  local: f.nul(f.obj(localAuthenticationShape)),
  ldap: f.nul(f.obj(ldapAuthenticationShape)),
};

const gatewayShape: ObjectShape = {
  kind: f.req(f.en("openai_compatible")),
  profileId: f.req(f.str),
  label: f.req(f.str),
  baseUrl: f.req(f.str),
  modelId: f.req(f.str),
  apiKeyRef: f.req(f.obj(secretReferenceShape)),
};

const deploymentDraftShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_DEPLOYMENT_DRAFT_REQUEST_SCHEMA_ID)),
  basedOnRevision: f.req(f.u64),
  draftRevision: f.req(f.u64),
  deploymentProfile: f.req(f.en(...SETUP_DEPLOYMENT_PROFILES)),
  dataRoot: f.req(f.str),
  evidenceRoot: f.req(f.str),
  storage: f.req(f.obj(storageShape)),
  authentication: f.req(f.obj(authenticationShape)),
  gateway: f.nul(f.obj(gatewayShape)),
};

const deploymentSummaryShape: ObjectShape = {
  schemaId: f.req(f.en(SETUP_DEPLOYMENT_SUMMARY_SCHEMA_ID)),
  basedOnRevision: f.req(f.u64),
  draftRevision: f.req(f.u64),
  deploymentProfile: f.req(f.en(...SETUP_DEPLOYMENT_PROFILES)),
  storage: f.req(f.en(...SETUP_STORAGE_KINDS)),
  authentication: f.req(f.en(...SETUP_AUTHENTICATION_KINDS)),
  gateway: f.req(f.en("not_configured", "openai_compatible")),
  storageVerification: f.req(f.en("not_run")),
  authenticationVerification: f.req(f.en("not_run")),
  gatewayVerification: f.req(f.en("not_configured", "not_run")),
  committed: f.req(f.bool),
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]*$/;
const TOKEN_ENCODING = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SETUP_SECRET_HANDLE = new RegExp(
  `^setup_secret:(${SETUP_SECRET_PURPOSES.join("|")}):([a-f0-9]{64})$`,
  "u",
);

function assertBoundedBody(raw: unknown, path: string): void {
  let bytes: number;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined) throw new Error("not serializable");
    bytes = Buffer.byteLength(serialized, "utf8");
  } catch {
    throw new ContractViolation(path, "request must be JSON serializable");
  }
  if (bytes > MAX_SETUP_REQUEST_BYTES) {
    throw new ContractViolation(path, "request exceeds the setup body limit");
  }
}

function assertBoundedId(value: string, path: string): void {
  if (
    value.length < 1 ||
    value.length > MAX_SETUP_ID_CHARS ||
    !SAFE_ID.test(value)
  ) {
    throw new ContractViolation(path, "expected a bounded opaque identifier");
  }
}

function assertClaimantLabel(value: string, path: string): void {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    value.length < 1 ||
    value.length > MAX_SETUP_LABEL_CHARS ||
    value.trim() !== value ||
    hasControlCharacter
  ) {
    throw new ContractViolation(path, "expected a bounded non-secret label");
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function assertBoundedText(
  value: string,
  path: string,
  maximum: number,
): void {
  if (
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new ContractViolation(path, "expected bounded non-secret text");
  }
}

function assertBasicUrl(value: string, path: string): void {
  assertBoundedText(value, path, MAX_SETUP_URL_CHARS);
  try {
    new URL(value);
  } catch {
    throw new ContractViolation(path, "expected a valid URL");
  }
}

function assertSecretReference(
  reference: SetupSecretReferenceV1,
  path: string,
  expectedPurpose: SetupSecretPurpose,
): void {
  if (reference.purpose !== expectedPurpose) {
    throw new ContractViolation(
      `${path}.purpose`,
      "secret reference purpose does not match its use site",
    );
  }
  if (reference.kind === "file") {
    if (
      reference.handle !== null ||
      reference.fileRef === null ||
      !reference.fileRef.startsWith("file:")
    ) {
      throw new ContractViolation(path, "invalid protected-file reference");
    }
    assertBoundedText(reference.fileRef, `${path}.fileRef`, MAX_SETUP_PATH_CHARS);
    return;
  }
  if (reference.fileRef !== null || reference.handle === null) {
    throw new ContractViolation(path, "invalid secret-handle reference");
  }
  assertBoundedText(reference.handle, `${path}.handle`, 256);
  const match = SETUP_SECRET_HANDLE.exec(reference.handle);
  if (match === null || match[1] !== expectedPurpose) {
    throw new ContractViolation(
      `${path}.handle`,
      "expected canonical purpose-bound setup handle syntax",
    );
  }
}

function assertTrustedCertificateReference(
  reference: SetupTrustedCertificateReferenceV1,
  path: string,
): void {
  if (
    reference.purpose !== "ldap_ca_certificate" ||
    !reference.fileRef.startsWith("file:")
  ) {
    throw new ContractViolation(path, "invalid trusted-certificate reference");
  }
  assertBoundedText(reference.fileRef, `${path}.fileRef`, MAX_SETUP_PATH_CHARS);
}

function isReferenceObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertReferenceObject(
  value: unknown,
  path: string,
  label: "secret" | "trusted-certificate",
): void {
  if (!isReferenceObject(value)) {
    throw new ContractViolation(path, `expected ${label} reference object`);
  }
}

function preflightSecretReferenceSlot(
  container: unknown,
  key: string,
  path: string,
  purpose: SetupSecretPurpose,
): void {
  if (!isReferenceObject(container) || !(key in container)) return;
  const value = container[key];
  if (value !== null) parseSetupSecretReference(value, purpose, path);
}

function preflightTrustedCertificateReferenceSlot(
  container: unknown,
  key: string,
  path: string,
): void {
  if (!isReferenceObject(container) || !(key in container)) return;
  const value = container[key];
  if (value !== null) parseSetupTrustedCertificateReference(value, path);
}

/** Fully sanitize references before recursive shape validation can inspect them. */
function preflightDeploymentReferenceObjects(raw: unknown): void {
  if (!isReferenceObject(raw)) return;
  const storage = raw.storage;
  preflightSecretReferenceSlot(
    storage,
    "databaseUrlRef",
    "$.storage.databaseUrlRef",
    "database_url",
  );
  preflightSecretReferenceSlot(
    storage,
    "migrateDatabaseUrlRef",
    "$.storage.migrateDatabaseUrlRef",
    "migrate_database_url",
  );

  const authentication = raw.authentication;
  const local = isReferenceObject(authentication)
    ? authentication.local
    : undefined;
  preflightSecretReferenceSlot(
    local,
    "initialAdminPasswordRef",
    "$.authentication.local.initialAdminPasswordRef",
    "initial_admin_password",
  );
  const ldap = isReferenceObject(authentication)
    ? authentication.ldap
    : undefined;
  preflightTrustedCertificateReferenceSlot(
    ldap,
    "caCertificateRef",
    "$.authentication.ldap.caCertificateRef",
  );
  preflightSecretReferenceSlot(
    ldap,
    "bindPasswordRef",
    "$.authentication.ldap.bindPasswordRef",
    "ldap_bind_password",
  );

  preflightSecretReferenceSlot(
    raw.gateway,
    "apiKeyRef",
    "$.gateway.apiKeyRef",
    "gateway_api_key",
  );
}

const RFC4514_SINGLE_ESCAPES = new Set([" ", ",", "+", '"', "\\", "<", ">", ";", "=", "#"]);

function escapedSequenceLength(value: string, index: number, path: string): number {
  const first = value[index + 1];
  const second = value[index + 2];
  if (first !== undefined && second !== undefined && /^[0-9A-Fa-f]{2}$/u.test(`${first}${second}`)) {
    return 3;
  }
  if (first !== undefined && RFC4514_SINGLE_ESCAPES.has(first)) return 2;
  throw new ContractViolation(path, "contains a malformed RFC4514 escape");
}

function splitNarrowDn(value: string, path: string): string[] {
  const components: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += escapedSequenceLength(value, index, path) - 1;
    } else if (value[index] === ",") {
      components.push(value.slice(start, index));
      start = index + 1;
    }
  }
  components.push(value.slice(start));
  return components;
}

function unescapedEquals(component: string, path: string): number {
  for (let index = 0; index < component.length; index += 1) {
    if (component[index] === "\\") {
      index += escapedSequenceLength(component, index, path) - 1;
    } else if (component[index] === "=") {
      return index;
    }
  }
  return -1;
}

function assertNarrowDnValue(value: string, path: string): void {
  if (
    value.length === 0 ||
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.startsWith("#") ||
    /[{}]/u.test(value)
  ) {
    throw new ContractViolation(path, "outside the narrow RFC4514 value grammar");
  }
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += escapedSequenceLength(value, index, path) - 1;
    } else if (character !== undefined && /[,+"<>;=]/u.test(character)) {
      throw new ContractViolation(path, "contains an unescaped RFC4514 metacharacter");
    }
  }
}

function assertNarrowDn(
  value: string,
  path: string,
  usernameTemplate: boolean,
): void {
  const components = splitNarrowDn(value, path);
  if (components.length < (usernameTemplate ? 2 : 1)) {
    throw new ContractViolation(path, "outside the narrow RFC4514 DN grammar");
  }
  let usernamePlaceholders = 0;
  for (const [index, component] of components.entries()) {
    const separator = unescapedEquals(component, path);
    const attribute = component.slice(0, separator);
    const componentValue = component.slice(separator + 1);
    if (separator < 1 || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(attribute)) {
      throw new ContractViolation(path, "outside the narrow RFC4514 DN grammar");
    }
    if (componentValue === "{username}" || componentValue === "{0}") {
      usernamePlaceholders += 1;
      if (!usernameTemplate || index !== 0) {
        throw new ContractViolation(path, "ambiguous username placeholder placement");
      }
    } else {
      assertNarrowDnValue(componentValue, path);
    }
  }
  if (usernamePlaceholders !== (usernameTemplate ? 1 : 0)) {
    throw new ContractViolation(path, "must contain {username} or {0} exactly once");
  }
}

interface NarrowFilterResult {
  next: number;
  placeholderCount: number;
  staticAssertions: number;
  conjunction: boolean;
}

function assertNarrowFilterValue(value: string, path: string): void {
  if (value.length === 0 || /[{}]/u.test(value)) {
    throw new ContractViolation(path, "outside the narrow RFC4515 value grammar");
  }
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const escaped = value.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(escaped)) {
        throw new ContractViolation(path, "contains a malformed RFC4515 escape");
      }
      index += 2;
    } else if (character !== undefined && /[()*]/u.test(character)) {
      throw new ContractViolation(path, "contains an unescaped RFC4515 metacharacter");
    }
  }
}

function parseNarrowFilter(
  value: string,
  start: number,
  placeholder: "username" | "dn",
  allowConjunction: boolean,
  path: string,
): NarrowFilterResult {
  if (value[start] !== "(") {
    throw new ContractViolation(path, "outside the narrow RFC4515 filter grammar");
  }
  let cursor = start + 1;
  if (value[cursor] === "&") {
    if (!allowConjunction) {
      throw new ContractViolation(path, "policy-broad LDAP expression refused");
    }
    cursor += 1;
    let childCount = 0;
    let placeholderCount = 0;
    let staticAssertions = 0;
    while (value[cursor] === "(") {
      const child = parseNarrowFilter(value, cursor, placeholder, false, path);
      cursor = child.next;
      childCount += 1;
      placeholderCount += child.placeholderCount;
      staticAssertions += child.staticAssertions;
    }
    if (value[cursor] !== ")" || childCount < 2) {
      throw new ContractViolation(path, "outside the narrow RFC4515 conjunction grammar");
    }
    return {
      next: cursor + 1,
      placeholderCount,
      staticAssertions,
      conjunction: true,
    };
  }
  if (value[cursor] === "|" || value[cursor] === "!") {
    throw new ContractViolation(path, "policy-broad LDAP expression refused");
  }
  const equals = value.indexOf("=", cursor);
  const close = value.indexOf(")", cursor);
  if (equals <= cursor || close < equals || !/^[A-Za-z][A-Za-z0-9.-]*$/u.test(value.slice(cursor, equals))) {
    throw new ContractViolation(path, "outside the narrow RFC4515 assertion grammar");
  }
  const assertionValue = value.slice(equals + 1, close);
  const token = `{${placeholder}}`;
  if (
    assertionValue === token ||
    (placeholder === "username" && assertionValue === "{0}")
  ) {
    return {
      next: close + 1,
      placeholderCount: 1,
      staticAssertions: 0,
      conjunction: false,
    };
  }
  assertNarrowFilterValue(assertionValue, path);
  return {
    next: close + 1,
    placeholderCount: 0,
    staticAssertions: 1,
    conjunction: false,
  };
}

function assertNarrowLdapFilter(
  value: string,
  placeholder: "username" | "dn",
  requireConjunction: boolean,
  path: string,
): void {
  const parsed = parseNarrowFilter(
    value,
    0,
    placeholder,
    requireConjunction || placeholder === "username",
    path,
  );
  if (parsed.next !== value.length || parsed.placeholderCount !== 1) {
    throw new ContractViolation(path, "outside the narrow purpose-bound LDAP filter grammar");
  }
  if (requireConjunction) {
    if (!parsed.conjunction || parsed.staticAssertions < 1) {
      throw new ContractViolation(path, "outside the narrow purpose-bound LDAP filter grammar");
    }
    return;
  }
  if (placeholder === "username") {
    if (parsed.conjunction && parsed.staticAssertions < 1) {
      throw new ContractViolation(path, "outside the narrow purpose-bound LDAP filter grammar");
    }
    return;
  }
  if (parsed.conjunction || parsed.staticAssertions !== 0) {
    throw new ContractViolation(path, "outside the narrow purpose-bound LDAP filter grammar");
  }
}

function assertFailureCode(value: string, path: string): void {
  if (
    value.length < 1 ||
    value.length > MAX_SETUP_FAILURE_CODE_CHARS ||
    !FAILURE_CODE.test(value)
  ) {
    throw new ContractViolation(path, "expected a bounded failure code");
  }
}

export function assertHighEntropyOwnerToken(token: string): void {
  // 32 random bytes encoded as base64url require 43 characters. Hex-encoded
  // tokens are also accepted because their alphabet is a subset of base64url.
  if (
    token.length < 43 ||
    token.length > 172 ||
    !TOKEN_ENCODING.test(token)
  ) {
    throw new ContractViolation(
      "$.ownerToken",
      "expected a high-entropy base64url token",
    );
  }
}

export function isValidSetupTransition(
  from: SetupPhase,
  to: SetupPhase,
): boolean {
  switch (from) {
    case "awaiting_owner":
      return to === "claimed";
    case "claimed":
      return to === "draft";
    case "draft":
      return to === "draft" || to === "verifying";
    case "verifying":
      return (
        to === "failed" ||
        to === "ready_to_commit" ||
        to === "recovery_required"
      );
    case "failed":
      return to === "draft";
    case "ready_to_commit":
      return to === "restart_required" || to === "recovery_required";
    case "restart_required":
      return to === "configured" || to === "recovery_required";
    case "recovery_required":
    case "configured":
      return false;
  }
}

export function parseSetupClaimRequest(raw: unknown): SetupClaimRequestV1 {
  assertBoundedBody(raw, "$");
  checkObject("$", claimRequestShape, raw);
  const request = raw as SetupClaimRequestV1;
  assertHighEntropyOwnerToken(request.ownerToken);
  assertClaimantLabel(request.claimantLabel, "$.claimantLabel");
  return request;
}

export function parseSetupTransitionRequest(
  raw: unknown,
): SetupTransitionRequestV1 {
  assertBoundedBody(raw, "$");
  checkObject("$", transitionRequestShape, raw);
  const request = raw as SetupTransitionRequestV1;
  if (request.failureCode !== null) {
    assertFailureCode(request.failureCode, "$.failureCode");
  }
  const requiresFailureCode =
    request.targetPhase === "failed" ||
    request.targetPhase === "recovery_required";
  if (requiresFailureCode !== (request.failureCode !== null)) {
    throw new ContractViolation(
      "$.failureCode",
      requiresFailureCode
        ? "required for a failure state"
        : "must be null outside a failure state",
    );
  }
  return request;
}

function assertEntry(entry: SetupStateEntryV1, index: number): void {
  const path = `$.history[${index}]`;
  assertBoundedId(entry.stateId, `${path}.stateId`);
  if (entry.occurredAtUnixMs < 1) {
    throw new ContractViolation(`${path}.occurredAtUnixMs`, "must be positive");
  }
  if (entry.claimId !== null) {
    assertBoundedId(entry.claimId, `${path}.claimId`);
  }
  if (entry.claimantLabel !== null) {
    assertClaimantLabel(entry.claimantLabel, `${path}.claimantLabel`);
  }
  if (entry.failureCode !== null) {
    assertFailureCode(entry.failureCode, `${path}.failureCode`);
  }

  const isAwaiting = entry.phase === "awaiting_owner";
  if (isAwaiting !== (entry.claimId === null && entry.claimantLabel === null)) {
    throw new ContractViolation(path, "claim metadata does not match phase");
  }
  const isFailure =
    entry.phase === "failed" || entry.phase === "recovery_required";
  if (isFailure !== (entry.failureCode !== null)) {
    throw new ContractViolation(path, "failure code does not match phase");
  }
}

export function parsePersistedSetupState(raw: unknown): PersistedSetupStateV1 {
  checkObject("$", persistedStateShape, raw);
  const state = raw as PersistedSetupStateV1;
  assertBoundedId(state.deploymentId, "$.deploymentId");
  if (!SHA256_HEX.test(state.ownerTokenDigest)) {
    throw new ContractViolation(
      "$.ownerTokenDigest",
      "expected a SHA-256 digest",
    );
  }
  if (
    state.history.length < 1 ||
    state.history.length > MAX_SETUP_HISTORY_ENTRIES
  ) {
    throw new ContractViolation("$.history", "invalid setup history length");
  }

  const stateIds = new Set<string>();
  let claimId: string | null = null;
  let claimantLabel: string | null = null;
  for (const [index, entry] of state.history.entries()) {
    assertEntry(entry, index);
    if (stateIds.has(entry.stateId)) {
      throw new ContractViolation(`$.history[${index}].stateId`, "duplicate state id");
    }
    stateIds.add(entry.stateId);
    if (entry.revision !== index) {
      throw new ContractViolation(
        `$.history[${index}].revision`,
        "setup revisions must be contiguous and start at zero",
      );
    }
    if (index === 0) {
      if (entry.phase !== "awaiting_owner") {
        throw new ContractViolation("$.history[0].phase", "must await an owner");
      }
      continue;
    }
    const prior = state.history[index - 1];
    if (prior && entry.occurredAtUnixMs < prior.occurredAtUnixMs) {
      throw new ContractViolation(
        `$.history[${index}].occurredAtUnixMs`,
        "setup history timestamps cannot move backwards",
      );
    }
    if (!prior || !isValidSetupTransition(prior.phase, entry.phase)) {
      throw new ContractViolation(
        `$.history[${index}].phase`,
        "invalid setup state transition",
      );
    }
    if (index === 1) {
      claimId = entry.claimId;
      claimantLabel = entry.claimantLabel;
    } else if (
      entry.claimId !== claimId ||
      entry.claimantLabel !== claimantLabel
    ) {
      throw new ContractViolation(
        `$.history[${index}]`,
        "claim metadata is immutable",
      );
    }
  }
  return state;
}

export function parseSetupStatus(raw: unknown): SetupStatusV1 {
  checkObject("$", statusShape, raw);
  const status = raw as SetupStatusV1;
  assertBoundedId(status.stateId, "$.stateId");
  if (status.failureCode !== null) {
    assertFailureCode(status.failureCode, "$.failureCode");
  }
  const isFailure =
    status.phase === "failed" || status.phase === "recovery_required";
  if (isFailure !== (status.failureCode !== null)) {
    throw new ContractViolation("$.failureCode", "does not match setup phase");
  }
  if (status.claimed !== (status.phase !== "awaiting_owner")) {
    throw new ContractViolation("$.claimed", "does not match setup phase");
  }
  return status;
}

export function projectSetupStatus(state: PersistedSetupStateV1): SetupStatusV1 {
  const parsed = parsePersistedSetupState(state);
  const current = parsed.history.at(-1);
  if (!current) throw new Error("setup state has no current entry");
  return parseSetupStatus({
    schemaId: SETUP_STATUS_SCHEMA_ID,
    stateId: current.stateId,
    revision: current.revision,
    phase: current.phase,
    claimed: current.phase !== "awaiting_owner",
    failureCode: current.failureCode,
  });
}

function assertLocalAuthentication(
  authentication: SetupLocalAuthenticationV1,
  path: string,
): void {
  assertBoundedId(authentication.initialAdminUsername, `${path}.initialAdminUsername`);
  assertBoundedText(
    authentication.initialAdminDisplayName,
    `${path}.initialAdminDisplayName`,
    MAX_SETUP_LABEL_CHARS,
  );
  assertSecretReference(
    authentication.initialAdminPasswordRef,
    `${path}.initialAdminPasswordRef`,
    "initial_admin_password",
  );
}

function assertLdapAuthentication(
  authentication: SetupLdapAuthenticationV1,
  path: string,
): void {
  assertBasicUrl(authentication.url, `${path}.url`);
  const modes = authentication.userResolutionModes
    ? parseLdapUserResolutionModes(
        authentication.userResolutionModes,
        `${path}.userResolutionModes`,
      )
    : null;
  const hasDnTemplate = authentication.userDnTemplate !== null;
  const hasSearchBase = authentication.userSearchBase !== null;
  if (modes === null && hasDnTemplate === hasSearchBase) {
    throw new ContractViolation(
      path,
      "LDAP identity lookup requires exactly one narrow lookup mode",
    );
  }
  if (modes !== null) {
    if (modes.length === 0) {
      throw new ContractViolation(
        `${path}.userResolutionModes`,
        "ldap auth requires at least one resolution mode",
      );
    }
    if (modes.includes("dn_template") !== hasDnTemplate) {
      throw new ContractViolation(
        `${path}.userDnTemplate`,
        "DN-template resolution requires a user DN template",
      );
    }
    const needsSearch =
      modes.includes("service_bind_search") ||
      modes.includes("upn") ||
      modes.includes("domain_backslash");
    if (needsSearch !== hasSearchBase && needsSearch) {
      throw new ContractViolation(
        `${path}.userSearchBase`,
        "search, UPN, and DOMAIN\\user resolution require a user search base",
      );
    }
    if (modes.includes("service_bind_search") && authentication.bindDn === null) {
      throw new ContractViolation(
        `${path}.bindDn`,
        "service-bind search requires a service bind DN and password reference",
      );
    }
    if (modes.includes("upn") && !authentication.upnSuffix) {
      throw new ContractViolation(
        `${path}.upnSuffix`,
        "UPN resolution requires an explicit UPN suffix",
      );
    }
    if (modes.includes("domain_backslash") && !authentication.netbiosDomain) {
      throw new ContractViolation(
        `${path}.netbiosDomain`,
        "DOMAIN\\user resolution requires an explicit NetBIOS domain",
      );
    }
  }
  if (
    (authentication.bindDn === null) !==
    (authentication.bindPasswordRef === null)
  ) {
    throw new ContractViolation(
      path,
      "LDAP bind DN and password reference must be supplied together",
    );
  }
  if (authentication.caCertificateRef !== null) {
    assertTrustedCertificateReference(
      authentication.caCertificateRef,
      `${path}.caCertificateRef`,
    );
  }
  if (authentication.userDnTemplate !== null) {
    assertBoundedText(
      authentication.userDnTemplate,
      `${path}.userDnTemplate`,
      512,
    );
    assertNarrowDn(
      authentication.userDnTemplate,
      `${path}.userDnTemplate`,
      true,
    );
  }
  if (authentication.userSearchBase !== null) {
    assertBoundedText(
      authentication.userSearchBase,
      `${path}.userSearchBase`,
      512,
    );
    assertNarrowDn(
      authentication.userSearchBase,
      `${path}.userSearchBase`,
      false,
    );
  }
  assertBoundedText(authentication.userSearchFilter, `${path}.userSearchFilter`, 512);
  assertNarrowLdapFilter(
    authentication.userSearchFilter,
    "username",
    false,
    `${path}.userSearchFilter`,
  );
  assertBoundedText(authentication.groupSearchBase, `${path}.groupSearchBase`, 512);
  assertNarrowDn(
    authentication.groupSearchBase,
    `${path}.groupSearchBase`,
    false,
  );
  assertBoundedText(
    authentication.groupSearchFilter,
    `${path}.groupSearchFilter`,
    512,
  );
  assertNarrowLdapFilter(
    authentication.groupSearchFilter,
    "dn",
    true,
    `${path}.groupSearchFilter`,
  );
  if (authentication.bindDn !== null) {
    assertBoundedText(authentication.bindDn, `${path}.bindDn`, 512);
    assertNarrowDn(authentication.bindDn, `${path}.bindDn`, false);
  }
  if (authentication.bindPasswordRef !== null) {
    assertSecretReference(
      authentication.bindPasswordRef,
      `${path}.bindPasswordRef`,
      "ldap_bind_password",
    );
  }
  assertBoundedText(authentication.adminGroup, `${path}.adminGroup`, 512);
  assertNarrowDn(authentication.adminGroup, `${path}.adminGroup`, false);
  if (authentication.upnSuffix) {
    assertLdapUpnSuffix(authentication.upnSuffix, `${path}.upnSuffix`);
  }
  if (authentication.netbiosDomain) {
    assertLdapNetbiosDomain(authentication.netbiosDomain, `${path}.netbiosDomain`);
  }
  if (authentication.memberAttribute) {
    assertLdapAttributeName(authentication.memberAttribute, `${path}.memberAttribute`);
  }
  for (const field of [
    "displayNameAttr",
    "roleTitleAttr",
    "teamAttr",
    "emailAttr",
  ] as const) {
    const value = authentication[field];
    if (value !== undefined) assertLdapAttributeName(value, `${path}.${field}`);
  }
}

export function parseSetupSecretReference(
  raw: unknown,
  expectedPurpose: SetupSecretPurpose,
  path = "$",
): SetupSecretReferenceV1 {
  try {
    assertReferenceObject(raw, path, "secret");
    checkObject(path, secretReferenceShape, raw);
    const reference = raw as SetupSecretReferenceV1;
    assertSecretReference(reference, path, expectedPurpose);
    return reference;
  } catch (error) {
    if (error instanceof ContractViolation) {
      throw new ContractViolation(path, "invalid secret reference");
    }
    throw error;
  }
}

export function parseSetupTrustedCertificateReference(
  raw: unknown,
  path = "$",
): SetupTrustedCertificateReferenceV1 {
  try {
    assertReferenceObject(raw, path, "trusted-certificate");
    checkObject(path, trustedCertificateReferenceShape, raw);
    const reference = raw as SetupTrustedCertificateReferenceV1;
    assertTrustedCertificateReference(reference, path);
    return reference;
  } catch (error) {
    if (error instanceof ContractViolation) {
      throw new ContractViolation(
        path,
        "invalid trusted-certificate reference",
      );
    }
    throw error;
  }
}

export function parseSetupDeploymentDraftRequest(
  raw: unknown,
): SetupDeploymentDraftRequestV1 {
  assertBoundedBody(raw, "$");
  preflightDeploymentReferenceObjects(raw);
  checkObject("$", deploymentDraftShape, raw);
  const request = raw as SetupDeploymentDraftRequestV1;
  if (request.draftRevision !== request.basedOnRevision + 1) {
    throw new ContractViolation(
      "$.draftRevision",
      "must advance exactly one revision beyond basedOnRevision",
    );
  }
  assertBoundedText(request.dataRoot, "$.dataRoot", MAX_SETUP_PATH_CHARS);
  assertBoundedText(request.evidenceRoot, "$.evidenceRoot", MAX_SETUP_PATH_CHARS);

  if (request.storage.kind === "sqlite") {
    if (
      request.storage.sqlitePath === null ||
      request.storage.databaseUrlRef !== null ||
      request.storage.migrateDatabaseUrlRef !== null
    ) {
      throw new ContractViolation("$.storage", "invalid SQLite storage shape");
    }
    assertBoundedText(
      request.storage.sqlitePath,
      "$.storage.sqlitePath",
      MAX_SETUP_PATH_CHARS,
    );
  } else {
    if (
      request.storage.sqlitePath !== null ||
      request.storage.databaseUrlRef === null ||
      request.storage.migrateDatabaseUrlRef === null
    ) {
      throw new ContractViolation("$.storage", "invalid PostgreSQL storage shape");
    }
    assertSecretReference(
      request.storage.databaseUrlRef,
      "$.storage.databaseUrlRef",
      "database_url",
    );
    assertSecretReference(
      request.storage.migrateDatabaseUrlRef,
      "$.storage.migrateDatabaseUrlRef",
      "migrate_database_url",
    );
  }

  if (request.authentication.kind === "local") {
    if (request.authentication.local === null || request.authentication.ldap !== null) {
      throw new ContractViolation(
        "$.authentication",
        "invalid local authentication shape",
      );
    }
    assertLocalAuthentication(request.authentication.local, "$.authentication.local");
  } else {
    if (request.authentication.local !== null || request.authentication.ldap === null) {
      throw new ContractViolation(
        "$.authentication",
        "invalid LDAP authentication shape",
      );
    }
    assertLdapAuthentication(request.authentication.ldap, "$.authentication.ldap");
  }

  const expectedStorage =
    request.deploymentProfile === "single_node" ? "sqlite" : "postgres";
  const expectedAuthentication =
    request.deploymentProfile === "single_node" ? "local" : "ldap";
  if (
    request.storage.kind !== expectedStorage ||
    request.authentication.kind !== expectedAuthentication
  ) {
    throw new ContractViolation(
      "$.deploymentProfile",
      "deployment profile does not match storage and authentication",
    );
  }

  if (request.gateway !== null) {
    assertBoundedId(request.gateway.profileId, "$.gateway.profileId");
    assertBoundedText(request.gateway.label, "$.gateway.label", MAX_SETUP_LABEL_CHARS);
    assertBasicUrl(request.gateway.baseUrl, "$.gateway.baseUrl");
    assertBoundedText(request.gateway.modelId, "$.gateway.modelId", 256);
    assertSecretReference(
      request.gateway.apiKeyRef,
      "$.gateway.apiKeyRef",
      "gateway_api_key",
    );
  }
  return request;
}

export function parseSetupDeploymentSummary(
  raw: unknown,
): SetupDeploymentSummaryV1 {
  checkObject("$", deploymentSummaryShape, raw);
  const summary = raw as SetupDeploymentSummaryV1;
  if (summary.draftRevision !== summary.basedOnRevision + 1) {
    throw new ContractViolation(
      "$.draftRevision",
      "must advance exactly one revision beyond basedOnRevision",
    );
  }
  if (summary.committed !== false) {
    throw new ContractViolation("$.committed", "Slice B cannot claim commit");
  }
  if (
    (summary.gateway === "not_configured") !==
    (summary.gatewayVerification === "not_configured")
  ) {
    throw new ContractViolation(
      "$.gatewayVerification",
      "does not match gateway configuration",
    );
  }
  const expectedStorage =
    summary.deploymentProfile === "single_node" ? "sqlite" : "postgres";
  const expectedAuthentication =
    summary.deploymentProfile === "single_node" ? "local" : "ldap";
  if (
    summary.storage !== expectedStorage ||
    summary.authentication !== expectedAuthentication
  ) {
    throw new ContractViolation(
      "$.deploymentProfile",
      "deployment profile does not match storage and authentication",
    );
  }
  return summary;
}
