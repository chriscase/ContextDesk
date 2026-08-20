import { checkObject, f, type ObjectShape } from "./parse.js";
import { assertShareSafePrivacy } from "./privacy.js";

export const QUALIFICATION_REPORT_SCHEMA_ID = "cd-collab.qualification_report.v1" as const;

export const QUALIFICATION_CAVEATS = [
  "agreement_not_correctness",
  "gold_is_human_benchmark",
  "live_results_are_not_fabricated",
] as const;
export type QualificationCaveat = (typeof QUALIFICATION_CAVEATS)[number];

export const QUALIFICATION_BACKENDS = ["memory", "sqlite", "postgres"] as const;
export type QualificationBackend = (typeof QUALIFICATION_BACKENDS)[number];

export const QUALIFICATION_STEP_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "partial",
] as const;
export type QualificationStepStatus = (typeof QUALIFICATION_STEP_STATUSES)[number];

export const LIVE_PROFILE_ALIASES = [
  "gpt-oss-120b",
  "qwen-3.6-27b",
  "ministral-3-14b-instruct-2512",
  "vercel-compatible",
] as const;
export type LiveProfileAlias = (typeof LIVE_PROFILE_ALIASES)[number];

export interface QualificationStepV1 {
  id: string;
  status: QualificationStepStatus;
  note: string;
}

export interface QualificationLiveProfileV1 {
  alias: LiveProfileAlias;
  configured: boolean;
  ran: boolean;
  skippedReason: string | null;
}

export interface QualificationComparisonV1 {
  sharedEvidenceCount: number;
  uniqueEvidenceCount: number;
  disagreementCount: number;
  questionPathCount: number;
  helpfulnessRecorded: boolean;
  goldAligned: boolean;
  acceptedDecision: boolean;
}

export interface QualificationLineageV1 {
  predecessorPackageAlias: string;
  successorPackageAlias: string;
  goldVersion: number;
  predecessorGoldPresent: boolean;
}

export interface QualificationReportV1 {
  schemaId: typeof QUALIFICATION_REPORT_SCHEMA_ID;
  privacyClass: "share_safe";
  backend: QualificationBackend;
  steps: QualificationStepV1[];
  comparison: QualificationComparisonV1;
  lineage: QualificationLineageV1;
  liveProfiles: QualificationLiveProfileV1[];
  caveats: QualificationCaveat[];
}

const stepShape: ObjectShape = {
  id: f.req(f.str),
  status: f.req(f.en(...QUALIFICATION_STEP_STATUSES)),
  note: f.req(f.str),
};

const liveShape: ObjectShape = {
  alias: f.req(f.en(...LIVE_PROFILE_ALIASES)),
  configured: f.req(f.bool),
  ran: f.req(f.bool),
  skippedReason: f.nul(f.str),
};

const comparisonShape: ObjectShape = {
  sharedEvidenceCount: f.req(f.u64),
  uniqueEvidenceCount: f.req(f.u64),
  disagreementCount: f.req(f.u64),
  questionPathCount: f.req(f.u64),
  helpfulnessRecorded: f.req(f.bool),
  goldAligned: f.req(f.bool),
  acceptedDecision: f.req(f.bool),
};

const lineageShape: ObjectShape = {
  predecessorPackageAlias: f.req(f.str),
  successorPackageAlias: f.req(f.str),
  goldVersion: f.req(f.u64),
  predecessorGoldPresent: f.req(f.bool),
};

const reportShape: ObjectShape = {
  schemaId: f.req(f.en(QUALIFICATION_REPORT_SCHEMA_ID)),
  privacyClass: f.req(f.en("share_safe")),
  backend: f.req(f.en(...QUALIFICATION_BACKENDS)),
  steps: f.req(f.arr(f.obj(stepShape))),
  comparison: f.req(f.obj(comparisonShape)),
  lineage: f.req(f.obj(lineageShape)),
  liveProfiles: f.req(f.arr(f.obj(liveShape))),
  caveats: f.req(f.arr(f.en(...QUALIFICATION_CAVEATS))),
};

function assertCaveats(caveats: readonly string[]): void {
  if (
    caveats.length !== QUALIFICATION_CAVEATS.length ||
    new Set(caveats).size !== caveats.length
  ) {
    throw new Error("qualification report must include each required caveat once");
  }
  for (const caveat of QUALIFICATION_CAVEATS) {
    if (!caveats.includes(caveat)) {
      throw new Error(`qualification report missing caveat ${caveat}`);
    }
  }
}

export function parseQualificationReport(raw: unknown): QualificationReportV1 {
  checkObject("$", reportShape, raw);
  const row = raw as QualificationReportV1;
  assertCaveats(row.caveats);
  for (const profile of row.liveProfiles) {
    if (profile.ran && !profile.configured) {
      throw new Error("live profile cannot be marked ran when it was not configured");
    }
    if (!profile.configured && profile.skippedReason === null) {
      throw new Error("unconfigured live profile must name a skip reason");
    }
    if (profile.configured && profile.ran && profile.skippedReason !== null) {
      throw new Error("a ran live profile must not carry a skip reason");
    }
  }
  assertShareSafePrivacy(row);
  return row;
}
