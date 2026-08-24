import {
  OVERVIEW_ACTIVITY_CAP,
  OVERVIEW_ATTENTION_CAP,
  OVERVIEW_NOTICES,
  OVERVIEW_OPEN_CASE_CAP,
  OVERVIEW_PRESENCE_CAP,
  OVERVIEW_RUNNING_JOB_CAP,
  OVERVIEW_RUNNING_JOB_STATUSES,
  OVERVIEW_SCHEMA_ID,
  OVERVIEW_TERMINAL_JOB_CAP,
  OVERVIEW_TERMINAL_JOB_STATUSES,
  overviewPresenceForStaticSnapshot,
  parseOverview,
  type AppRole,
  type IdentityV1,
  type OverviewAttentionV1,
  type OverviewJobV1,
  type OverviewPresenceV1,
  type OverviewV1,
  type TriageJobV1,
} from "@cd-collab/contracts";
import type { Actor, CaseService, OverviewScope } from "../cases/index.js";
import type { ExperimentService } from "../experiments/index.js";
import type { PresenceService } from "../presence/index.js";
import type { TriageRunService } from "../triage-runs/index.js";

export interface OverviewActor extends Actor {
  displayName: string;
  roles: AppRole[];
  isAdmin: boolean;
  canLead: boolean;
  canMutate: boolean;
}

export interface OverviewDeps {
  cases: CaseService;
  experiments: ExperimentService;
  triageRuns: TriageRunService;
  presence: PresenceService;
}

function projectJob(job: TriageJobV1, caseTitle: string): OverviewJobV1 {
  return {
    id: job.id,
    caseId: job.caseId,
    caseTitle,
    status: job.status,
    strategyId: job.request.strategyId,
    sameSnapshot: job.sameSnapshot,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function projectOverviewForStaticSnapshot(overview: OverviewV1): OverviewV1 {
  return parseOverview({
    ...overview,
    presence: overviewPresenceForStaticSnapshot(overview.presence.ttlSeconds),
  });
}

export class OverviewService {
  constructor(private readonly deps: OverviewDeps) {}

  async get(actor: OverviewActor): Promise<OverviewV1> {
    const scope: OverviewScope = { actorId: actor.id, isAdmin: actor.isAdmin };
    const visibleCaseTitle = (caseId: string) => this.deps.cases.overviewVisibleTitle(caseId, scope);
    const [
      counts,
      openCases,
      recentActivity,
      queuedAndRunningJobs,
      recentTerminalJobs,
      presenceMembers,
      ownProposals,
      acceptEligible,
    ] = await Promise.all([
      this.deps.cases.listOverviewCounts(scope),
      this.deps.cases.listOverviewOpenCases(scope, OVERVIEW_OPEN_CASE_CAP),
      this.deps.cases.listOverviewActivity(scope, OVERVIEW_ACTIVITY_CAP),
      this.deps.triageRuns.listOverviewJobs(
        scope,
        [...OVERVIEW_RUNNING_JOB_STATUSES],
        OVERVIEW_RUNNING_JOB_CAP,
      ),
      this.deps.triageRuns.listOverviewJobs(
        scope,
        [...OVERVIEW_TERMINAL_JOB_STATUSES],
        OVERVIEW_TERMINAL_JOB_CAP,
      ),
      this.deps.presence.listOverviewPresence({
        ...scope,
        limit: OVERVIEW_PRESENCE_CAP,
        visibleCaseTitle,
      }),
      actor.canMutate
        ? this.deps.experiments.listOverviewProposed({
            ...scope,
            limit: OVERVIEW_ATTENTION_CAP,
            authorId: actor.id,
          })
        : Promise.resolve([]),
      actor.canLead
        ? this.deps.experiments.listOverviewProposed({
            ...scope,
            limit: OVERVIEW_ATTENTION_CAP,
            excludeAuthorId: actor.id,
          })
        : Promise.resolve([]),
    ]);

    const attention: OverviewAttentionV1[] = [
      ...ownProposals.map((row): OverviewAttentionV1 => ({
        predicate: "own_open_proposal",
        caseId: row.caseId,
        caseTitle: row.caseTitle,
        experimentId: row.experimentId,
        decisionId: row.decision.id,
        revision: row.decision.revision,
        authorUsername: row.decision.authorUsername,
        createdAt: row.decision.createdAt,
      })),
      ...acceptEligible.map((row): OverviewAttentionV1 => ({
        predicate: "accept_eligible_proposal",
        caseId: row.caseId,
        caseTitle: row.caseTitle,
        experimentId: row.experimentId,
        decisionId: row.decision.id,
        revision: row.decision.revision,
        authorUsername: row.decision.authorUsername,
        createdAt: row.decision.createdAt,
      })),
    ]
      .sort((left, right) => {
        const byTime = right.createdAt.localeCompare(left.createdAt);
        if (byTime !== 0) return byTime;
        return left.decisionId.localeCompare(right.decisionId);
      })
      .slice(0, OVERVIEW_ATTENTION_CAP);

    const identity: IdentityV1 = {
      id: actor.id,
      username: actor.username,
      displayName: actor.displayName,
    };
    const presence: OverviewPresenceV1 = {
      available: true,
      reason: "ephemeral_live",
      ttlSeconds: this.deps.presence.ttlSeconds(),
      members: presenceMembers.slice(0, OVERVIEW_PRESENCE_CAP).map((member) => ({
        caseId: member.caseId,
        identityId: member.identityId,
        username: member.username,
        surface: member.surface,
        lastSeenAt: new Date(member.lastSeenAt).toISOString(),
      })),
    };

    return parseOverview({
      schemaId: OVERVIEW_SCHEMA_ID,
      generatedAt: new Date().toISOString(),
      viewer: { identity, roles: actor.roles },
      statusCounts: counts.status,
      severityCounts: counts.severity,
      openCases,
      recentActivity,
      queuedAndRunningJobs: queuedAndRunningJobs.map((row) => projectJob(row.job, row.caseTitle)),
      recentTerminalJobs: recentTerminalJobs.map((row) => projectJob(row.job, row.caseTitle)),
      presence,
      attention,
      notices: [...OVERVIEW_NOTICES],
    });
  }
}
