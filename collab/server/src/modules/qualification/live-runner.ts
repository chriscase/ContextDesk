import { createHash } from "node:crypto";
import {
  LIVE_PROFILE_ALIASES,
  LIVE_QUALIFICATION_CAVEATS,
  LIVE_QUALIFICATION_REPORT_SCHEMA_ID,
  parseLiveQualificationReport,
  type LiveProfileAlias,
  type LiveQualificationCatalogV1,
  type LiveQualificationLaneV1,
  type LiveQualificationReportV1,
  type LiveQualificationSkipReason,
  type TriageJobStatus,
} from "@cd-collab/contracts";
import type { Actor, CaseService } from "../cases/index.js";
import { TriageRunService } from "../triage-runs/index.js";

const DEFAULT_QUESTION =
  "What happened in this checkout incident, what evidence supports it, and what should we inspect next?";
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 25;
const CANCEL_SETTLE_MS = 2_000;
const TERMINAL_STATUSES = new Set<TriageJobStatus>([
  "completed",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
]);

const SAFE_ERROR_CODES = new Set<NonNullable<LiveQualificationLaneV1["errorCode"]>>([
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
]);

export interface LiveQualificationRunnerOptions {
  cases: CaseService;
  triageRuns: TriageRunService;
  catalog: LiveQualificationCatalogV1 | null;
  actor?: Actor;
  aliases?: readonly LiveProfileAlias[];
  liveOptIn: boolean;
  confirmed: boolean;
  concurrency: number;
  timeoutMs?: number;
  question?: string;
}

export interface LiveQualificationFixtureV1 {
  snapshotFingerprint: string;
  taskFingerprint: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uniqueAliases(aliases: readonly LiveProfileAlias[] | undefined): LiveProfileAlias[] {
  if (!aliases || aliases.length === 0) return [...LIVE_PROFILE_ALIASES];
  return [...new Set(aliases)];
}

function skipLane(
  alias: LiveProfileAlias,
  reason: LiveQualificationSkipReason,
  profile?: LiveQualificationCatalogV1["profiles"][number],
): LiveQualificationLaneV1 {
  return {
    alias,
    profileId: profile?.profileId ?? null,
    modelId: profile?.modelId ?? null,
    provider: profile?.provider ?? null,
    label: profile?.label ?? null,
    configured: profile !== undefined,
    ran: false,
    status: "skipped",
    skippedReason: reason,
    errorCode: null,
    evidenceCount: 0,
    unknownCount: 0,
    startedAt: null,
    finishedAt: null,
  };
}

function safeErrorCode(value: string | null): LiveQualificationLaneV1["errorCode"] {
  if (value && SAFE_ERROR_CODES.has(value as NonNullable<LiveQualificationLaneV1["errorCode"]>)) {
    return value as NonNullable<LiveQualificationLaneV1["errorCode"]>;
  }
  return "gateway_error";
}

function reportVerdict(
  lanes: readonly LiveQualificationLaneV1[],
  sameSnapshot: boolean | null,
): LiveQualificationReportV1["verdict"] {
  const ran = lanes.filter((lane) => lane.ran);
  if (ran.length === 0) return "skipped";
  // A live qualification is a requested matrix, not a best-effort sample.
  // Never call a matrix complete when an alias was skipped or the bridge did
  // not prove the shared snapshot.
  if (lanes.some((lane) => !lane.ran)) return "failed";
  if (sameSnapshot !== true) return "failed";
  if (ran.every((lane) => lane.status === "completed")) return "completed";
  if (ran.some((lane) => lane.status === "completed" || lane.status === "partial")) return "partial";
  if (ran.every((lane) => lane.status === "cancelled")) return "inconclusive";
  return "failed";
}

function estimateObservedMaxActive(
  candidates: ReadonlyArray<NonNullable<Awaited<ReturnType<TriageRunService["get"]>>>["candidates"][number]>,
): number | null {
  const events: { at: number; delta: 1 | -1 }[] = [];
  for (const candidate of candidates) {
    if (!candidate.startedAt || !candidate.finishedAt) continue;
    const started = Date.parse(candidate.startedAt);
    const finished = Date.parse(candidate.finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) continue;
    events.push({ at: started, delta: 1 }, { at: finished, delta: -1 });
  }
  if (events.length === 0) return null;
  events.sort((a, b) => a.at - b.at || b.delta - a.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createFixture(
  cases: CaseService,
  actor: Actor,
  question: string,
): Promise<LiveQualificationFixtureV1 & { caseId: string; snapshotId: string }> {
  const created = await cases.createCase(
    actor,
    { title: "Live qualification checkout evidence" },
    "qualification-live",
  );
  const artifact = await cases.addEvidence(
    created.id,
    actor,
    {
      kind: "log",
      filename: "qualification-checkout.log",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode(
        "checkout request timed out while the inventory service was unavailable\n",
      ),
      summary: "Synthetic checkout timeout evidence for release qualification.",
      privacyClass: "share_safe",
    },
    "qualification-live",
  );
  const snapshot = await cases.createSnapshot(
    created.id,
    actor,
    { evidenceIds: [artifact.artifact.id], visibility: "share_safe" },
    "qualification-live",
  );
  return {
    caseId: created.id,
    snapshotId: snapshot.id,
    snapshotFingerprint: snapshot.fingerprint,
    taskFingerprint: sha256(`${snapshot.fingerprint}:${question}`),
  };
}

async function waitForTerminal(
  service: TriageRunService,
  caseId: string,
  jobId: string,
  actor: Actor,
  timeoutMs: number,
): Promise<Awaited<ReturnType<TriageRunService["get"]>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await service.get(caseId, jobId, actor, true);
    if (current && TERMINAL_STATUSES.has(current.status)) return current;
    await wait(POLL_MS);
  }
  return null;
}

function projectRanLane(
  alias: LiveProfileAlias,
  profile: LiveQualificationCatalogV1["profiles"][number],
  candidate: NonNullable<Awaited<ReturnType<TriageRunService["get"]>>>["candidates"][number],
): LiveQualificationLaneV1 {
  const status = (TERMINAL_STATUSES.has(candidate.status) ? candidate.status : "failed") as Exclude<
    LiveQualificationLaneV1["status"],
    "skipped"
  >;
  const errorCode = status === "completed" ? null : safeErrorCode(candidate.errorCode);
  return {
    alias,
    profileId: profile.profileId,
    modelId: profile.modelId,
    provider: profile.provider,
    label: profile.label,
    configured: true,
    ran: true,
    status,
    skippedReason: null,
    errorCode,
    evidenceCount: candidate.evidenceRefs.length,
    unknownCount: candidate.unknowns.length,
    startedAt: candidate.startedAt,
    finishedAt: candidate.finishedAt,
  };
}

function failedLane(
  alias: LiveProfileAlias,
  profile: LiveQualificationCatalogV1["profiles"][number],
  errorCode: NonNullable<LiveQualificationLaneV1["errorCode"]>,
): LiveQualificationLaneV1 {
  return {
    alias,
    profileId: profile.profileId,
    modelId: profile.modelId,
    provider: profile.provider,
    label: profile.label,
    configured: true,
    ran: true,
    status: "failed",
    skippedReason: null,
    errorCode,
    evidenceCount: 0,
    unknownCount: 1,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * Runs a bounded, same-snapshot live matrix only after explicit opt-in and
 * confirmation. The host bridge remains the credential owner; this module
 * only receives the bridge's already-sanitized TriageJob projection.
 */
export async function runLiveQualification(
  options: LiveQualificationRunnerOptions,
): Promise<LiveQualificationReportV1> {
  const actor = options.actor ?? { id: "qualification-runner", username: "qualification" };
  const question = options.question ?? DEFAULT_QUESTION;
  const concurrency = Number.isSafeInteger(options.concurrency)
    ? Math.min(4, Math.max(1, options.concurrency))
    : 2;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs)
    ? Math.min(900_000, Math.max(1_000, options.timeoutMs as number))
    : DEFAULT_TIMEOUT_MS;
  const aliases = uniqueAliases(options.aliases);
  const fixture = await createFixture(options.cases, actor, question);
  const profiles = new Map((options.catalog?.profiles ?? []).map((profile) => [profile.alias, profile]));
  let lanes = aliases.map((alias) => {
    const profile = profiles.get(alias);
    if (!options.liveOptIn) return skipLane(alias, "live_disabled", profile);
    if (!profile) return skipLane(alias, options.catalog ? "profile_not_configured" : "catalog_missing");
    if (!options.confirmed) return skipLane(alias, "confirmation_required", profile);
    return null;
  });

  const readyProfiles = aliases
    .map((alias) => profiles.get(alias))
    .filter((profile): profile is NonNullable<typeof profile> => profile !== undefined);
  const capabilities = options.triageRuns.capabilities();
  const pendingProfiles = readyProfiles.filter((profile) => !lanes.some((lane) => lane?.alias === profile.alias));
  if (pendingProfiles.length > 0 && !capabilities.gatewayAvailable) {
    lanes = lanes.map((lane, index) => {
      if (lane || !readyProfiles.some((profile) => profile.alias === aliases[index])) return lane;
      const profile = readyProfiles.find((item) => item.alias === aliases[index]);
      return profile ? skipLane(profile.alias, "bridge_not_configured", profile) : lane;
    });
  } else if (pendingProfiles.length > 0 && pendingProfiles.length < 2) {
    lanes = lanes.map((lane, index) => {
      if (lane || !readyProfiles.some((profile) => profile.alias === aliases[index])) return lane;
      const profile = readyProfiles.find((item) => item.alias === aliases[index]);
      return profile ? skipLane(profile.alias, "not_enough_profiles", profile) : lane;
    });
  }

  const runnableProfiles = readyProfiles.filter((profile) =>
    aliases.includes(profile.alias) && !lanes.some((lane) => lane?.alias === profile.alias),
  );
  let observedMaxActive: number | null = null;
  let sameSnapshot: boolean | null = null;
  if (runnableProfiles.length >= 2 && capabilities.gatewayAvailable) {
    try {
      const created = await options.triageRuns.create(
        fixture.caseId,
        actor,
        {
          schemaId: "cd-collab.triage_job_request.v1",
          snapshotId: fixture.snapshotId,
          mode: "gateway",
          strategyId: "contextdesk.standard",
          question,
          policyFingerprint: null,
          taskFingerprint: fixture.taskFingerprint,
          concurrency,
          candidates: runnableProfiles.map((profile) => ({
            candidateId: `live-${profile.alias}`,
            role: "comparison",
            provider: profile.provider,
            profileId: profile.profileId,
            model: profile.modelId,
            version: null,
          })),
        },
        "qualification-live",
        true,
      );
      let finalJob = await waitForTerminal(options.triageRuns, fixture.caseId, created.id, actor, timeoutMs);
      if (!finalJob) {
        await options.triageRuns.cancel(fixture.caseId, created.id, actor, "qualification-live", true);
        finalJob = await waitForTerminal(
          options.triageRuns,
          fixture.caseId,
          created.id,
          actor,
          CANCEL_SETTLE_MS,
        );
      }
      if (!finalJob) {
        lanes = aliases.map((alias) => {
          const profile = profiles.get(alias);
          return profile && runnableProfiles.some((item) => item.alias === alias)
            ? failedLane(alias, profile, "deadline_exceeded")
            : lanes.find((lane) => lane?.alias === alias) ?? skipLane(alias, "profile_not_configured");
        });
      } else {
        sameSnapshot = finalJob.sameSnapshot;
        observedMaxActive = estimateObservedMaxActive(finalJob.candidates);
        lanes = aliases.map((alias) => {
          const profile = profiles.get(alias);
          const candidate = finalJob?.candidates.find((item) => item.candidateId === `live-${alias}`);
          return profile && candidate
            ? projectRanLane(alias, profile, candidate)
            : lanes.find((lane) => lane?.alias === alias) ?? skipLane(alias, "profile_not_configured");
        });
      }
    } catch (error) {
      const code = error instanceof Error && error.message.includes("deadline")
        ? "deadline_exceeded"
        : "gateway_runner_error";
      lanes = aliases.map((alias) => {
        const profile = profiles.get(alias);
        return profile && runnableProfiles.some((item) => item.alias === alias)
          ? failedLane(alias, profile, code)
          : lanes.find((lane) => lane?.alias === alias) ?? skipLane(alias, "profile_not_configured");
      });
    }
  }

  const report: LiveQualificationReportV1 = {
    schemaId: LIVE_QUALIFICATION_REPORT_SCHEMA_ID,
    privacyClass: "share_safe",
    liveOptIn: options.liveOptIn,
    confirmed: options.confirmed,
    snapshotFingerprint: fixture.snapshotFingerprint,
    taskFingerprint: fixture.taskFingerprint,
    concurrency: {
      configuredLimit: concurrency,
      observedMaxActive,
      sameSnapshot,
    },
    lanes: lanes.map((lane, index) => lane ?? skipLane(aliases[index]!, "not_enough_profiles")),
    verdict: reportVerdict(
      lanes.map((lane, index) => lane ?? skipLane(aliases[index]!, "not_enough_profiles")),
      sameSnapshot,
    ),
    caveats: [...LIVE_QUALIFICATION_CAVEATS],
  };
  return parseLiveQualificationReport(report);
}
