import { checkObject, f, type ObjectShape } from "./parse.js";
import { assertShareSafePrivacy } from "./privacy.js";
import { LIVE_PROFILE_ALIASES, type LiveProfileAlias } from "./qualification.js";

export const DOCTOR_REPORT_SCHEMA_ID = "cd-collab.doctor_report.v1" as const;
export const PROFILE_CATALOG_SCHEMA_ID = "cd-collab.profile_catalog.v1" as const;

export const DOCTOR_CHECK_IDS = [
  "node_runtime",
  "built_artifacts",
  "storage",
  "evidence_root",
  "static_dir",
  "auth_mode",
  "ldap_tls",
  "cookie_security",
  "rust_bridge",
  "profile_catalog",
  "port",
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export const DOCTOR_CHECK_STATUSES = ["ok", "warn", "error"] as const;
export type DoctorCheckStatus = (typeof DOCTOR_CHECK_STATUSES)[number];

export const DOCTOR_CAVEATS = [
  "doctor_checks_configuration_shape_only",
  "not_provider_compatibility",
  "live_results_are_not_fabricated",
] as const;
export type DoctorCaveat = (typeof DOCTOR_CAVEATS)[number];

export interface DoctorCheckV1 {
  id: DoctorCheckId;
  status: DoctorCheckStatus;
  summary: string;
}

export interface DoctorReportV1 {
  schemaId: typeof DOCTOR_REPORT_SCHEMA_ID;
  privacyClass: "share_safe";
  ok: boolean;
  errorCount: number;
  warnCount: number;
  checks: DoctorCheckV1[];
  caveats: DoctorCaveat[];
}

export interface ProfileCatalogEntryV1 {
  alias: LiveProfileAlias;
}

export interface ProfileCatalogV1 {
  schemaId: typeof PROFILE_CATALOG_SCHEMA_ID;
  privacyClass: "share_safe";
  profiles: ProfileCatalogEntryV1[];
}

const checkShape: ObjectShape = {
  id: f.req(f.en(...DOCTOR_CHECK_IDS)),
  status: f.req(f.en(...DOCTOR_CHECK_STATUSES)),
  summary: f.req(f.str),
};

const reportShape: ObjectShape = {
  schemaId: f.req(f.en(DOCTOR_REPORT_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  ok: f.req(f.bool),
  errorCount: f.req(f.u64),
  warnCount: f.req(f.u64),
  checks: f.req(f.arr(f.obj(checkShape))),
  caveats: f.req(f.arr(f.en(...DOCTOR_CAVEATS))),
};

const catalogEntryShape: ObjectShape = {
  alias: f.req(f.en(...LIVE_PROFILE_ALIASES)),
};

const catalogShape: ObjectShape = {
  schemaId: f.req(f.en(PROFILE_CATALOG_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  profiles: f.req(f.arr(f.obj(catalogEntryShape))),
};

function assertDoctorChecks(checks: readonly DoctorCheckV1[]): void {
  if (checks.length !== DOCTOR_CHECK_IDS.length) {
    throw new Error("doctor report must include each check id once");
  }
  const seen = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.id)) throw new Error(`duplicate doctor check ${check.id}`);
    seen.add(check.id);
  }
  for (const id of DOCTOR_CHECK_IDS) {
    if (!seen.has(id)) throw new Error(`doctor report missing check ${id}`);
  }
}

function assertCaveats(caveats: readonly string[]): void {
  if (caveats.length !== DOCTOR_CAVEATS.length || new Set(caveats).size !== caveats.length) {
    throw new Error("doctor report must include each required caveat once");
  }
  for (const caveat of DOCTOR_CAVEATS) {
    if (!caveats.includes(caveat)) {
      throw new Error(`doctor report missing caveat ${caveat}`);
    }
  }
}

export function parseDoctorReport(raw: unknown): DoctorReportV1 {
  checkObject("$", reportShape, raw);
  const row = raw as DoctorReportV1;
  assertDoctorChecks(row.checks);
  assertCaveats(row.caveats);
  const errorCount = row.checks.filter((check) => check.status === "error").length;
  const warnCount = row.checks.filter((check) => check.status === "warn").length;
  if (row.errorCount !== errorCount || row.warnCount !== warnCount) {
    throw new Error("doctor report counts must match check statuses");
  }
  if (row.ok !== (errorCount === 0)) {
    throw new Error("doctor report ok must be true only when there are no errors");
  }
  assertShareSafePrivacy(row);
  return row;
}

export function parseProfileCatalog(raw: unknown): ProfileCatalogV1 {
  checkObject("$", catalogShape, raw);
  const row = raw as ProfileCatalogV1;
  const aliases = new Set<string>();
  for (const profile of row.profiles) {
    if (aliases.has(profile.alias)) {
      throw new Error(`duplicate profile catalog alias ${profile.alias}`);
    }
    aliases.add(profile.alias);
  }
  assertShareSafePrivacy(row);
  return row;
}

export function doctorExitCode(report: DoctorReportV1): number {
  return report.ok ? 0 : 1;
}

export function renderDoctorSummary(report: DoctorReportV1): string {
  const lines = report.checks.map((check) => {
    const tag = check.status.toUpperCase().padEnd(5, " ");
    return `${tag} ${check.id} ${check.summary}`;
  });
  lines.push(
    report.ok
      ? `verdict ready_for_config_shape errors=${report.errorCount} warnings=${report.warnCount}`
      : `verdict unsafe_config errors=${report.errorCount} warnings=${report.warnCount}`,
  );
  lines.push("doctor checks configuration shape only; it does not prove provider compatibility");
  return lines.join("\n");
}
