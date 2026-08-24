import { APP_ROLES, type AppRole, type IdentityV1 } from "./auth.js";
import { CASE_SEVERITIES, type CaseSeverity } from "./case.js";
import { ContractViolation, checkObject, f, type ObjectShape } from "./parse.js";
import { PRESENCE_SURFACES, type PresenceSurface } from "./presence.js";

export const OVERVIEW_SCHEMA_ID = "cd-collab.overview.v1" as const;

export const OVERVIEW_OPEN_CASE_CAP = 12 as const;
export const OVERVIEW_ACTIVITY_CAP = 20 as const;
export const OVERVIEW_RUNNING_JOB_CAP = 20 as const;
export const OVERVIEW_TERMINAL_JOB_CAP = 20 as const;
export const OVERVIEW_ATTENTION_CAP = 20 as const;
export const OVERVIEW_PRESENCE_CAP = 20 as const;

export const OVERVIEW_OPEN_STATUSES = ["open", "monitoring"] as const;
export type OverviewOpenStatus = (typeof OVERVIEW_OPEN_STATUSES)[number];

export const OVERVIEW_RUNNING_JOB_STATUSES = ["queued", "running"] as const;
export type OverviewRunningJobStatus = (typeof OVERVIEW_RUNNING_JOB_STATUSES)[number];

export const OVERVIEW_TERMINAL_JOB_STATUSES = [
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
] as const;
export type OverviewTerminalJobStatus = (typeof OVERVIEW_TERMINAL_JOB_STATUSES)[number];

export const OVERVIEW_ATTENTION_PREDICATES = [
  "accept_eligible_proposal",
  "own_open_proposal",
] as const;
export type OverviewAttentionPredicate = (typeof OVERVIEW_ATTENTION_PREDICATES)[number];

export const OVERVIEW_PRESENCE_REASONS = ["ephemeral_live", "static_snapshot"] as const;
export type OverviewPresenceReason = (typeof OVERVIEW_PRESENCE_REASONS)[number];

export const OVERVIEW_NOTICES = [
  "Recorded counts are not progress or completeness.",
  "Overview is not the full investigation inventory.",
  "Presence is ephemeral and is not evidence.",
  "Agreement is not proof of correctness, and cost and usage may remain unknown.",
  "No blocked or stale investigation state exists unless it is recorded.",
  "Attention names only an accept-eligible proposed decision the current lead or admin did not author, or the current actor's own still-open proposal.",
] as const;
export type OverviewNoticeV1 = (typeof OVERVIEW_NOTICES)[number];

export interface OverviewViewerV1 {
  identity: IdentityV1;
  roles: AppRole[];
}

export interface OverviewStatusCountsV1 {
  open: number;
  monitoring: number;
  resolved: number;
  archived: number;
}

export interface OverviewSeverityCountsV1 {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

export interface OverviewOpenCaseV1 {
  id: string;
  title: string;
  status: OverviewOpenStatus;
  severity: CaseSeverity;
  createdAt: string;
}

export interface OverviewActivityV1 {
  caseId: string;
  title: string;
  kind: string;
  actor: string;
  serverTime: string;
  seq: number;
}

export interface OverviewJobV1 {
  id: string;
  caseId: string;
  caseTitle: string;
  status: OverviewRunningJobStatus | OverviewTerminalJobStatus;
  strategyId: string;
  strategyVersion?: string;
  sameSnapshot: boolean | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface OverviewPresenceMemberV1 {
  caseId: string;
  identityId: string;
  username: string;
  surface: PresenceSurface;
  lastSeenAt: string;
}

export interface OverviewPresenceV1 {
  available: boolean;
  reason: OverviewPresenceReason;
  ttlSeconds: number;
  members: OverviewPresenceMemberV1[];
}

export interface OverviewAttentionV1 {
  predicate: OverviewAttentionPredicate;
  caseId: string;
  caseTitle: string;
  experimentId: string;
  decisionId: string;
  revision: number;
  authorUsername: string;
  createdAt: string;
}

export interface OverviewV1 {
  schemaId: typeof OVERVIEW_SCHEMA_ID;
  generatedAt: string;
  viewer: OverviewViewerV1;
  statusCounts: OverviewStatusCountsV1;
  severityCounts: OverviewSeverityCountsV1;
  openCases: OverviewOpenCaseV1[];
  recentActivity: OverviewActivityV1[];
  queuedAndRunningJobs: OverviewJobV1[];
  recentTerminalJobs: OverviewJobV1[];
  presence: OverviewPresenceV1;
  attention: OverviewAttentionV1[];
  notices: OverviewNoticeV1[];
}

const identityShape: ObjectShape = {
  id: f.req(f.nstr),
  username: f.req(f.nstr),
  displayName: f.req(f.nstr),
};

const viewerShape: ObjectShape = {
  identity: f.req(f.obj(identityShape)),
  roles: f.req(f.arr(f.en(...APP_ROLES))),
};

const statusCountsShape: ObjectShape = {
  open: f.req(f.u64),
  monitoring: f.req(f.u64),
  resolved: f.req(f.u64),
  archived: f.req(f.u64),
};

const severityCountsShape: ObjectShape = {
  low: f.req(f.u64),
  medium: f.req(f.u64),
  high: f.req(f.u64),
  critical: f.req(f.u64),
};

const openCaseShape: ObjectShape = {
  id: f.req(f.nstr),
  title: f.req(f.nstr),
  status: f.req(f.en(...OVERVIEW_OPEN_STATUSES)),
  severity: f.req(f.en(...CASE_SEVERITIES)),
  createdAt: f.req(f.nstr),
};

const activityShape: ObjectShape = {
  caseId: f.req(f.nstr),
  title: f.req(f.nstr),
  kind: f.req(f.nstr),
  actor: f.req(f.nstr),
  serverTime: f.req(f.nstr),
  seq: f.req(f.u64),
};

const jobCore = {
  id: f.req(f.nstr),
  caseId: f.req(f.nstr),
  caseTitle: f.req(f.nstr),
  strategyId: f.req(f.nstr),
  strategyVersion: f.opt(f.nstr),
  sameSnapshot: f.nul(f.bool),
  createdAt: f.req(f.nstr),
  updatedAt: f.req(f.nstr),
  startedAt: f.nul(f.str),
  finishedAt: f.nul(f.str),
} as const;

const runningJobShape: ObjectShape = {
  ...jobCore,
  status: f.req(f.en(...OVERVIEW_RUNNING_JOB_STATUSES)),
};

const terminalJobShape: ObjectShape = {
  ...jobCore,
  status: f.req(f.en(...OVERVIEW_TERMINAL_JOB_STATUSES)),
};

const presenceMemberShape: ObjectShape = {
  caseId: f.req(f.nstr),
  identityId: f.req(f.nstr),
  username: f.req(f.nstr),
  surface: f.req(f.en(...PRESENCE_SURFACES)),
  lastSeenAt: f.req(f.nstr),
};

const presenceShape: ObjectShape = {
  available: f.req(f.bool),
  reason: f.req(f.en(...OVERVIEW_PRESENCE_REASONS)),
  ttlSeconds: f.req(f.u64),
  members: f.req(f.arr(f.obj(presenceMemberShape))),
};

const attentionShape: ObjectShape = {
  predicate: f.req(f.en(...OVERVIEW_ATTENTION_PREDICATES)),
  caseId: f.req(f.nstr),
  caseTitle: f.req(f.nstr),
  experimentId: f.req(f.nstr),
  decisionId: f.req(f.nstr),
  revision: f.req(f.u64),
  authorUsername: f.req(f.nstr),
  createdAt: f.req(f.nstr),
};

const overviewShape: ObjectShape = {
  schemaId: f.req(f.en(OVERVIEW_SCHEMA_ID)),
  generatedAt: f.req(f.nstr),
  viewer: f.req(f.obj(viewerShape)),
  statusCounts: f.req(f.obj(statusCountsShape)),
  severityCounts: f.req(f.obj(severityCountsShape)),
  openCases: f.req(f.arr(f.obj(openCaseShape))),
  recentActivity: f.req(f.arr(f.obj(activityShape))),
  queuedAndRunningJobs: f.req(f.arr(f.obj(runningJobShape))),
  recentTerminalJobs: f.req(f.arr(f.obj(terminalJobShape))),
  presence: f.req(f.obj(presenceShape)),
  attention: f.req(f.arr(f.obj(attentionShape))),
  notices: f.req(f.arr(f.en(...OVERVIEW_NOTICES))),
};

function assertCap(path: string, length: number, cap: number): void {
  if (length > cap) {
    throw new ContractViolation(path, `expected at most ${cap} items, got ${length}`);
  }
}

function assertExactNotices(notices: readonly string[]): void {
  if (notices.length !== OVERVIEW_NOTICES.length || new Set(notices).size !== notices.length) {
    throw new ContractViolation("$.notices", "expected each required notice exactly once");
  }
  for (const notice of OVERVIEW_NOTICES) {
    if (!notices.includes(notice)) {
      throw new ContractViolation("$.notices", `must include ${notice}`);
    }
  }
}

function assertPresenceHonesty(presence: OverviewPresenceV1): void {
  if (presence.reason === "static_snapshot") {
    if (presence.available) {
      throw new ContractViolation("$.presence.available", "static snapshots cannot claim live presence");
    }
    if (presence.members.length > 0) {
      throw new ContractViolation("$.presence.members", "static snapshots must not invent presence members");
    }
  }
  if (presence.reason === "ephemeral_live" && !presence.available) {
    throw new ContractViolation(
      "$.presence.available",
      "ephemeral_live presence must be available",
    );
  }
}

export function overviewPresenceForStaticSnapshot(ttlSeconds: number): OverviewPresenceV1 {
  return {
    available: false,
    reason: "static_snapshot",
    ttlSeconds,
    members: [],
  };
}

export function parseOverview(raw: unknown): OverviewV1 {
  checkObject("$", overviewShape, raw);
  const overview = raw as OverviewV1;
  assertCap("$.openCases", overview.openCases.length, OVERVIEW_OPEN_CASE_CAP);
  assertCap("$.recentActivity", overview.recentActivity.length, OVERVIEW_ACTIVITY_CAP);
  assertCap(
    "$.queuedAndRunningJobs",
    overview.queuedAndRunningJobs.length,
    OVERVIEW_RUNNING_JOB_CAP,
  );
  assertCap(
    "$.recentTerminalJobs",
    overview.recentTerminalJobs.length,
    OVERVIEW_TERMINAL_JOB_CAP,
  );
  assertCap("$.attention", overview.attention.length, OVERVIEW_ATTENTION_CAP);
  assertCap("$.presence.members", overview.presence.members.length, OVERVIEW_PRESENCE_CAP);
  assertExactNotices(overview.notices);
  assertPresenceHonesty(overview.presence);
  return overview;
}
