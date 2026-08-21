import { checkObject, f, type ObjectShape } from "./parse.js";
import {
  assertShareSafeFingerprint,
  assertShareSafePrivacy,
} from "./privacy.js";
import { LIVE_PROFILE_ALIASES, type LiveProfileAlias } from "./qualification.js";

export const LIVE_QUALIFICATION_CATALOG_SCHEMA_ID =
  "cd-collab.live_qualification_catalog.v1" as const;
export const LIVE_QUALIFICATION_REPORT_SCHEMA_ID =
  "cd-collab.live_qualification_report.v1" as const;

export const LIVE_QUALIFICATION_STATUSES = [
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
] as const;
export type LiveQualificationStatus = (typeof LIVE_QUALIFICATION_STATUSES)[number];

export const LIVE_QUALIFICATION_VERDICTS = [
  "completed",
  "partial",
  "failed",
  "inconclusive",
  "skipped",
] as const;
export type LiveQualificationVerdict = (typeof LIVE_QUALIFICATION_VERDICTS)[number];

export const LIVE_QUALIFICATION_SKIP_REASONS = [
  "live_disabled",
  "confirmation_required",
  "catalog_missing",
  "profile_not_configured",
  "bridge_not_configured",
  "not_enough_profiles",
] as const;
export type LiveQualificationSkipReason = (typeof LIVE_QUALIFICATION_SKIP_REASONS)[number];

export const LIVE_QUALIFICATION_ERROR_CODES = [
  "runner_error",
  "gateway_runner_error",
  "gateway_error",
  "deadline_exceeded",
  "cancel_requested",
  "output_overflow",
  "executor_error",
  "provider_error",
  "provider_unavailable",
  "provider_rate_limited",
  "provider_call_budget_exhausted",
  "malformed_output",
] as const;
export type LiveQualificationErrorCode = (typeof LIVE_QUALIFICATION_ERROR_CODES)[number];

export const LIVE_QUALIFICATION_CAVEATS = [
  "agreement_not_correctness",
  "usage_and_cost_unknown",
  "live_results_are_not_fabricated",
  "raw_output_not_in_report",
] as const;
export type LiveQualificationCaveat = (typeof LIVE_QUALIFICATION_CAVEATS)[number];

export interface LiveQualificationProfileV1 {
  alias: LiveProfileAlias;
  profileId: string;
  modelId: string;
  provider: string;
  label: string;
}

export interface LiveQualificationCatalogV1 {
  schemaId: typeof LIVE_QUALIFICATION_CATALOG_SCHEMA_ID;
  privacyClass: "share_safe";
  profiles: LiveQualificationProfileV1[];
}

export interface LiveQualificationLaneV1 {
  alias: LiveProfileAlias;
  profileId: string | null;
  modelId: string | null;
  provider: string | null;
  label: string | null;
  configured: boolean;
  ran: boolean;
  status: LiveQualificationStatus;
  skippedReason: LiveQualificationSkipReason | null;
  errorCode: LiveQualificationErrorCode | null;
  evidenceCount: number;
  unknownCount: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LiveQualificationConcurrencyV1 {
  configuredLimit: number;
  observedMaxActive: number | null;
  sameSnapshot: boolean | null;
}

export interface LiveQualificationReportV1 {
  schemaId: typeof LIVE_QUALIFICATION_REPORT_SCHEMA_ID;
  privacyClass: "share_safe";
  liveOptIn: boolean;
  confirmed: boolean;
  snapshotFingerprint: string;
  taskFingerprint: string;
  concurrency: LiveQualificationConcurrencyV1;
  lanes: LiveQualificationLaneV1[];
  verdict: LiveQualificationVerdict;
  caveats: LiveQualificationCaveat[];
}

const profileShape: ObjectShape = {
  alias: f.req(f.en(...LIVE_PROFILE_ALIASES)),
  profileId: f.req(f.str),
  modelId: f.req(f.str),
  provider: f.req(f.str),
  label: f.req(f.str),
};

const catalogShape: ObjectShape = {
  schemaId: f.req(f.en(LIVE_QUALIFICATION_CATALOG_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  profiles: f.req(f.arr(f.obj(profileShape))),
};

const laneShape: ObjectShape = {
  alias: f.req(f.en(...LIVE_PROFILE_ALIASES)),
  profileId: f.nul(f.str),
  modelId: f.nul(f.str),
  provider: f.nul(f.str),
  label: f.nul(f.str),
  configured: f.req(f.bool),
  ran: f.req(f.bool),
  status: f.req(f.en(...LIVE_QUALIFICATION_STATUSES)),
  skippedReason: f.nul(f.en(...LIVE_QUALIFICATION_SKIP_REASONS)),
  errorCode: f.nul(f.en(...LIVE_QUALIFICATION_ERROR_CODES)),
  evidenceCount: f.req(f.u64),
  unknownCount: f.req(f.u64),
  startedAt: f.nul(f.str),
  finishedAt: f.nul(f.str),
};

const concurrencyShape: ObjectShape = {
  configuredLimit: f.req(f.u64),
  observedMaxActive: f.nul(f.u64),
  sameSnapshot: f.nul(f.bool),
};

const reportShape: ObjectShape = {
  schemaId: f.req(f.en(LIVE_QUALIFICATION_REPORT_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  liveOptIn: f.req(f.bool),
  confirmed: f.req(f.bool),
  snapshotFingerprint: f.req(f.str),
  taskFingerprint: f.req(f.str),
  concurrency: f.req(f.obj(concurrencyShape)),
  lanes: f.req(f.arr(f.obj(laneShape))),
  verdict: f.req(f.en(...LIVE_QUALIFICATION_VERDICTS)),
  caveats: f.req(f.arr(f.en(...LIVE_QUALIFICATION_CAVEATS))),
};

function nonEmpty(name: string, value: string): void {
  if (
    value.trim().length === 0
    || value.length > 160
    || value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")
  ) {
    throw new Error(`${name} must be a bounded single-line value`);
  }
}

function assertCatalogProfiles(profiles: readonly LiveQualificationProfileV1[]): void {
  const aliases = new Set<string>();
  for (const profile of profiles) {
    if (aliases.has(profile.alias)) throw new Error(`duplicate live profile ${profile.alias}`);
    aliases.add(profile.alias);
    nonEmpty("profileId", profile.profileId);
    nonEmpty("modelId", profile.modelId);
    nonEmpty("provider", profile.provider);
    nonEmpty("label", profile.label);
  }
}

export function parseLiveQualificationCatalog(raw: unknown): LiveQualificationCatalogV1 {
  checkObject("$", catalogShape, raw);
  const row = raw as LiveQualificationCatalogV1;
  assertCatalogProfiles(row.profiles);
  assertShareSafePrivacy(row);
  return row;
}

function assertLane(lane: LiveQualificationLaneV1): void {
  const hasProvenance = lane.profileId !== null && lane.modelId !== null && lane.provider !== null && lane.label !== null;
  if (lane.configured !== hasProvenance) {
    throw new Error(`live lane ${lane.alias} configured state must match provenance`);
  }
  if (!lane.ran) {
    if (lane.status !== "skipped" || lane.skippedReason === null) {
      throw new Error(`unrun live lane ${lane.alias} must be skipped with a reason`);
    }
    if (lane.errorCode !== null || lane.startedAt !== null || lane.finishedAt !== null) {
      throw new Error(`unrun live lane ${lane.alias} cannot carry execution fields`);
    }
  } else {
    if (!lane.configured || lane.status === "skipped" || lane.skippedReason !== null) {
      throw new Error(`ran live lane ${lane.alias} must be configured and terminal`);
    }
    if (lane.status === "completed" && lane.errorCode !== null) {
      throw new Error(`completed live lane ${lane.alias} cannot carry an error`);
    }
    if (lane.status !== "completed" && lane.errorCode === null) {
      throw new Error(`non-completed live lane ${lane.alias} must carry a safe error code`);
    }
  }
}

function assertCaveats(caveats: readonly string[]): void {
  if (caveats.length !== LIVE_QUALIFICATION_CAVEATS.length || new Set(caveats).size !== caveats.length) {
    throw new Error("live qualification report must include each caveat once");
  }
  for (const caveat of LIVE_QUALIFICATION_CAVEATS) {
    if (!caveats.includes(caveat)) throw new Error(`live qualification report missing caveat ${caveat}`);
  }
}

export function parseLiveQualificationReport(raw: unknown): LiveQualificationReportV1 {
  checkObject("$", reportShape, raw);
  const row = raw as LiveQualificationReportV1;
  assertShareSafeFingerprint("$.snapshotFingerprint", row.snapshotFingerprint);
  assertShareSafeFingerprint("$.taskFingerprint", row.taskFingerprint);
  if (row.concurrency.configuredLimit < 1 || row.concurrency.configuredLimit > 4) {
    throw new Error("live qualification concurrency must be between 1 and 4");
  }
  const aliases = new Set<string>();
  for (const lane of row.lanes) {
    if (aliases.has(lane.alias)) throw new Error(`duplicate live qualification lane ${lane.alias}`);
    aliases.add(lane.alias);
    assertLane(lane);
  }
  if (!row.liveOptIn && (row.confirmed || row.lanes.some((lane) => lane.ran))) {
    throw new Error("live qualification cannot run without opt-in");
  }
  if (row.confirmed && !row.liveOptIn) throw new Error("live confirmation requires live opt-in");
  assertCaveats(row.caveats);
  assertShareSafePrivacy(row);
  return row;
}

export function renderLiveQualificationSummary(report: LiveQualificationReportV1): string {
  const ran = report.lanes.filter((lane) => lane.ran);
  const skipped = report.lanes.filter((lane) => !lane.ran).map((lane) => `${lane.alias} (${lane.skippedReason})`);
  return [
    `live qualification verdict=${report.verdict} opt_in=${report.liveOptIn} confirmed=${report.confirmed}`,
    `lanes ran=${ran.length} completed=${ran.filter((lane) => lane.status === "completed").length} concurrency=${report.concurrency.observedMaxActive ?? "unknown"}/${report.concurrency.configuredLimit} same_snapshot=${report.concurrency.sameSnapshot ?? "unknown"}`,
    `skipped: ${skipped.join(", ") || "none"}`,
    "agreement is not proof of correctness; usage and cost remain unknown",
  ].join("\n");
}
