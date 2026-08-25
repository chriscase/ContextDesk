/**
 * Share-safe LDAP administration and connection-probe contracts.
 *
 * These shapes never carry a bind password, probe password, or other secret.
 * Probe requests may include an ephemeral probe password at the HTTP boundary;
 * parsers accept it for the auth module and it must never be copied into a
 * response, log, or export.
 */
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import {
  DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID,
  DIRECTORY_MAPPED_FIELDS,
  parseDirectoryAttributeMap,
  type DirectoryAttributeMapV1,
} from "./directory-mapping.js";
export { DEFAULT_DIRECTORY_ATTRIBUTE_MAP } from "./directory-mapping.js";
import { hasDangerousUnicode } from "./user-profile.js";

export const LDAP_PUBLIC_CONFIG_SCHEMA_ID = "cd-collab.ldap_public_config.v1" as const;
export const LDAP_PROBE_REQUEST_SCHEMA_ID = "cd-collab.ldap_probe_request.v1" as const;
export const LDAP_PROBE_REPORT_SCHEMA_ID = "cd-collab.ldap_probe_report.v1" as const;
export const LDAP_ADMIN_ERROR_SCHEMA_ID = "cd-collab.ldap_admin_error.v1" as const;

export const LDAP_USER_RESOLUTION_MODES = [
  "dn_template",
  "service_bind_search",
  "upn",
  "domain_backslash",
] as const;
export type LdapUserResolutionMode = (typeof LDAP_USER_RESOLUTION_MODES)[number];

export const LDAP_PROBE_STAGES = [
  "transport",
  "service_bind",
  "user_search",
  "group_lookup",
  "role_map",
] as const;
export type LdapProbeStageId = (typeof LDAP_PROBE_STAGES)[number];

export const LDAP_PROBE_STAGE_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "not_run",
] as const;
export type LdapProbeStageStatus = (typeof LDAP_PROBE_STAGE_STATUSES)[number];

export const LDAP_ADMIN_ERROR_CODES = [
  "invalid_request",
  "forbidden",
  "unauthenticated",
  "unavailable",
  "not_ldap",
] as const;
export type LdapAdminErrorCode = (typeof LDAP_ADMIN_ERROR_CODES)[number];

export const LDAP_MAX_GROUPS = 50;
export const LDAP_PROBE_USERNAME_MAX = 128;
export const LDAP_PROBE_DETAIL_MAX = 240;
export const LDAP_UPN_SUFFIX_MAX = 253;
export const LDAP_NETBIOS_MAX = 15;

export interface LdapPublicConfigV1 {
  schemaId: typeof LDAP_PUBLIC_CONFIG_SCHEMA_ID;
  authMode: "ldap" | "local";
  url: string | null;
  starttls: boolean;
  verifyTls: boolean;
  caConfigured: boolean;
  userResolutionModes: LdapUserResolutionMode[];
  userDnTemplate: string | null;
  userSearchBase: string | null;
  userSearchFilter: string | null;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  memberAttribute: string | null;
  bindDn: string | null;
  bindPasswordConfigured: boolean;
  upnSuffix: string | null;
  netbiosDomain: string | null;
  attributeMap: DirectoryAttributeMapV1;
  timeoutMs: number;
}

export interface LdapProbeRequestV1 {
  schemaId: typeof LDAP_PROBE_REQUEST_SCHEMA_ID;
  probeUsername: string | null;
  /**
   * Ephemeral directory password for an optional user-bind confirmation.
   * Never persisted, logged, or returned. Absent/null skips user bind.
   */
  probePassword: string | null;
}

export interface LdapProbeStageV1 {
  id: LdapProbeStageId;
  status: LdapProbeStageStatus;
  detail: string;
}

export interface LdapProbeReportV1 {
  schemaId: typeof LDAP_PROBE_REPORT_SCHEMA_ID;
  ready: boolean;
  stages: LdapProbeStageV1[];
  bindPasswordConfigured: boolean;
  groupsFound: number;
  mappedRoles: boolean;
}

export interface LdapAdminErrorV1 {
  schemaId: typeof LDAP_ADMIN_ERROR_SCHEMA_ID;
  error: LdapAdminErrorCode;
}

const publicConfigShape: ObjectShape = {
  schemaId: f.req(f.en(LDAP_PUBLIC_CONFIG_SCHEMA_ID)),
  authMode: f.req(f.en("ldap", "local")),
  url: f.nul(f.str),
  starttls: f.req(f.bool),
  verifyTls: f.req(f.bool),
  caConfigured: f.req(f.bool),
  userResolutionModes: f.req(f.arr(f.en(...LDAP_USER_RESOLUTION_MODES))),
  userDnTemplate: f.nul(f.str),
  userSearchBase: f.nul(f.str),
  userSearchFilter: f.nul(f.str),
  groupSearchBase: f.nul(f.str),
  groupSearchFilter: f.nul(f.str),
  memberAttribute: f.nul(f.str),
  bindDn: f.nul(f.str),
  bindPasswordConfigured: f.req(f.bool),
  upnSuffix: f.nul(f.str),
  netbiosDomain: f.nul(f.str),
  attributeMap: f.req(
    f.obj({
      schemaId: f.req(f.en(DIRECTORY_ATTRIBUTE_MAP_SCHEMA_ID)),
      attributes: f.req(
        f.obj(
          Object.fromEntries(
            DIRECTORY_MAPPED_FIELDS.map((field) => [field, f.req(f.nstr)]),
          ) as ObjectShape,
        ),
      ),
    }),
  ),
  timeoutMs: f.req(f.u64),
};

const probeRequestShape: ObjectShape = {
  schemaId: f.req(f.en(LDAP_PROBE_REQUEST_SCHEMA_ID)),
  probeUsername: f.nul(f.str),
  probePassword: f.nul(f.str),
};

const probeStageShape: ObjectShape = {
  id: f.req(f.en(...LDAP_PROBE_STAGES)),
  status: f.req(f.en(...LDAP_PROBE_STAGE_STATUSES)),
  detail: f.req(f.str),
};

const probeReportShape: ObjectShape = {
  schemaId: f.req(f.en(LDAP_PROBE_REPORT_SCHEMA_ID)),
  ready: f.req(f.bool),
  stages: f.req(f.arr(f.obj(probeStageShape))),
  bindPasswordConfigured: f.req(f.bool),
  groupsFound: f.req(f.u64),
  mappedRoles: f.req(f.bool),
};

const adminErrorShape: ObjectShape = {
  schemaId: f.req(f.en(LDAP_ADMIN_ERROR_SCHEMA_ID)),
  error: f.req(f.en(...LDAP_ADMIN_ERROR_CODES)),
};

const NETBIOS = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}$/u;
const UPN_SUFFIX = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9.-]*$/u;

function assertNoSecretShape(raw: unknown, path: string): void {
  const serialized = JSON.stringify(raw);
  if (
    /"bindPassword"\s*:/.test(serialized) ||
    /probePassword/i.test(serialized) ||
    /COLLAB_LDAP_BIND_PASSWORD/.test(serialized)
  ) {
    throw new ContractViolation(path, "LDAP contract must not carry secrets");
  }
}

export function parseLdapUserResolutionModes(
  raw: unknown,
  path = "$",
): LdapUserResolutionMode[] {
  const modes: LdapUserResolutionMode[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw) || raw.length > LDAP_USER_RESOLUTION_MODES.length) {
    throw new ContractViolation(path, "expected a unique resolution-mode list");
  }
  if (raw.length === 0) return modes;
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string" || !(LDAP_USER_RESOLUTION_MODES as readonly string[]).includes(value)) {
      throw new ContractViolation(`${path}[${index}]`, "unknown user-resolution mode");
    }
    if (seen.has(value)) {
      throw new ContractViolation(`${path}[${index}]`, "duplicate user-resolution mode");
    }
    seen.add(value);
    modes.push(value as LdapUserResolutionMode);
  }
  return modes;
}

export function assertLdapUpnSuffix(value: string, path: string): void {
  if (
    value.length < 3 ||
    value.length > LDAP_UPN_SUFFIX_MAX ||
    !UPN_SUFFIX.test(value) ||
    hasDangerousUnicode(value)
  ) {
    throw new ContractViolation(path, "expected an explicit DNS-shaped UPN suffix");
  }
}

export function assertLdapNetbiosDomain(value: string, path: string): void {
  if (
    value.length < 1 ||
    value.length > LDAP_NETBIOS_MAX ||
    !NETBIOS.test(value) ||
    hasDangerousUnicode(value)
  ) {
    throw new ContractViolation(path, "expected an explicit NetBIOS domain");
  }
}

export function assertLdapAttributeName(value: string, path: string): void {
  if (
    value.length < 1 ||
    value.length > 128 ||
    !ATTR_NAME.test(value) ||
    hasDangerousUnicode(value)
  ) {
    throw new ContractViolation(path, "expected a bounded LDAP attribute name");
  }
}

export function parseLdapPublicConfig(raw: unknown): LdapPublicConfigV1 {
  checkObject("$", publicConfigShape, raw);
  const config = raw as LdapPublicConfigV1;
  parseLdapUserResolutionModes(config.userResolutionModes, "$.userResolutionModes");
  if (config.authMode === "local") {
    if (config.userResolutionModes.length !== 0 || config.url !== null) {
      throw new ContractViolation("$", "local auth cannot publish a live directory URL");
    }
  } else if (config.userResolutionModes.length === 0) {
    throw new ContractViolation(
      "$.userResolutionModes",
      "ldap auth requires at least one resolution mode",
    );
  }
  parseDirectoryAttributeMap(config.attributeMap);
  if (config.timeoutMs < 100 || config.timeoutMs > 30_000) {
    throw new ContractViolation("$.timeoutMs", "expected 100 to 30000 milliseconds");
  }
  if (config.upnSuffix !== null) assertLdapUpnSuffix(config.upnSuffix, "$.upnSuffix");
  if (config.netbiosDomain !== null) {
    assertLdapNetbiosDomain(config.netbiosDomain, "$.netbiosDomain");
  }
  if (config.memberAttribute !== null) {
    assertLdapAttributeName(config.memberAttribute, "$.memberAttribute");
  }
  if (config.bindPasswordConfigured && config.bindDn === null) {
    throw new ContractViolation("$", "bind password cannot be configured without a bind DN");
  }
  const serialized = JSON.stringify(config);
  if (/"bindPassword"\s*:/.test(serialized) || /"probePassword"\s*:/.test(serialized)) {
    throw new ContractViolation("$", "LDAP public config must not carry secrets");
  }
  return config;
}

export function parseLdapProbeRequest(raw: unknown): LdapProbeRequestV1 {
  checkObject("$", probeRequestShape, raw);
  const request = raw as LdapProbeRequestV1;
  if (request.probeUsername !== null) {
    if (
      request.probeUsername.length < 1 ||
      request.probeUsername.length > LDAP_PROBE_USERNAME_MAX ||
      hasDangerousUnicode(request.probeUsername)
    ) {
      throw new ContractViolation("$.probeUsername", "expected a bounded probe username");
    }
  }
  if (request.probePassword !== null) {
    if (request.probeUsername === null) {
      throw new ContractViolation(
        "$.probePassword",
        "a probe password requires a probe username",
      );
    }
    if (request.probePassword.length < 1 || request.probePassword.length > 1024) {
      throw new ContractViolation("$.probePassword", "invalid probe credential");
    }
  }
  return request;
}

export function parseLdapProbeReport(raw: unknown): LdapProbeReportV1 {
  checkObject("$", probeReportShape, raw);
  const report = raw as LdapProbeReportV1;
  if (report.stages.length !== LDAP_PROBE_STAGES.length) {
    throw new ContractViolation("$.stages", "expected every probe stage exactly once");
  }
  const seen = new Set<string>();
  for (const [index, stage] of report.stages.entries()) {
    if (seen.has(stage.id)) {
      throw new ContractViolation(`$.stages[${index}].id`, "duplicate probe stage");
    }
    seen.add(stage.id);
    if (stage.id !== LDAP_PROBE_STAGES[index]) {
      throw new ContractViolation(`$.stages[${index}].id`, "probe stages must stay in contract order");
    }
    if (stage.detail.length < 1 || stage.detail.length > LDAP_PROBE_DETAIL_MAX) {
      throw new ContractViolation(`$.stages[${index}].detail`, "expected a bounded stage detail");
    }
    if (hasDangerousUnicode(stage.detail)) {
      throw new ContractViolation(`$.stages[${index}].detail`, "control characters are not allowed");
    }
  }
  if (report.groupsFound > LDAP_MAX_GROUPS) {
    throw new ContractViolation("$.groupsFound", "exceeds the group bound");
  }
  assertNoSecretShape(report, "$");
  const readyFromStages = report.stages.every(
    (stage) => stage.status === "passed" || stage.status === "skipped",
  );
  if (report.ready !== readyFromStages) {
    throw new ContractViolation("$.ready", "does not match stage outcomes");
  }
  return report;
}

export function parseLdapAdminError(raw: unknown): LdapAdminErrorV1 {
  checkObject("$", adminErrorShape, raw);
  return raw as LdapAdminErrorV1;
}

export function projectLdapProbeReady(stages: readonly LdapProbeStageV1[]): boolean {
  return stages.every((stage) => stage.status === "passed" || stage.status === "skipped");
}
