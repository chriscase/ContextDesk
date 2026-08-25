/**
 * Deterministic investigation-activity projection from authoritative timeline rows.
 */
import {
  INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
  formatInvestigationResourceLocator,
  investigationActivityId,
  investigationSourceEventId,
  investigationStageForKind,
  parseInvestigationActivityItem,
  safeActorLabel,
  safeInvestigationTitle,
  safeResourceLabel,
  type InvestigationActivityItemV1,
  type InvestigationActivityKindV1,
  type InvestigationPrivacyVisibilityV1,
  type InvestigationProvenanceClassV1,
  type InvestigationResourceKindV1,
  type InvestigationStageV1,
} from "@cd-collab/contracts";
import type { CaseTimelineRow } from "../cases/index.js";

export const INVESTIGATION_ACTIVITY_SOURCE_WINDOW = 500 as const;

export interface TimelineActivitySource {
  caseId: string;
  title: string;
  event: CaseTimelineRow;
}

export interface ProjectedInvestigationActivity {
  item: InvestigationActivityItemV1;
  assignedActorIds: string[];
  workstreamId: string | null;
  stage: InvestigationStageV1;
  timelineKind: string;
}

const STAGE_LABEL: Record<InvestigationStageV1, string> = {
  situation: "Situation",
  capture: "Capture",
  analyze: "Analyze",
  compare: "Compare",
  decide: "Decide",
};

function payloadOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function num(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assignedActorIds(payload: Record<string, unknown>): string[] {
  return [...new Set(
    [payload.assignedTo, payload.assigneeId, payload.ownerId]
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  )];
}

function privacyOf(payload: Record<string, unknown>): InvestigationPrivacyVisibilityV1 {
  if (payload.tombstone === true || payload.omitted === true || payload.inclusion === "omitted") return "omitted";
  if (payload.redacted === true || payload.inclusion === "redacted") return "redacted";
  if (payload.privacyClass === "share_safe") return "share_safe";
  if (payload.privacyClass === "owner_only") return "owner_only";
  return "member";
}

function workstreamStatus(status: string | null): InvestigationActivityKindV1 {
  if (status === "completed") return "workstream_completed";
  if (status === "partial") return "workstream_partially_completed";
  if (status === "cancelled" || status === "canceled") return "workstream_canceled";
  if (status === "failed" || status === "timed_out") return "workstream_failed";
  return "workstream_launched";
}

interface Mapped {
  activityKind: InvestigationActivityKindV1;
  resourceKind: InvestigationResourceKindV1;
  resourceId: string;
  provenance: InvestigationProvenanceClassV1;
  summary: string;
  humanFinding: boolean;
  revision: number | null;
  workstreamId: string | null;
}

function mapEvent(caseId: string, event: CaseTimelineRow, payload: Record<string, unknown>): Mapped {
  const target = event.targetId ?? caseId;
  const contribution = str(payload, "kind");
  const revision = num(payload, "revision");
  const status = str(payload, "status");
  const jobId = str(payload, "jobId") ?? (event.kind.startsWith("triage_") ? event.targetId : null);
  const decisionId = str(payload, "decisionId") ?? target;
  const rerun = Boolean(payload.rerunOf ?? payload.parentJobId);
  const assigned = assignedActorIds(payload).length > 0;

  switch (event.kind) {
    case "case_created":
      return { activityKind: "investigation_created", resourceKind: "investigation", resourceId: caseId, provenance: "system", summary: "opened the investigation", humanFinding: false, revision: null, workstreamId: null };
    case "case_status":
    case "case_situation_updated":
    case "membership":
    case "legal_hold":
      return {
        activityKind: "investigation_updated",
        resourceKind: "investigation",
        resourceId: caseId,
        provenance: "system",
        summary: event.kind === "case_situation_updated" ? "updated the shared Situation"
          : event.kind === "membership" ? "changed the investigation team"
            : event.kind === "legal_hold" ? "changed the legal-hold state" : "updated the investigation",
        humanFinding: false,
        revision: null,
        workstreamId: null,
      };
    case "evidence_registered":
      return { activityKind: "evidence_added", resourceKind: "evidence_item", resourceId: target, provenance: "human", summary: "added evidence", humanFinding: false, revision: null, workstreamId: null };
    case "evidence_privacy_classified":
      return { activityKind: "evidence_privacy_classified", resourceKind: "evidence_item", resourceId: target, provenance: "system", summary: "classified evidence privacy", humanFinding: false, revision: null, workstreamId: null };
    case "evidence_attributed":
    case "evidence_recheck":
    case "run_corroboration":
      return {
        activityKind: "evidence_reviewed",
        resourceKind: event.kind === "run_corroboration" ? "evidence_context" : "evidence_item",
        resourceId: target,
        provenance: event.kind === "run_corroboration" ? "human" : "system",
        summary: event.kind === "run_corroboration" ? "reviewed imported analysis" : "reviewed evidence",
        humanFinding: false,
        revision: null,
        workstreamId: null,
      };
    case "snapshot_frozen":
      return { activityKind: "evidence_frozen", resourceKind: "evidence_context", resourceId: target, provenance: "system", summary: "froze an evidence snapshot", humanFinding: false, revision: null, workstreamId: null };
    case "contribution_tombstoned":
      return {
        activityKind: contribution === "upload" ? "evidence_omitted" : "observation_recorded",
        resourceKind: contribution === "upload" ? "evidence_item" : "observation",
        resourceId: target,
        provenance: "human",
        summary: contribution === "upload" ? "omitted evidence" : "omitted an investigation record",
        humanFinding: false,
        revision,
        workstreamId: null,
      };
    case "contribution_created":
    case "contribution_revised":
      if (contribution === "message") {
        return { activityKind: "comment_added", resourceKind: "discussion_message", resourceId: target, provenance: "human", summary: event.kind === "contribution_revised" ? "revised a discussion comment" : "added a discussion comment", humanFinding: true, revision, workstreamId: null };
      }
      if (contribution === "note") {
        // The person chose "note". The investigation record says "A human note
        // was recorded", so the feed says the same thing: restating someone's
        // note as an "observation" reads as a different, stronger kind of
        // record than the one they actually made. The activity/resource enums
        // stay as they are — `observation` is the category a note belongs to,
        // and the recorded kind is carried by what the row says.
        return { activityKind: "observation_recorded", resourceKind: "observation", resourceId: target, provenance: "human", summary: event.kind === "contribution_revised" ? "revised a note" : "recorded a note", humanFinding: true, revision, workstreamId: null };
      }
      if (contribution === "hypothesis") {
        return { activityKind: event.kind === "contribution_revised" ? "hypothesis_updated" : "hypothesis_recorded", resourceKind: "hypothesis", resourceId: target, provenance: "human", summary: event.kind === "contribution_revised" ? "revised a working hypothesis" : "proposed a working hypothesis", humanFinding: true, revision, workstreamId: null };
      }
      if (contribution === "action") {
        return { activityKind: assigned ? "assignment_recorded" : "action_recorded", resourceKind: "action", resourceId: target, provenance: "human", summary: assigned ? "recorded an assignment" : "recorded a next action", humanFinding: true, revision, workstreamId: null };
      }
      if (contribution === "upload") {
        return { activityKind: "evidence_added", resourceKind: "evidence_item", resourceId: target, provenance: "human", summary: "recorded an evidence upload", humanFinding: false, revision, workstreamId: null };
      }
      if (payload.mentions !== undefined || payload.mention === true) {
        return { activityKind: "mention_recorded", resourceKind: "discussion_message", resourceId: target, provenance: "human", summary: "recorded a mention", humanFinding: true, revision, workstreamId: null };
      }
      if (payload.handoff === true || contribution === "handoff") {
        return { activityKind: "handoff_recorded", resourceKind: "observation", resourceId: target, provenance: "human", summary: "recorded a handoff", humanFinding: true, revision, workstreamId: null };
      }
      return { activityKind: "investigation_updated", resourceKind: "observation", resourceId: target, provenance: "human", summary: "updated the investigation record", humanFinding: false, revision, workstreamId: null };
    case "hypothesis_status":
      return { activityKind: status === "superseded" ? "decision_superseded" : "hypothesis_updated", resourceKind: "hypothesis", resourceId: target, provenance: "human", summary: status === "superseded" ? "superseded a working hypothesis" : "updated a working hypothesis", humanFinding: true, revision, workstreamId: null };
    case "triage_job_created":
      return { activityKind: rerun ? "workstream_rerun" : "workstream_launched", resourceKind: rerun ? "workstream_rerun" : "workstream", resourceId: target, provenance: "system", summary: rerun ? "reran a workstream" : "launched a workstream", humanFinding: false, revision: null, workstreamId: jobId };
    case "triage_job_started":
      return { activityKind: "workstream_launched", resourceKind: "workstream", resourceId: target, provenance: "system", summary: "started a workstream", humanFinding: false, revision: null, workstreamId: jobId };
    case "triage_job_cancel_requested":
      return { activityKind: "workstream_canceled", resourceKind: "workstream", resourceId: target, provenance: "human", summary: "canceled a workstream", humanFinding: false, revision: null, workstreamId: jobId };
    case "triage_job_finished":
      return {
        activityKind: workstreamStatus(status),
        resourceKind: "workstream",
        resourceId: target,
        provenance: "system",
        summary: status === "partial" ? "partially completed a workstream"
          : status === "failed" || status === "timed_out" ? "recorded a workstream failure"
            : status === "cancelled" || status === "canceled" ? "canceled a workstream" : "completed a workstream",
        humanFinding: false,
        revision: null,
        workstreamId: jobId,
      };
    case "triage_candidate_started":
    case "triage_candidate_finished":
      return {
        activityKind: event.kind === "triage_candidate_finished" ? "workstream_completed" : "workstream_launched",
        resourceKind: "workstream_attempt",
        resourceId: target,
        provenance: "ai_generated",
        summary: event.kind === "triage_candidate_finished" ? "completed a workstream attempt" : "started a workstream attempt",
        humanFinding: false,
        revision: null,
        workstreamId: jobId,
      };
    case "experiment_imported":
      return { activityKind: "comparison_unknown", resourceKind: "comparison_finding", resourceId: target, provenance: "imported", summary: "recorded a strategy comparison", humanFinding: false, revision: null, workstreamId: null };
    case "comparison_disagreement":
    case "experiment_helpfulness_recorded": {
      const disagreement = event.kind === "comparison_disagreement" || payload.agreement === "disagree" || payload.disagreement === true;
      return { activityKind: disagreement ? "comparison_disagreement" : "comparison_unknown", resourceKind: disagreement ? "comparison_conflict" : "comparison_finding", resourceId: target, provenance: "human", summary: disagreement ? "recorded a comparison disagreement" : "recorded a comparison observation", humanFinding: false, revision: null, workstreamId: null };
    }
    case "comparison_unknown":
      return { activityKind: "comparison_unknown", resourceKind: "comparison_finding", resourceId: target, provenance: "human", summary: "recorded a comparison unknown", humanFinding: false, revision: null, workstreamId: null };
    case "experiment_decision_proposed":
      return { activityKind: revision && revision > 1 ? "decision_revised" : "decision_proposed", resourceKind: "decision_revision", resourceId: decisionId, provenance: "human", summary: revision && revision > 1 ? "revised a decision" : "proposed a decision", humanFinding: true, revision: revision ?? 0, workstreamId: null };
    case "experiment_decision_accepted":
      return { activityKind: "decision_accepted", resourceKind: "decision_revision", resourceId: decisionId, provenance: "human", summary: "accepted a decision", humanFinding: true, revision: revision ?? 0, workstreamId: null };
    case "experiment_decision_superseded":
      return { activityKind: "decision_superseded", resourceKind: "decision_revision", resourceId: decisionId, provenance: "human", summary: "superseded a decision", humanFinding: true, revision: revision ?? 0, workstreamId: null };
    case "experiment_gold_promoted":
      return { activityKind: "decision_accepted", resourceKind: "decision_revision", resourceId: target, provenance: "human", summary: "recorded an accepted outcome benchmark", humanFinding: true, revision: revision ?? 0, workstreamId: null };
    case "external_run_imported":
    case "experiment_trace_imported":
      return { activityKind: "import_recorded", resourceKind: "evidence_context", resourceId: target, provenance: "ai_generated", summary: "imported analysis was recorded", humanFinding: false, revision: null, workstreamId: null };
    case "corpus_intake_committed":
      return { activityKind: "import_recorded", resourceKind: "evidence_item", resourceId: target, provenance: "imported", summary: "committed a log intake batch", humanFinding: false, revision: null, workstreamId: null };
    case "export_recorded":
    case "export_created":
      return { activityKind: "export_recorded", resourceKind: "export_event", resourceId: target, provenance: "system", summary: "recorded an export", humanFinding: false, revision: null, workstreamId: null };
    case "portable_archive_applied":
      return { activityKind: "restore_recorded", resourceKind: "portable_archive_event", resourceId: target, provenance: "historical_restored", summary: "restored a portable investigation archive", humanFinding: false, revision: null, workstreamId: null };
    default:
      return { activityKind: "investigation_updated", resourceKind: "timeline_event", resourceId: String(event.seq), provenance: "system", summary: "updated the investigation", humanFinding: false, revision: null, workstreamId: jobId };
  }
}

/**
 * Collapse projected activity rows that describe the very same recorded work.
 *
 * One committed action can reach the timeline as more than one event — an
 * import writes its own event and a generic one alongside it. Projected
 * separately they become separate rows in Latest activity, so a single import
 * reads as two pieces of work.
 *
 * Telling that apart from a genuinely repeated action needs two facts, because
 * the visible ones are not enough on their own: four identical situation
 * updates look the same to a reader too, and they really did happen four
 * times. So a group is collapsed only when everything a reader could tell the
 * rows apart by is identical — investigation, kind, wording, route, time,
 * actor, provenance, revision — *and* the rows came from different timeline
 * event kinds, which is what "one action written down twice" looks like.
 * Rows that repeat under a single event kind are repeated work and are all
 * kept.
 *
 * The trade-off is deliberate and narrow: an action both repeated and recorded
 * under several kinds within the same timestamp collapses to one row. Those
 * rows are indistinguishable on screen anyway, and the alternative — showing
 * every import twice — misreports how much work is outstanding.
 *
 * The first row of a collapsed group survives, so ordering and any cursor
 * built from the list stay stable.
 */
export function dedupeProjectedActivity(
  rows: ProjectedInvestigationActivity[],
): ProjectedInvestigationActivity[] {
  const visibleIdentity = (row: ProjectedInvestigationActivity): string =>
    JSON.stringify([
      row.item.investigationId,
      row.item.activityKind,
      row.item.summary,
      row.item.resolvedRoute,
      row.item.occurredAt,
      row.item.actorId,
      row.item.provenanceClass,
      row.item.revision,
    ]);
  const timelineKinds = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = visibleIdentity(row);
    const kinds = timelineKinds.get(key) ?? new Set<string>();
    kinds.add(row.timelineKind);
    timelineKinds.set(key, kinds);
  }
  const collapsed = new Set<string>();
  const kept: ProjectedInvestigationActivity[] = [];
  for (const row of rows) {
    const key = visibleIdentity(row);
    // A single event kind repeated means the work happened more than once.
    if ((timelineKinds.get(key)?.size ?? 1) < 2) {
      kept.push(row);
      continue;
    }
    if (collapsed.has(key)) continue;
    collapsed.add(key);
    kept.push(row);
  }
  return kept;
}

export function projectTimelineSource(input: {
  installationId: string;
  source: TimelineActivitySource;
}): ProjectedInvestigationActivity | null {
  const payload = payloadOf(input.source.event.payload);
  const mapped = mapEvent(input.source.caseId, input.source.event, payload);
  const restoredImport = payload.imported === true;
  if (restoredImport) {
    mapped.provenance = "historical_restored";
    mapped.humanFinding = false;
  }
  const visibility = privacyOf(payload);
  if (visibility === "omitted" || visibility === "redacted") mapped.humanFinding = false;
  const historical = restoredImport
    || input.source.event.actorUsername.startsWith("historical-")
    || input.source.event.actorUsername.startsWith("imported-")
    || mapped.provenance === "historical_restored";
  if (mapped.provenance === "ai_generated" || mapped.provenance === "imported") mapped.humanFinding = false;
  let resourceId = mapped.resourceKind === "investigation" ? input.source.caseId : mapped.resourceId;
  if (mapped.resourceKind === "timeline_event") resourceId = String(input.source.event.seq);
  let locator;
  try {
    locator = formatInvestigationResourceLocator({
      installationId: input.installationId,
      investigationId: input.source.caseId,
      kind: mapped.resourceKind,
      resourceId,
      ...(mapped.resourceKind === "decision_revision"
        ? { revision: mapped.revision ?? 0 }
        : mapped.revision !== null ? { revision: mapped.revision } : {}),
    });
  } catch {
    try {
      locator = formatInvestigationResourceLocator({
        installationId: input.installationId,
        investigationId: input.source.caseId,
        kind: "timeline_event",
        resourceId: String(input.source.event.seq),
      });
      mapped.resourceKind = "timeline_event";
      mapped.summary = "updated the investigation";
      mapped.humanFinding = false;
    } catch {
      return null;
    }
  }
  const stage = investigationStageForKind(locator.kind, locator.resourceId);
  try {
    const item = parseInvestigationActivityItem({
      schemaId: INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
      activityId: investigationActivityId({
        installationId: input.installationId,
        investigationId: input.source.caseId,
        seq: input.source.event.seq,
        kind: input.source.event.kind,
        targetId: input.source.event.targetId,
        revision: locator.revision ?? null,
      }),
      occurredAt: input.source.event.serverTime,
      orderTieBreak: input.source.event.seq,
      actorId: input.source.event.actorId,
      actorLabel: safeActorLabel(input.source.event.actorUsername, historical),
      investigationId: input.source.caseId,
      investigationTitle: safeInvestigationTitle(input.source.title),
      activityKind: mapped.activityKind,
      summary: mapped.summary,
      locator,
      resolvedRoute: locator.pathname,
      provenanceClass: historical && mapped.provenance === "human" ? "historical_restored" : mapped.provenance,
      privacyVisibility: visibility,
      revision: locator.revision ?? null,
      sourceEventId: investigationSourceEventId(input.source.caseId, input.source.event.seq),
      secondaryContext: { label: "Stage", value: STAGE_LABEL[stage] },
      humanFinding: mapped.humanFinding,
    });
    return { item, assignedActorIds: assignedActorIds(payload), workstreamId: mapped.workstreamId, stage, timelineKind: input.source.event.kind };
  } catch {
    return null;
  }
}

export function resourceLabelForKind(
  kind: InvestigationResourceKindV1,
  recorded?: string | null,
  suffix?: string | null,
): string {
  return safeResourceLabel(kind, recorded, suffix);
}
