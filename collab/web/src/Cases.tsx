import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CaseDiscussion } from "./CaseDiscussion.js";
import { ExperimentLab } from "./ExperimentLab.js";
import { ExportPanel } from "./ExportPanel.js";
import { CaseBoardPanel } from "./CaseBoardPanel.js";
import { TriageRunPanel } from "./TriageRunPanel.js";
import { WORKSTREAMS_SECTION, Workstreams } from "./Workstreams.js";
import {
  TriageAnchor,
  TriageStepSection,
  TriageWorkspace,
  type ContributionView,
  type RunRow,
  type SourceOption,
  type TimelineEvent,
} from "./TriageWorkspace.js";
import { isDiscussionSection, isWorkLocation, parsePathname, type WorkFocus } from "./app-location.js";
import { EmptyState, StageFlowDiagram, StageIcon } from "./graphics.js";
import { ArtifactExcerpt } from "./evidence-excerpt.js";
import { focusArrivalCopy } from "./route-focus-copy.js";
import { protectedApiFetch } from "./protected-api.js";
import { InvestigationRecordPanel } from "./InvestigationRecord.js";
import { ResolutionForm } from "./ResolutionForm.js";
import { loadEntities, type EntityRow } from "./Entities.js";

export type StageId = "situation" | "capture" | "analyze" | "compare" | "decide";

interface CaseParticipantRow {
  identityId?: string;
  username?: string;
}

interface CaseRow {
  id: string;
  title: string;
  problemStatement?: string;
  affectedParties?: string;
  impact?: string;
  scope?: string;
  openQuestions?: string[];
  situationVersion?: number;
  occurredAt?: string | null;
  occurredAtPrecision?: string;
  occurredAtZone?: string;
  status: string;
  severity: string;
  participants?: CaseParticipantRow[];
  createdAt?: string;
  createdBy?: string;
  reportedProblem?: string | null;
  problem?: string | null;
  summary?: string | null;
  createdByUsername?: string | null;
  creator?: string | null;
}

interface SituationDraft {
  problemStatement: string;
  affectedParties: string;
  impact: string;
  scope: string;
  openQuestions: string;
}

const EMPTY_SITUATION: SituationDraft = {
  problemStatement: "",
  affectedParties: "",
  impact: "",
  scope: "",
  openQuestions: "",
};

function draftFor(row: CaseRow): SituationDraft {
  return {
    problemStatement: row.problemStatement ?? "",
    affectedParties: row.affectedParties ?? "",
    impact: row.impact ?? "",
    scope: row.scope ?? "",
    openQuestions: (row.openQuestions ?? []).join("\n"),
  };
}

function openQuestionsFrom(value: string): string[] {
  return value.split("\n").map((question) => question.trim()).filter(Boolean);
}

interface ActivityItem {
  activityId: string;
  occurredAt: string;
  actorLabel: string;
  investigationId: string;
  investigationTitle: string;
  summary: string;
  resolvedRoute: string;
  provenanceClass: "human" | "imported" | "system" | "ai_generated" | "historical_restored";
  humanFinding: boolean;
  /**
   * Also published by the committed activity projection. Older payloads and
   * embedded consumers may omit them, so every reader treats them as optional
   * and says nothing rather than guessing.
   */
  activityKind?: string;
  privacyVisibility?: string;
  secondaryContext?: { label: string; value: string };
}

interface LegacyActivityItem {
  caseId: string;
  caseTitle: string;
  caseStatus: string;
  caseSeverity: string;
  seq: number;
  kind: string;
  actorUsername: string;
  targetId: string | null;
  details: Record<string, string | number | boolean | null>;
}

/** Statuses the server contract records, in board order. Unrecognised values
 *  from the wire still count — they are appended after these. */
const KNOWN_STATUSES = ["open", "monitoring", "resolved", "archived"] as const;

const STAGES: readonly { id: StageId; label: string; hint: string }[] = [
  { id: "situation", label: "Situation", hint: "shared picture" },
  { id: "capture", label: "Capture", hint: "notes & imports" },
  { id: "analyze", label: "Analyze", hint: "evidence & AI lanes" },
  { id: "compare", label: "Compare", hint: "lanes side by side" },
  { id: "decide", label: "Decide", hint: "human call & export" },
];

const STAGE_LABELS: Record<StageId, string> = {
  situation: "Situation",
  capture: "Capture",
  analyze: "Analyze",
  compare: "Compare",
  decide: "Decide",
};

function creatorName(row: CaseRow): string | null {
  const fromParticipants = row.createdBy
    ? row.participants?.find((p) => p.identityId === row.createdBy)?.username
    : undefined;
  return fromParticipants ?? row.createdByUsername ?? row.creator ?? null;
}

function createdLabel(row: CaseRow): string | null {
  if (!row.createdAt) return null;
  const parsed = new Date(row.createdAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function openedLine(row: CaseRow): string | null {
  const when = createdLabel(row);
  const who = creatorName(row);
  if (when && who) return `Opened ${when} by ${who}`;
  if (when) return `Opened ${when}`;
  if (who) return `Opened by ${who}`;
  return null;
}

/**
 * The Situation briefing groups. Each group reads only records this
 * investigation already fetched for Capture — the briefing is a re-presentation
 * of the working record, never a second source of truth and never a verdict.
 */
const BRIEFING_GROUPS: readonly {
  id: string;
  title: string;
  /** Contribution kinds that belong to this group. */
  kinds: readonly string[];
  /** What the reader should take the entries to mean. Never a claim of truth. */
  meaning: string;
  empty: string;
}[] = [
  {
    id: "hypotheses",
    title: "Working hypotheses",
    kinds: ["hypothesis"],
    meaning: "Possibilities someone recorded to test. A hypothesis is not an established cause.",
    empty: "No working hypothesis has been recorded yet.",
  },
  {
    id: "actions",
    title: "Next actions",
    kinds: ["action"],
    meaning: "Work someone recorded for a person to perform and report back on.",
    empty: "No next action has been recorded yet.",
  },
  {
    id: "observations",
    title: "Latest observations",
    kinds: ["note", "message"],
    meaning: "What people reported seeing. Recorded observations, not conclusions.",
    empty: "No observation has been recorded yet.",
  },
];

/** Newest-first, tombstoned entries excluded from the working record. */
function briefingEntries(
  contributions: readonly ContributionView[],
  kinds: readonly string[],
): ContributionView[] {
  return contributions
    .filter((row) => !row.tombstoned && kinds.includes(row.kind) && (row.body ?? "").trim().length > 0)
    .slice()
    .sort((left, right) => {
      const byCreated = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
      return byCreated !== 0 ? byCreated : right.id.localeCompare(left.id);
    });
}

function contributionTime(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Imported analysis nobody has read yet. Kept separate from the human groups
 * above so model or tool output is never folded in among human findings.
 */
function unreviewedRuns(runs: readonly RunRow[]): RunRow[] {
  return runs.filter(
    (run) => run.corroborationState !== "corroborated" && run.corroborationState !== "contradicted",
  );
}

/** Evidence signals restated from timeline events already loaded for this case. */
function evidenceSignals(events: readonly TimelineEvent[]): {
  registered: number;
  snapshots: number;
  intakeBatches: number;
} {
  let registered = 0;
  let snapshots = 0;
  let intakeBatches = 0;
  for (const event of events) {
    if (event.kind === "evidence_registered") registered += 1;
    else if (event.kind === "snapshot_frozen") snapshots += 1;
    else if (event.kind === "corpus_intake_committed") intakeBatches += 1;
  }
  return { registered, snapshots, intakeBatches };
}

/**
 * Provenance shown on every feed row, not only the non-human ones. A reader
 * scanning the room should never have to infer that an unlabeled row was
 * written by a person. Model and imported output are always named as analysis.
 */
function activityProvenance(item: ActivityItem): { className: string; label: string } {
  if (item.provenanceClass === "ai_generated") {
    return { className: "triage-chip triage-chip--model", label: "AI-assisted \u00b7 not a human finding" };
  }
  if (item.provenanceClass === "imported") {
    return { className: "triage-chip triage-chip--imported", label: "imported \u00b7 not a human finding" };
  }
  if (item.provenanceClass === "historical_restored") {
    return { className: "triage-chip triage-chip--imported", label: "restored history \u00b7 attribution only" };
  }
  if (item.provenanceClass === "system") {
    return { className: "triage-chip", label: "recorded by the system" };
  }
  return { className: "triage-chip triage-chip--human", label: "human-authored" };
}

/**
 * Names a restricted record so a reader knows it is not broadly readable, and
 * so nobody pastes it somewhere wider by accident. Nothing about the
 * restricted content itself is added or withheld by this label.
 */
function restrictionLabel(privacy: string | undefined): string | null {
  if (privacy === "owner_only") return "private to this case";
  if (privacy === "redacted") return "redacted";
  if (privacy === "omitted") return "content omitted";
  return null;
}

function activityRestriction(item: ActivityItem): string | null {
  return restrictionLabel(item.privacyVisibility);
}

/**
 * Recorded events that name work nobody has carried further. These are read
 * from the same committed activity projection the feed uses \u2014 a filter over
 * recorded events, never a second source of truth and never a judgment that
 * the work is wrong.
 */
const ATTENTION_GROUPS: readonly {
  id: string;
  title: string;
  kinds: readonly string[];
  meaning: string;
}[] = [
  {
    id: "stalled",
    title: "Analysis that stopped short",
    kinds: ["workstream_failed", "workstream_partially_completed", "workstream_canceled"],
    meaning:
      "A workstream was recorded as failed, partial, or canceled. Its own record says what it did reach.",
  },
  {
    id: "disagreed",
    title: "Lanes that disagreed",
    kinds: ["comparison_disagreement"],
    meaning:
      "A recorded comparison contradicted itself across lanes. Disagreement is for a person to adjudicate.",
  },
  {
    id: "unread",
    title: "Imported or AI output not yet read",
    kinds: ["import_recorded"],
    meaning:
      "Output pasted or generated elsewhere. It stays unverified until a person corroborates it.",
  },
];

const DECISION_PENDING_KINDS = new Set(["decision_proposed", "decision_revised"]);
const DECISION_SETTLED_KINDS = new Set(["decision_accepted", "decision_superseded"]);

/**
 * Investigations whose most recent recorded decision event is still a
 * proposal. Read strictly from the loaded window of activity, so callers must
 * state that bound rather than implying the whole history was examined.
 */
function decisionsAwaitingAcceptance(items: readonly ActivityItem[]): ActivityItem[] {
  const latest = new Map<string, ActivityItem>();
  // Items arrive newest-first, so the first decision event seen for an
  // investigation is the most recent one recorded in this window.
  for (const item of items) {
    const kind = item.activityKind ?? "";
    if (!DECISION_PENDING_KINDS.has(kind) && !DECISION_SETTLED_KINDS.has(kind)) continue;
    if (latest.has(item.investigationId)) continue;
    latest.set(item.investigationId, item);
  }
  return [...latest.values()].filter((item) => DECISION_PENDING_KINDS.has(item.activityKind ?? ""));
}

function activityLabel(item: ActivityItem | LegacyActivityItem): string {
  if ("summary" in item) return item.summary;
  const contributionKind = typeof item.details.kind === "string" ? item.details.kind : null;
  const labels: Record<string, string> = {
    case_created: "opened the investigation",
    case_status: `changed the status${typeof item.details.status === "string" ? ` to ${item.details.status}` : ""}`,
    membership: "changed the investigation team",
    legal_hold: "changed the legal-hold state",
    case_situation_updated: "updated the shared Situation",
    contribution_revised: "revised a recorded contribution",
    contribution_tombstoned: "removed a contribution from the working record",
    hypothesis_status: "updated a working hypothesis",
    evidence_registered: "added evidence",
    evidence_attributed: "attributed existing evidence",
    evidence_recheck: "rechecked evidence integrity",
    corpus_intake_committed: "committed a log intake batch",
    snapshot_frozen: "froze an evidence snapshot",
    external_run_imported: "imported external analysis",
    run_corroboration: "reviewed imported analysis",
    triage_job_created: "queued a triage run",
    triage_job_started: "started a triage run",
    triage_candidate_started: "started an analysis lane",
    triage_candidate_finished: "completed an analysis lane",
    triage_job_finished: "finished a triage run",
    triage_job_cancel_requested: "requested cancellation of a triage run",
    experiment_imported: "created a strategy comparison",
    experiment_helpfulness_recorded: "scored a strategy result",
    experiment_decision_proposed: "proposed a decision",
    experiment_decision_accepted: "accepted a decision",
    experiment_trace_imported: "recorded an analysis trace",
    experiment_gold_promoted: "recorded an accepted outcome benchmark",
  };
  if (item.kind === "contribution_created") {
    if (contributionKind === "message") return "added a discussion comment";
    if (contributionKind === "note") return "recorded an observation";
    if (contributionKind === "hypothesis") return "proposed a working hypothesis";
    if (contributionKind === "action") return "recorded a next action";
    if (contributionKind === "upload") return "recorded an evidence upload";
    return "added to the investigation record";
  }
  return labels[item.kind] ?? "updated the investigation";
}

function activityDestination(item: ActivityItem | LegacyActivityItem): { stage: StageId; focus: WorkFocus } {
  if ("resolvedRoute" in item && item.resolvedRoute) {
    try {
      const url = new URL(item.resolvedRoute, window.location.origin);
      const location = parsePathname(url.pathname, url.search, url.hash);
      if (
        isWorkLocation(location)
        && location.caseId === item.investigationId
        && location.focus
      ) {
        return { stage: location.stage, focus: location.focus };
      }
    } catch {
      // A malformed or stale route falls through to the legacy projection;
      // the trusted server contract normally makes this unreachable.
    }
  }
  if (!("kind" in item) || !item.kind) {
    return {
      stage: "situation",
      focus: {
        section: "stage-situation",
        item: null,
        itemKind: null,
        lane: null,
        experiment: null,
      },
    };
  }
  if (item.kind === "contribution_created" && item.details.kind === "message") {
    return {
      stage: "situation",
      focus: {
        section: "discussion",
        item: item.targetId,
        itemKind: "comment",
        lane: null,
        experiment: null,
      },
    };
  }
  if (
    item.kind.startsWith("contribution_")
    || item.kind === "external_run_imported"
    || item.kind === "run_corroboration"
  ) {
    return {
      stage: "capture",
      focus: {
        section: "triage-capture",
        item: item.targetId,
        itemKind: item.kind === "external_run_imported" || item.kind === "run_corroboration"
          ? "imported-run"
          : "contribution",
        lane: null,
        experiment: null,
      },
    };
  }
  if (item.kind.startsWith("triage_candidate")) {
    // The recorded target is already `${runId}:${candidateId}` — the exact
    // workstream address — so the link lands on that workstream's own record.
    return {
      stage: "analyze",
      focus: {
        section: WORKSTREAMS_SECTION,
        item: item.targetId,
        itemKind: "workstream",
        lane: item.targetId,
        experiment: null,
      },
    };
  }
  if (item.kind.startsWith("triage_")) {
    return {
      stage: "analyze",
      focus: {
        section: "triage-lane-runner",
        item: item.targetId,
        itemKind: "triage-run",
        lane: null,
        experiment: null,
      },
    };
  }
  if (item.kind === "corpus_intake_committed") {
    return {
      stage: "capture",
      focus: {
        section: "corpus-intake",
        item: item.targetId,
        itemKind: "intake-batch",
        lane: null,
        experiment: null,
      },
    };
  }
  if (item.kind.startsWith("evidence_") || item.kind === "snapshot_frozen") {
    return {
      stage: "analyze",
      focus: {
        section: "triage-evidence-board",
        item: item.targetId,
        itemKind: item.kind === "snapshot_frozen" ? "snapshot" : "evidence",
        lane: null,
        experiment: null,
      },
    };
  }
  if (item.kind === "experiment_decision_accepted" || item.kind === "experiment_gold_promoted") {
    return {
      stage: "decide",
      focus: { section: "decision-heading", item: item.targetId, lane: null, experiment: item.targetId },
    };
  }
  if (item.kind.startsWith("experiment_")) {
    return {
      stage: "compare",
      focus: { section: "triage-comparison-lab", item: item.targetId, lane: null, experiment: item.targetId },
    };
  }
  return {
    stage: "capture",
    focus: {
      section: "triage-capture",
      item: String(item.seq),
      itemKind: "timeline",
      lane: null,
      experiment: null,
    },
  };
}

function activityTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "Time not recorded";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function investigationEventDestination(
  event: TimelineEvent,
  contribution: ContributionView | undefined,
): { stage: StageId; focus: WorkFocus } {
  if (contribution?.kind === "message") {
    return {
      stage: "situation",
      focus: {
        section: "discussion",
        item: contribution.id,
        itemKind: "comment",
        lane: null,
        experiment: null,
      },
    };
  }
  if (contribution) {
    return {
      stage: "capture",
      focus: {
        section: "triage-capture",
        item: contribution.id,
        itemKind: "contribution",
        lane: null,
        experiment: null,
      },
    };
  }
  if (event.kind === "external_run_imported" || event.kind === "run_corroboration") {
    return {
      stage: "capture",
      focus: {
        section: "triage-capture",
        item: event.targetId ?? null,
        itemKind: "imported-run",
        lane: null,
        experiment: null,
      },
    };
  }
  if (event.kind.startsWith("triage_candidate")) {
    return {
      stage: "analyze",
      focus: {
        section: WORKSTREAMS_SECTION,
        item: event.targetId ?? null,
        itemKind: "workstream",
        lane: event.targetId ?? null,
        experiment: null,
      },
    };
  }
  if (event.kind.startsWith("triage_")) {
    return {
      stage: "analyze",
      focus: {
        section: "triage-lane-runner",
        item: event.targetId ?? null,
        itemKind: "triage-run",
        lane: null,
        experiment: null,
      },
    };
  }
  if (event.kind === "corpus_intake_committed") {
    return {
      stage: "capture",
      focus: {
        section: "corpus-intake",
        item: event.targetId ?? null,
        itemKind: "intake-batch",
        lane: null,
        experiment: null,
      },
    };
  }
  if (event.kind.startsWith("evidence_") || event.kind === "snapshot_frozen") {
    return {
      stage: "analyze",
      focus: {
        section: "triage-evidence-board",
        item: event.targetId ?? null,
        itemKind: event.kind === "snapshot_frozen" ? "snapshot" : "evidence",
        lane: null,
        experiment: null,
      },
    };
  }
  return {
    stage: "capture",
    focus: {
      section: "triage-capture",
      item: String(event.seq),
      itemKind: "timeline",
      lane: null,
      experiment: null,
    },
  };
}

export function Cases(props: {
  roles?: string[];
  capabilities?: readonly string[];
  readOnly?: boolean;
  participant?: { username: string; roles: string[] };
  view?: "overview" | "investigations";
  focusCaseId?: string | null;
  stage?: StageId;
  focus?: WorkFocus;
  startSignal?: number;
  onOpenCase?: (id: string) => void;
  onStageChange?: (stage: StageId) => void;
  onDeepNavigate?: (stage: StageId, focus: WorkFocus) => void;
  onActivityOpen?: (caseId: string, stage: StageId, focus: WorkFocus) => void;
  onExitFocus?: (target: "overview" | "investigations") => void;
  onFocusedCaseTitle?: (title: string | null) => void;
}) {
  const roles = props.roles ?? [];
  const readOnly = props.readOnly === true;
  const capabilitySet = props.capabilities ? new Set(props.capabilities) : null;
  const canLead = !readOnly && (capabilitySet
    ? capabilitySet.has("run:strategies") ||
      capabilitySet.has("decision:accept") ||
      capabilitySet.has("export:create") ||
      capabilitySet.has("portable:restore")
    : roles.includes("case-lead") || roles.includes("admin"));
  const canWrite = !readOnly && (capabilitySet
    ? capabilitySet.has("investigation:write")
    : canLead || roles.includes("contributor"));
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [casesLoaded, setCasesLoaded] = useState(false);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [activitiesLoaded, setActivitiesLoaded] = useState(false);
  const [activityCopy, setActivityCopy] = useState<{
    id: string;
    status: "copied" | "unavailable";
  } | null>(null);
  const activityCopyTimer = useRef<number | null>(null);
  // Uncontrolled fallback so the component still navigates when no parent
  // shell wires the callbacks (tests, embedding). The app shell controls it.
  const [localNav, setLocalNav] = useState<{ caseId: string | null; stage: StageId }>({
    caseId: null,
    stage: "situation",
  });
  const focusCaseId = props.onOpenCase ? (props.focusCaseId ?? null) : localNav.caseId;
  const stage = props.onStageChange ? (props.stage ?? "situation") : localNav.stage;
  const view = props.view ?? "overview";
  const [caseSearch, setCaseSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  // Entity filtering reads a server-scoped index, so choosing an entity can
  // only ever narrow what this reader could already list.
  const [entityFilter, setEntityFilter] = useState("all");
  const [entityOptions, setEntityOptions] = useState<EntityRow[]>([]);
  const [involvementIndex, setInvolvementIndex] = useState<
    { investigationId: string; entityId: string }[]
  >([]);
  const [newOccurredAt, setNewOccurredAt] = useState("");
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [resolutionPrompted, setResolutionPrompted] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [contributions, setContributions] = useState<ContributionView[]>([]);
  const [title, setTitle] = useState("");
  const [newSituation, setNewSituation] = useState<SituationDraft>(EMPTY_SITUATION);
  const [situationDraft, setSituationDraft] = useState<SituationDraft>(EMPTY_SITUATION);
  const [situationEditing, setSituationEditing] = useState(false);
  const [situationConflict, setSituationConflict] = useState(false);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionPresence, setDiscussionPresence] = useState<number | null>(null);
  const activeCaseRef = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const casesRefreshGeneration = useRef(0);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const discussionToggleRef = useRef<HTMLButtonElement>(null);
  const previousStage = useRef<StageId | null>(null);

  useEffect(
    () => () => {
      if (activityCopyTimer.current !== null) window.clearTimeout(activityCopyTimer.current);
    },
    [],
  );

  function openCase(id: string) {
    if (props.onOpenCase) props.onOpenCase(id);
    else setLocalNav({ caseId: id, stage: "situation" });
  }

  function selectStage(next: StageId) {
    if (props.onStageChange) props.onStageChange(next);
    else setLocalNav((current) => ({ ...current, stage: next }));
  }

  function exitFocus(target: "overview" | "investigations") {
    if (props.onExitFocus) props.onExitFocus(target);
    else setLocalNav({ caseId: null, stage: "situation" });
  }

  function closeDiscussion() {
    setDiscussionOpen(false);
    setDiscussionPresence(null);
    discussionToggleRef.current?.focus();
  }

  const refresh = useCallback(async () => {
    const generation = ++casesRefreshGeneration.current;
    const res = await protectedApiFetch("/api/cases");
    if (generation !== casesRefreshGeneration.current) return;
    if (!res.ok) {
      // Authorization loss must not leave previously cached case metadata on
      // screen. Transient availability failures keep the last confirmed view.
      if (res.status === 401 || res.status === 403) {
        setCases([]);
        setCasesLoaded(true);
      }
      return;
    }
    const body = (await res.json()) as { cases?: CaseRow[] };
    if (generation !== casesRefreshGeneration.current) return;
    setCases(body.cases ?? []);
    setCasesLoaded(true);
  }, []);

  /**
   * Entity labels and the involvement index behind the list filter. Both fail
   * quietly: an installation without the record graph shows no entity filter
   * rather than an error where the investigation list should be.
   */
  const refreshRecordIndex = useCallback(async () => {
    try {
      setEntityOptions(await loadEntities());
    } catch {
      setEntityOptions([]);
    }
    try {
      const response = await protectedApiFetch("/api/involvement/index");
      if (!response.ok) {
        setInvolvementIndex([]);
        return;
      }
      const parsed = (await response.json()) as {
        entries?: { investigationId: string; entityId: string }[];
      };
      setInvolvementIndex(parsed.entries ?? []);
    } catch {
      setInvolvementIndex([]);
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    const res = await protectedApiFetch("/api/investigation-activity?limit=30");
    if (!res.ok) {
      setActivitiesLoaded(true);
      return;
    }
    const body = (await res.json()) as { items?: ActivityItem[] };
    setActivities(body.items ?? []);
    setActivitiesLoaded(true);
  }, []);

  async function copyActivityLink(item: ActivityItem) {
    if (activityCopyTimer.current !== null) window.clearTimeout(activityCopyTimer.current);
    try {
      const href = new URL(item.resolvedRoute, window.location.origin).href;
      await navigator.clipboard.writeText(href);
      setActivityCopy({ id: item.activityId, status: "copied" });
    } catch {
      setActivityCopy({ id: item.activityId, status: "unavailable" });
    }
    activityCopyTimer.current = window.setTimeout(() => setActivityCopy(null), 4000);
  }

  const refreshSources = useCallback(async () => {
    const res = await protectedApiFetch("/api/catalog/sources");
    if (!res.ok) return;
    const body = (await res.json()) as { sources?: SourceOption[] };
    setSources(body.sources ?? []);
  }, []);

  const loadTimeline = useCallback(async (id: string, signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current && activeCaseRef.current === id;
    const requestInit = signal ? { signal } : undefined;
    const res = await protectedApiFetch(`/api/cases/${id}/timeline`, requestInit);
    if (!res.ok || !isCurrent()) return;
    const body = (await res.json()) as { events?: TimelineEvent[] };
    if (!isCurrent()) return;
    setEvents(body.events ?? []);
    const contributionResponse = await protectedApiFetch(`/api/cases/${id}/contributions`, requestInit);
    if (contributionResponse.ok && isCurrent()) {
      const contributionBody = (await contributionResponse.json()) as {
        contributions?: ContributionView[];
      };
      setContributions(contributionBody.contributions ?? []);
    }
    const imported = await protectedApiFetch(`/api/cases/${id}/imports`, requestInit);
    if (imported.ok && isCurrent()) {
      const list = (await imported.json()) as { runs?: RunRow[] };
      if (isCurrent()) setRuns(list.runs ?? []);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshSources();
    const refreshCatalog = () => void refreshSources();
    window.addEventListener("contextdesk:source-catalog-changed", refreshCatalog);
    return () => window.removeEventListener("contextdesk:source-catalog-changed", refreshCatalog);
  }, [refresh, refreshSources]);

  // Work recorded elsewhere in the room — a workstream that finished, failed,
  // or was canceled in Analyze — never passed through this component, so the
  // operating picture could show a room state that had already moved on.
  // Re-read the committed projection whenever the overview is put on screen,
  // and whenever a run reports that it changed.
  const showingOverview = view === "overview" && !focusCaseId;
  // The entity filter and its labels are loaded once the shell is up, so the
  // investigation list can offer the filter without waiting on a case being
  // opened first.
  useEffect(() => {
    void refreshRecordIndex();
  }, [refreshRecordIndex]);
  useEffect(() => {
    if (!showingOverview) return undefined;
    void refreshActivity();
    const onRunChanged = () => void refreshActivity();
    window.addEventListener("contextdesk:triage-run-changed", onRunChanged);
    return () => window.removeEventListener("contextdesk:triage-run-changed", onRunChanged);
  }, [showingOverview, refreshActivity]);

  useEffect(() => {
    const controller = new AbortController();
    activeCaseRef.current = focusCaseId;
    loadGeneration.current += 1;
    setEvents([]);
    setContributions([]);
    setRuns([]);
    setActionError(null);
    setImportError(null);
    setSituationEditing(false);
    setSituationConflict(false);
    setDiscussionOpen(false);
    setDiscussionPresence(null);
    if (focusCaseId) void loadTimeline(focusCaseId, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [focusCaseId, loadTimeline]);

  useEffect(() => {
    if (props.focus && isDiscussionSection(props.focus.section) && focusCaseId) {
      setDiscussionOpen(true);
    }
  }, [focusCaseId, props.focus]);

  useEffect(() => {
    if (!props.startSignal) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.scrollIntoView?.({ block: "center" });
  }, [props.startSignal]);

  // Moving between stages hands keyboard focus to the newly shown work view.
  useEffect(() => {
    if (!focusCaseId) {
      previousStage.current = null;
      return;
    }
    if (previousStage.current !== null && previousStage.current !== stage) {
      document.getElementById(`stage-${stage}`)?.focus();
    }
    previousStage.current = stage;
  }, [stage, focusCaseId]);

  async function createCase(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    const res = await protectedApiFetch("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        severity: "medium",
        problemStatement: newSituation.problemStatement,
        affectedParties: newSituation.affectedParties,
        impact: newSituation.impact,
        scope: newSituation.scope,
        openQuestions: openQuestionsFrom(newSituation.openQuestions),
        ...(newOccurredAt.trim() ? { occurredAt: newOccurredAt.trim() } : {}),
      }),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { detail?: string };
      setActionError(
        detail.detail
          ? `The investigation could not be created. ${detail.detail}`
          : "The investigation could not be created. You may not have permission to create one.",
      );
      return;
    }
    const created = (await res.json()) as CaseRow;
    setTitle("");
    setNewSituation(EMPTY_SITUATION);
    setNewOccurredAt("");
    // Make the server-confirmed investigation available before changing the URL.
    // A list refresh may still be in flight (or fail), but the focused workspace
    // must never momentarily fall back to the inventory for a case we just created.
    setCases((current) => [created, ...current.filter((row) => row.id !== created.id)]);
    openCase(created.id);
    await Promise.all([refresh(), refreshActivity(), refreshRecordIndex()]);
  }

  /**
   * Status changes, including the one that concludes an investigation.
   *
   * The server refuses `resolved` without a resolution record. That refusal is
   * not an error to apologise for — it is the form asking to be filled in — so
   * a `resolution_required` answer opens the record form rather than showing a
   * failure message.
   */
  async function setStatus(status: string, resolution?: Record<string, unknown>) {
    if (!focusCaseId) return;
    setActionError(null);
    setResolutionError(null);
    const response = await protectedApiFetch(`/api/cases/${focusCaseId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...(resolution ? { resolution } : {}) }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        currentRevision?: number;
      };
      if (detail.error === "resolution_required") {
        setResolutionOpen(true);
        setResolutionPrompted(true);
        return;
      }
      if (detail.error === "resolution_conflict") {
        setResolutionError(
          "Someone else recorded a conclusion while this form was open. Reload the investigation and read theirs before replacing it.",
        );
        return;
      }
      const message = detail.detail
        ? `The status could not be updated. ${detail.detail}`
        : "The status could not be updated. You may not have permission to change it.";
      if (resolution) setResolutionError(message);
      else setActionError(message);
      return;
    }
    setResolutionOpen(false);
    setResolutionPrompted(false);
    await Promise.all([refresh(), refreshActivity()]);
  }

  async function saveSituation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!focusCaseId) return;
    setActionError(null);
    const response = await protectedApiFetch(`/api/cases/${focusCaseId}/situation`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problemStatement: situationDraft.problemStatement,
        affectedParties: situationDraft.affectedParties,
        impact: situationDraft.impact,
        scope: situationDraft.scope,
        openQuestions: openQuestionsFrom(situationDraft.openQuestions),
        expectedVersion: current?.situationVersion ?? 0,
      }),
    });
    if (!response.ok) {
      if (response.status === 409) {
        await refresh();
        setSituationConflict(true);
        setActionError(
          "The Situation changed while you were editing. Reload the latest recorded context before saving again.",
        );
        return;
      }
      setActionError("The Situation could not be saved. You may not have permission to change it.");
      return;
    }
    const updated = (await response.json()) as CaseRow;
    setCases((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
    setSituationDraft(draftFor(updated));
    setSituationEditing(false);
    setSituationConflict(false);
    await Promise.all([refresh(), refreshActivity(), loadTimeline(focusCaseId)]);
  }

  async function importRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!focusCaseId) return;
    const form = event.currentTarget;
    setImportError(null);
    const data = new FormData(form);
    try {
      const response = await protectedApiFetch(`/api/cases/${focusCaseId}/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outputText: String(data.get("outputText") ?? ""),
          promptText: String(data.get("promptText") ?? "") || null,
          sourceId: String(data.get("sourceId") ?? ""),
          operatorId: String(data.get("operatorId") ?? ""),
          operatorUsername: String(data.get("operatorUsername") ?? ""),
          evidenceVisibility: String(data.get("evidenceVisibility") ?? "unknown"),
          visibilityNote: String(data.get("visibilityNote") ?? "") || null,
          snapshotBinding: String(data.get("snapshotBinding") ?? "") || null,
          redacted: data.get("redacted") === "on",
        }),
      });
      if (!response.ok) {
        setImportError("External run could not be imported. Review the fields and try again.");
        return;
      }
      window.dispatchEvent(new Event("contextdesk:external-run-imported"));
      form.reset();
      await Promise.all([loadTimeline(focusCaseId), refreshActivity()]);
    } catch {
      setImportError("External run could not be imported. Check the connection and try again.");
    }
  }

  async function corroborate(
    id: string,
    state: "corroborated" | "contradicted",
    linkId: string,
  ) {
    if (!focusCaseId) return;
    setActionError(null);
    const response = await protectedApiFetch(`/api/cases/${focusCaseId}/imports/${id}/corroborate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        state,
        links: [{ kind: "contribution", id: linkId }],
      }),
    });
    if (!response.ok) {
      setActionError("The imported run could not be updated. You may not have permission to corroborate it.");
      return;
    }
    await Promise.all([loadTimeline(focusCaseId), refreshActivity()]);
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!focusCaseId) return;
    setActionError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") ?? "");
    const kind = String(data.get("kind") ?? "note");
    const privacyClass = String(data.get("privacyClass") ?? "owner_only");
    const response = await protectedApiFetch(`/api/cases/${focusCaseId}/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, body, privacyClass }),
    });
    if (!response.ok) {
      setActionError("Timeline entry could not be added. You may not have permission to write to this case.");
      return;
    }
    form.reset();
    await Promise.all([loadTimeline(focusCaseId), refreshActivity()]);
  }

  const current = cases.find((c) => c.id === focusCaseId);
  // A workstream address focuses Analyze on that one workstream's record.
  const workstreamFocused =
    props.focus?.section === WORKSTREAMS_SECTION
    && Boolean(
      props.focus.lane
      || (props.focus.itemKind === "workstream" && props.focus.item),
    );
  const arrivalCopy =
    props.focus && props.focus.navigation !== "preserve"
      ? focusArrivalCopy(props.focus)
      : null;
  // Situation briefing inputs. Derived from the same records Capture renders,
  // so the briefing restates the working record instead of forking it.
  const pendingRuns = unreviewedRuns(runs);
  const evidence = evidenceSignals(events);
  useEffect(() => {
    props.onFocusedCaseTitle?.(current?.title ?? null);
  }, [current?.title, props.onFocusedCaseTitle]);
  const normalizedSearch = caseSearch.trim().toLocaleLowerCase();
  const casesByEntity = new Map<string, Set<string>>();
  for (const entry of involvementIndex) {
    const bucket = casesByEntity.get(entry.entityId) ?? new Set<string>();
    bucket.add(entry.investigationId);
    casesByEntity.set(entry.entityId, bucket);
  }
  const visibleCases = cases.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (entityFilter !== "all" && !casesByEntity.get(entityFilter)?.has(c.id)) return false;
    if (!normalizedSearch) return true;
    return [
      c.title,
      c.reportedProblem,
      c.problem,
      c.summary,
      c.id,
      c.createdBy,
      c.createdByUsername,
      c.creator,
      creatorName(c),
      ...(c.participants ?? []).map((p) => p.username),
    ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
  });
  const statusCounts: [string, number][] = [
    ...KNOWN_STATUSES.map(
      (status): [string, number] => [status, cases.filter((c) => c.status === status).length],
    ),
    ...[...new Set(cases.map((c) => c.status))]
      .filter((status) => !(KNOWN_STATUSES as readonly string[]).includes(status))
      .map((status): [string, number] => [status, cases.filter((c) => c.status === status).length]),
  ];
  const attentionCases = cases
    .filter((row) =>
      row.status !== "resolved"
      && row.status !== "archived"
      && (row.severity === "critical" || row.severity === "high"),
    )
    .slice(0, 5);
  const overviewActivities = activities.slice(0, 10);
  // Both panels below read the same committed activity window the feed reads.
  const attentionGroups = ATTENTION_GROUPS.map((group) => ({
    ...group,
    items: activities.filter((item) => group.kinds.includes(item.activityKind ?? "")),
  })).filter((group) => group.items.length > 0);
  const pendingDecisions = decisionsAwaitingAcceptance(activities);
  const attentionCount =
    attentionGroups.reduce((total, group) => total + group.items.length, 0) + pendingDecisions.length;

  const createForm = canWrite ? (
    <form className="case-form" aria-label="Start a new investigation" onSubmit={(e) => void createCase(e)}>
      <label className="case-form__label" htmlFor="new-investigation-title">
        Start an investigation
      </label>
      <div className="case-form__row">
        <input
          id="new-investigation-title"
          ref={titleInputRef}
          className="login__input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New investigation title"
          required
        />
        <button className="login__submit" type="submit">
          Create investigation
        </button>
      </div>
      <p className="case-form__help">
        Record what is known now. Blank fields remain explicitly not recorded and can be refined
        from Situation later.
      </p>
      <div className="case-form__situation">
        <label>
          <span>Problem statement</span>
          <textarea
            value={newSituation.problemStatement}
            onChange={(event) => setNewSituation((draft) => ({
              ...draft,
              problemStatement: event.target.value,
            }))}
            placeholder="What was observed, without assuming the cause?"
            rows={3}
          />
        </label>
        <label>
          <span>Affected people or systems</span>
          <textarea
            value={newSituation.affectedParties}
            onChange={(event) => setNewSituation((draft) => ({
              ...draft,
              affectedParties: event.target.value,
            }))}
            placeholder="Who or what is affected?"
            rows={2}
          />
        </label>
        <label>
          <span>Impact</span>
          <textarea
            value={newSituation.impact}
            onChange={(event) => setNewSituation((draft) => ({
              ...draft,
              impact: event.target.value,
            }))}
            placeholder="What is the recorded operational or user impact?"
            rows={2}
          />
        </label>
        <label>
          <span>Scope</span>
          <textarea
            value={newSituation.scope}
            onChange={(event) => setNewSituation((draft) => ({
              ...draft,
              scope: event.target.value,
            }))}
            placeholder="What is in scope, and what is known to be outside it?"
            rows={2}
          />
        </label>
        <label>
          <span>When it happened</span>
          <input
            className="login__input"
            value={newOccurredAt}
            onChange={(event) => setNewOccurredAt(event.target.value)}
            placeholder="2024-11-04, 2024-11, or leave empty"
            aria-label="When it happened"
          />
          <small>
            For work that happened before today. A date on its own is fine and is kept exactly as
            typed; the time zone is recorded as not known rather than guessed. When this was
            written down is recorded separately and never changes.
          </small>
        </label>
        <label className="case-form__wide">
          <span>Open questions</span>
          <textarea
            value={newSituation.openQuestions}
            onChange={(event) => setNewSituation((draft) => ({
              ...draft,
              openQuestions: event.target.value,
            }))}
            placeholder="One unresolved question per line"
            rows={3}
          />
        </label>
      </div>
    </form>
  ) : null;

  const investigationList = (
    <section className="case-list" aria-label="Investigations">
      <div className="case-list__controls">
        <label className="case-list__search">
          <span className="case-list__control-label">Search</span>
          <input
            className="login__input"
            type="search"
            value={caseSearch}
            onChange={(e) => setCaseSearch(e.target.value)}
            placeholder="Title, ID, participant, or creator"
            aria-label="Search investigations by title, ID, participant, or creator"
          />
        </label>
        {entityOptions.length > 0 ? (
          <label className="case-list__filter">
            <span className="case-list__control-label">Entity</span>
            <select
              className="login__input"
              aria-label="Filter investigations by involved entity"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
            >
              <option value="all">All entities</option>
              {entityOptions.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.label} ({casesByEntity.get(entity.id)?.size ?? 0})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="case-list__filter">
          <span className="case-list__control-label">Status</span>
          <select
            className="login__input"
            aria-label="Filter investigations by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            {statusCounts.map(([status, count]) => (
              <option key={status} value={status}>
                {status} ({count})
              </option>
            ))}
          </select>
        </label>
      </div>
      {cases.length === 0 && casesLoaded ? (
        <EmptyState art="investigations" className="case-list__empty-state">
          <p>
            No investigations are recorded yet.
            {canWrite ? " Start the first one below." : ""}
          </p>
        </EmptyState>
      ) : null}
      {cases.length > 0 && visibleCases.length === 0 ? (
        <EmptyState art="search" className="case-list__empty-state">
          <p>No investigations match the current search or filter.</p>
        </EmptyState>
      ) : null}
      <ul className="case-list__items">
        {visibleCases.map((c) => {
          const opened = openedLine(c);
          const members = (c.participants ?? [])
            .map((p) => p.username)
            .filter((name): name is string => Boolean(name));
          return (
            <li key={c.id} className="case-card">
              <div className="case-card__head">
                <button type="button" className="case-card__open" onClick={() => openCase(c.id)}>
                  {c.title}
                </button>
                <span className={`status-pill status-pill--${c.status}`}>{c.status}</span>
                <span className={`severity-note severity-note--${c.severity}`}>
                  {c.severity} severity
                </span>
              </div>
              {opened || members.length ? (
                <p className="case-card__meta">
                  {opened}
                  {opened && members.length ? " · " : ""}
                  {members.length
                    ? `${members.length} participant${members.length === 1 ? "" : "s"}: ${members.join(", ")}`
                    : ""}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {createForm}
    </section>
  );

  if (!current && focusCaseId) {
    return (
      <div className="cases">
        {actionError ? (
          <p className="case-memory__error" role="alert">
            {actionError}
          </p>
        ) : null}
        {!casesLoaded ? (
          <p className="case-list__empty" role="status">
            Loading the investigation…
          </p>
        ) : (
          <section
            className="case-list__empty"
            aria-labelledby="missing-investigation-title"
            role="alert"
          >
            <EmptyState art="locked">
              <h2 id="missing-investigation-title">Investigation unavailable</h2>
              <p>That investigation is not available to your account.</p>
              <button type="button" className="crumbs__link" onClick={() => exitFocus("overview")}>
                Back to the overview
              </button>
            </EmptyState>
          </section>
        )}
      </div>
    );
  }

  if (!current) {
    return (
      <div className="cases">
        {actionError ? (
          <p className="case-memory__error" role="alert">
            {actionError}
          </p>
        ) : null}
        {view === "overview" ? (
          <section className="overview" aria-labelledby="overview-title">
            <header className="overview__head">
              <h2 className="app__area-title" id="overview-title">
                Operating picture
              </h2>
              <p className="app__area-copy">
                {cases.length === 0 && casesLoaded
                  ? "Every investigation your team records will appear here."
                  : `${cases.length} investigation${cases.length === 1 ? "" : "s"} recorded. Counts reflect recorded status only.`}
              </p>
            </header>
            {casesLoaded && cases.length === 0 ? (
              <section className="overview-hero" aria-labelledby="overview-hero-title">
                <div>
                  <p className="overview-hero__eyebrow">How the room works</p>
                  <h3 className="overview-hero__title" id="overview-hero-title">
                    Capture. Analyze. Compare. Decide.
                  </h3>
                  <p className="overview-hero__copy">
                    Each investigation opens on Situation — the shared picture of what is
                    recorded — then moves through four working stages. Analysis informs the
                    team; a person, never a model, makes the call.
                  </p>
                </div>
                <StageFlowDiagram caption="Evidence is captured with provenance, frozen into snapshots for analysis, compared on the same material, and decided by a person. Nothing here scores progress — the room only restates what is recorded." />
              </section>
            ) : null}
            <dl className="overview__counts" aria-label="Investigations by recorded status">
              {statusCounts.map(([status, count]) => (
                <div key={status} className="overview__count" data-status={status}>
                  <dt>{status}</dt>
                  <dd>{count}</dd>
                </div>
              ))}
            </dl>
            <div className="overview__grid">
              <section className="overview__activity" aria-labelledby="overview-activity-title">
                <header className="overview__section-head">
                  <div>
                    <p className="overview__eyebrow">Across the War Room</p>
                    <h3 id="overview-activity-title">Latest activity</h3>
                    <p>What changed most recently, with a direct path to the recorded work.</p>
                  </div>
                </header>
                {!activitiesLoaded ? (
                  <p className="overview__empty" role="status">Loading recent activity…</p>
                ) : activities.length === 0 ? (
                  <EmptyState art="activity">
                    <p>No activity has been recorded yet.</p>
                    <p>
                      As people record work across investigations, the newest events land
                      here with a direct path to each record.
                    </p>
                  </EmptyState>
                ) : (
                  <ol className="activity-feed">
                    {overviewActivities.map((item) => {
                      const destination = activityDestination(item);
                      const investigation = cases.find((row) => row.id === item.investigationId);
                      return (
                        <li key={item.activityId} className="activity-feed__item">
                          <a
                            href={item.resolvedRoute}
                            className="activity-feed__open"
                            onClick={(event) => {
                              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                              event.preventDefault();
                              if (props.onActivityOpen) {
                                props.onActivityOpen(
                                  item.investigationId,
                                  destination.stage,
                                  destination.focus,
                                );
                              } else {
                                setLocalNav({ caseId: item.investigationId, stage: destination.stage });
                              }
                            }}
                          >
                            <span className="activity-feed__verb">
                              <strong>{item.actorLabel}</strong> {activityLabel(item)}
                            </span>
                            <span className="activity-feed__case">{item.investigationTitle}</span>
                            <span className="activity-feed__meta">
                              <time dateTime={item.occurredAt}>{activityTime(item.occurredAt)}</time>
                              {/* The committed projection names the stage this
                                  event belongs to; showing it saves opening the
                                  investigation to find out where work happened. */}
                              {item.secondaryContext ? (
                                <span className="activity-feed__stage">
                                  {item.secondaryContext.label}: {item.secondaryContext.value}
                                </span>
                              ) : null}
                              {investigation ? (
                                <span className={`status-pill status-pill--${investigation.status}`}>
                                  {investigation.status}
                                </span>
                              ) : null}
                              {activityRestriction(item) ? (
                                <span className="activity-feed__restricted">
                                  {activityRestriction(item)}
                                </span>
                              ) : null}
                            </span>
                            <span className={activityProvenance(item).className}>
                              {activityProvenance(item).label}
                            </span>
                          </a>
                          <div className="activity-feed__share">
                            <button type="button" onClick={() => void copyActivityLink(item)}>
                              Copy link
                            </button>
                            <span role="status">
                              {activityCopy?.id === item.activityId
                                ? activityCopy.status === "copied"
                                  ? "Copied."
                                  : "Clipboard unavailable — use the linked activity address."
                                : ""}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {activities.length > overviewActivities.length ? (
                  <p className="activity-feed__limit">
                    Showing the 10 most recent of {activities.length} recorded events.
                  </p>
                ) : null}
              </section>
              <aside className="overview__attention" aria-labelledby="overview-open-title">
                <header className="overview__section-head">
                  <div>
                    <p className="overview__eyebrow">Nothing has carried this further</p>
                    <h3 id="overview-open-title">Open threads</h3>
                    <p>
                      Recorded work that stopped, disagreed, or is still waiting on a person. Read
                      from the {activities.length} most recent recorded events, so older open work
                      may not appear here.
                    </p>
                  </div>
                </header>
                {!activitiesLoaded ? (
                  <p className="overview__empty" role="status">Loading recent activity…</p>
                ) : attentionCount === 0 ? (
                  <EmptyState art="clear">
                    <p>
                      Nothing in recent activity is recorded as stopped, disagreeing, unread, or
                      waiting on a decision.
                    </p>
                  </EmptyState>
                ) : (
                  <div className="overview__threads">
                    {pendingDecisions.length ? (
                      <section
                        className="overview__thread-group"
                        aria-labelledby="overview-thread-decisions"
                      >
                        <h4 id="overview-thread-decisions">
                          Waiting on a human decision
                          <span className="overview__thread-count">{pendingDecisions.length}</span>
                        </h4>
                        <p className="overview__thread-meaning">
                          The most recent decision recorded for these investigations is a proposal.
                          Only a person accepts a decision.
                        </p>
                        <ul className="overview__thread-list">
                          {pendingDecisions.map((item) => (
                            <li key={item.activityId}>
                              <a
                                href={item.resolvedRoute}
                                onClick={(event) => {
                                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                                  event.preventDefault();
                                  const destination = activityDestination(item);
                                  if (props.onActivityOpen) {
                                    props.onActivityOpen(
                                      item.investigationId,
                                      destination.stage,
                                      destination.focus,
                                    );
                                  } else {
                                    setLocalNav({ caseId: item.investigationId, stage: destination.stage });
                                  }
                                }}
                              >
                                <strong>{item.investigationTitle}</strong>
                                <span>
                                  {item.actorLabel} {activityLabel(item)} ·{" "}
                                  {activityTime(item.occurredAt)}
                                </span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    {attentionGroups.map((group) => (
                      <section
                        key={group.id}
                        className="overview__thread-group"
                        aria-labelledby={`overview-thread-${group.id}`}
                      >
                        <h4 id={`overview-thread-${group.id}`}>
                          {group.title}
                          <span className="overview__thread-count">{group.items.length}</span>
                        </h4>
                        <p className="overview__thread-meaning">{group.meaning}</p>
                        <ul className="overview__thread-list">
                          {group.items.slice(0, 4).map((item) => (
                            <li key={item.activityId}>
                              <a
                                href={item.resolvedRoute}
                                onClick={(event) => {
                                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                                  event.preventDefault();
                                  const destination = activityDestination(item);
                                  if (props.onActivityOpen) {
                                    props.onActivityOpen(
                                      item.investigationId,
                                      destination.stage,
                                      destination.focus,
                                    );
                                  } else {
                                    setLocalNav({ caseId: item.investigationId, stage: destination.stage });
                                  }
                                }}
                              >
                                <strong>{item.investigationTitle}</strong>
                                <span>
                                  {item.actorLabel} {activityLabel(item)} ·{" "}
                                  {activityTime(item.occurredAt)}
                                </span>
                              </a>
                            </li>
                          ))}
                        </ul>
                        {group.items.length > 4 ? (
                          <p className="overview__thread-more">
                            {group.items.length - 4} more in recent activity.
                          </p>
                        ) : null}
                      </section>
                    ))}
                  </div>
                )}
              </aside>
              <aside className="overview__attention" aria-labelledby="overview-attention-title">
                <header className="overview__section-head">
                  <div>
                    <p className="overview__eyebrow">Recorded severity</p>
                    <h3 id="overview-attention-title">High-impact investigations</h3>
                    <p>Open or monitored work recorded as high or critical severity.</p>
                  </div>
                </header>
                {attentionCases.length ? (
                  <ul className="overview__attention-list">
                    {attentionCases.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          aria-label={row.title}
                          onClick={() => openCase(row.id)}
                        >
                          <strong>{row.title}</strong>
                          <span>
                            <span className={`severity-note severity-note--${row.severity}`}>
                              {row.severity}
                            </span>{" "}
                            · {row.status}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState art="shield">
                    <p>No high-impact active investigations are recorded.</p>
                  </EmptyState>
                )}
                <button
                  type="button"
                  className="overview__view-all"
                  onClick={() => exitFocus("investigations")}
                >
                  View all investigations
                </button>
              </aside>
            </div>
          </section>
        ) : (
          <section className="case-inventory" aria-labelledby="investigations-title">
            <header className="overview__head">
              <h2 className="app__area-title" id="investigations-title">
                Investigations
              </h2>
              <p className="app__area-copy">
                Every investigation visible to your account, with its recorded status and people.
              </p>
            </header>
            {investigationList}
          </section>
        )}
      </div>
    );
  }

  return (
    <article className="case-view" aria-labelledby="focus-case-title">
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <button type="button" className="crumbs__link" onClick={() => exitFocus("overview")}>
              War Room
            </button>
          </li>
          <li>
            <button
              type="button"
              className="crumbs__link"
              onClick={() => exitFocus("investigations")}
            >
              Investigations
            </button>
          </li>
          <li>
            <button
              type="button"
              className="crumbs__link"
              aria-current={stage === "situation" ? "page" : undefined}
              onClick={() => selectStage("situation")}
            >
              {current.title}
            </button>
          </li>
          {stage !== "situation" ? (
            <li>
              <span className="crumbs__here" aria-current="page">
                {STAGE_LABELS[stage]}
              </span>
            </li>
          ) : null}
        </ol>
      </nav>
      <header className="focus-head">
        <div className="focus-head__primary">
          <h2 className="case-view__title" id="focus-case-title">
            {current.title}
          </h2>
          <p className="focus-head__meta">
            <span className={`status-pill status-pill--${current.status}`}>{current.status}</span>
            <span className={`severity-note severity-note--${current.severity}`}>
              {current.severity} severity
            </span>
            {openedLine(current) ? <span>{openedLine(current)}</span> : null}
          </p>
        </div>
        <div className="focus-head__discussion">
          <button
            type="button"
            ref={discussionToggleRef}
            className="focus-head__discussion-toggle"
            aria-expanded={discussionOpen}
            aria-controls="case-discussion"
            onClick={() => (discussionOpen ? closeDiscussion() : setDiscussionOpen(true))}
          >
            Discussion
          </button>
          {discussionPresence !== null ? (
            <p className="focus-head__discussion-context">
              {discussionPresence} active now (polled)
            </p>
          ) : null}
        </div>
      </header>
      <nav className="stage-nav" aria-label="Investigation stages">
        <ul>
          {STAGES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="stage-nav__link"
                aria-current={stage === item.id ? "page" : undefined}
                onClick={() => selectStage(item.id)}
              >
                <span className="stage-nav__badge" aria-hidden="true">
                  <StageIcon stage={item.id} />
                </span>
                <span className="stage-nav__text">
                  <span className="stage-nav__name">{item.label}</span>
                  <span className="stage-nav__hint">{item.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {actionError ? (
        <p className="case-memory__error" role="alert">
          {actionError}
        </p>
      ) : null}
      {arrivalCopy ? (
        <p className="case-view__focus-arrival" role="status">
          {arrivalCopy}
        </p>
      ) : null}
      <div
        className={
          discussionOpen ? "case-view__work case-view__work--discussing" : "case-view__work"
        }
      >
      <div className="stage-panels">
        <section
          className="stage-panel"
          id="stage-situation"
          aria-label="Situation"
          tabIndex={-1}
          hidden={stage !== "situation"}
        >
          <header className="stage-panel__intro">
            <h3 className="stage-panel__title">Situation</h3>
            <p className="stage-panel__purpose">
              The shared operating picture for this investigation — only what is recorded, never
              an inferred verdict or readiness score.
            </p>
          </header>
          <section className="situation__summary" aria-labelledby="situation-summary-title">
            <div className="situation__summary-head">
              <div>
                <h4 id="situation-summary-title">Recorded context</h4>
                <p>Recorded context for everyone working this investigation.</p>
              </div>
              {canWrite && !situationEditing ? (
                <button
                  type="button"
                  className="situation__edit"
                  onClick={() => {
                    setSituationDraft(draftFor(current));
                    setSituationEditing(true);
                    setSituationConflict(false);
                  }}
                >
                  Edit situation
                </button>
              ) : null}
            </div>
            {situationEditing ? (
              <form className="situation__form" onSubmit={(event) => void saveSituation(event)}>
                <label>
                  <span>Problem statement</span>
                  <textarea
                    value={situationDraft.problemStatement}
                    onChange={(event) => setSituationDraft((draft) => ({
                      ...draft,
                      problemStatement: event.target.value,
                    }))}
                    rows={4}
                  />
                </label>
                <label>
                  <span>Affected people or systems</span>
                  <textarea
                    value={situationDraft.affectedParties}
                    onChange={(event) => setSituationDraft((draft) => ({
                      ...draft,
                      affectedParties: event.target.value,
                    }))}
                    rows={3}
                  />
                </label>
                <label>
                  <span>Impact</span>
                  <textarea
                    value={situationDraft.impact}
                    onChange={(event) => setSituationDraft((draft) => ({
                      ...draft,
                      impact: event.target.value,
                    }))}
                    rows={3}
                  />
                </label>
                <label>
                  <span>Scope</span>
                  <textarea
                    value={situationDraft.scope}
                    onChange={(event) => setSituationDraft((draft) => ({
                      ...draft,
                      scope: event.target.value,
                    }))}
                    rows={3}
                  />
                </label>
                <label className="situation__form-wide">
                  <span>Open questions</span>
                  <textarea
                    value={situationDraft.openQuestions}
                    onChange={(event) => setSituationDraft((draft) => ({
                      ...draft,
                      openQuestions: event.target.value,
                    }))}
                    placeholder="One unresolved question per line"
                    rows={4}
                  />
                </label>
                <div className="situation__form-actions">
                  <button className="login__submit" type="submit" disabled={situationConflict}>
                    Save situation
                  </button>
                  {situationConflict ? (
                    <button
                      type="button"
                      className="situation__cancel"
                      onClick={() => {
                        setSituationDraft(draftFor(current));
                        setSituationConflict(false);
                        setActionError(null);
                      }}
                    >
                      Reload latest context
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="situation__cancel"
                    onClick={() => {
                      setSituationEditing(false);
                      setSituationConflict(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="situation__summary-grid">
                <section className="situation__summary-primary">
                  <h5>Problem statement</h5>
                  <p>{current.problemStatement || "Not recorded"}</p>
                </section>
                <section>
                  <h5>Affected people or systems</h5>
                  <p>{current.affectedParties || "Not recorded"}</p>
                </section>
                <section>
                  <h5>Impact</h5>
                  <p>{current.impact || "Not recorded"}</p>
                </section>
                <section>
                  <h5>Scope</h5>
                  <p>{current.scope || "Not recorded"}</p>
                </section>
                <section className="situation__summary-primary">
                  <h5>Open questions</h5>
                  {(current.openQuestions ?? []).length ? (
                    <ul>
                      {(current.openQuestions ?? []).map((question, index) => (
                        <li key={`${index}:${question}`}>{question}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>None recorded</p>
                  )}
                </section>
              </div>
            )}
          </section>
          <section className="situation__briefing" aria-labelledby="situation-briefing-title">
            <div className="situation__briefing-head">
              <h4 id="situation-briefing-title">Where the investigation stands</h4>
              <p>
                The working record as people wrote it — what is suspected, what is outstanding, and
                what was seen. Open any entry to read it in full where it was recorded.
              </p>
            </div>
            <div className="situation__briefing-grid">
              {BRIEFING_GROUPS.map((group) => {
                const entries = briefingEntries(contributions, group.kinds);
                const shown = entries.slice(0, 3);
                return (
                  <section
                    key={group.id}
                    className="situation__briefing-group"
                    aria-labelledby={`situation-briefing-${group.id}`}
                  >
                    <h5 id={`situation-briefing-${group.id}`}>
                      {group.title}
                      <span className="situation__briefing-count">
                        {entries.length === 0 ? "none recorded" : `${entries.length} recorded`}
                      </span>
                    </h5>
                    <p className="situation__briefing-meaning">{group.meaning}</p>
                    {shown.length === 0 ? (
                      <p className="situation__briefing-empty">{group.empty}</p>
                    ) : (
                      <ul className="situation__briefing-list">
                        {shown.map((row) => {
                          const when = contributionTime(row.createdAt);
                          return (
                            <li key={row.id}>
                              <p className="situation__briefing-attribution">
                                <span className="triage-chip triage-chip--human">human-authored</span>
                                <span>
                                  {row.authorUsername ?? "author not recorded"}
                                  {when ? ` · ${when}` : ""}
                                </span>
                                {restrictionLabel(row.privacyClass) ? (
                                  <span className="activity-feed__restricted">
                                    {restrictionLabel(row.privacyClass)}
                                  </span>
                                ) : null}
                              </p>
                              <ArtifactExcerpt text={row.body ?? ""} label={group.title.toLowerCase()} />
                              <button
                                type="button"
                                className="situation__briefing-open"
                                onClick={() => {
                                  const focus: WorkFocus = {
                                    section: "triage-capture",
                                    item: row.id,
                                    itemKind: "contribution",
                                    lane: null,
                                    experiment: null,
                                  };
                                  if (props.onDeepNavigate) props.onDeepNavigate("capture", focus);
                                  else selectStage("capture");
                                }}
                              >
                                Open where this was recorded
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {entries.length > shown.length ? (
                      <p className="situation__briefing-more">
                        {entries.length - shown.length} more recorded in Capture.
                      </p>
                    ) : null}
                  </section>
                );
              })}
              <section
                className="situation__briefing-group"
                aria-labelledby="situation-briefing-imported"
              >
                <h5 id="situation-briefing-imported">
                  Imported analysis awaiting a human read
                  <span className="situation__briefing-count">
                    {pendingRuns.length === 0
                      ? "none pending"
                      : `${pendingRuns.length} pending`}
                  </span>
                </h5>
                <p className="situation__briefing-meaning">
                  Output pasted from an AI, a tool, or a report. It stays unverified until a person
                  corroborates or contradicts it, and is never a human finding.
                </p>
                {pendingRuns.length === 0 ? (
                  <p className="situation__briefing-empty">
                    {runs.length === 0
                      ? "No external analysis has been imported."
                      : "Every imported run has a recorded human judgment."}
                  </p>
                ) : (
                  <ul className="situation__briefing-list">
                    {pendingRuns.slice(0, 3).map((run) => (
                      <li key={run.id}>
                        <p className="situation__briefing-attribution">
                          <span className="triage-chip triage-chip--imported">
                            imported · unverified
                          </span>
                          <span>Imported by {run.importerUsername}</span>
                        </p>
                        <ArtifactExcerpt text={run.outputText} label="imported output" />
                        <button
                          type="button"
                          className="situation__briefing-open"
                          onClick={() => {
                            const focus: WorkFocus = {
                              section: "triage-capture",
                              item: run.id,
                              itemKind: "imported-run",
                              lane: null,
                              experiment: null,
                            };
                            if (props.onDeepNavigate) props.onDeepNavigate("capture", focus);
                            else selectStage("capture");
                          }}
                        >
                          Open to record a human judgment
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
            <p className="situation__briefing-evidence">
              <strong>Evidence recorded:</strong>{" "}
              {evidence.registered === 0
                ? "no evidence has been registered on this investigation yet"
                : `${evidence.registered} item${evidence.registered === 1 ? "" : "s"} registered`}
              {evidence.snapshots > 0
                ? ` · ${evidence.snapshots} snapshot${evidence.snapshots === 1 ? "" : "s"} frozen`
                : " · no snapshot frozen yet"}
              {evidence.intakeBatches > 0
                ? ` · ${evidence.intakeBatches} log intake batch${evidence.intakeBatches === 1 ? "" : "es"} committed`
                : ""}
              {". "}
              <button
                type="button"
                className="situation__briefing-open"
                onClick={() => {
                  const focus: WorkFocus = {
                    section: "triage-evidence-board",
                    item: null,
                    itemKind: null,
                    lane: null,
                    experiment: null,
                  };
                  if (props.onDeepNavigate) props.onDeepNavigate("analyze", focus);
                  else selectStage("analyze");
                }}
              >
                Open the evidence board
              </button>
            </p>
          </section>
          <dl className="situation__facts">
            <div>
              <dt>Status</dt>
              <dd>{current.status}</dd>
            </div>
            <div>
              <dt>Severity</dt>
              <dd>{current.severity}</dd>
            </div>
            <div>
              <dt>Participants</dt>
              <dd>
                {(current.participants ?? []).length
                  ? (current.participants ?? [])
                      .map((p) => p.username)
                      .filter(Boolean)
                      .join(", ")
                  : "None recorded"}
              </dd>
            </div>
            <div>
              <dt>Opened</dt>
              <dd>{openedLine(current)?.replace(/^Opened /, "") ?? "Not recorded"}</dd>
            </div>
          </dl>
          <InvestigationRecordPanel
            caseId={current.id}
            canWrite={canWrite}
            occurrence={{
              occurredAt: current.occurredAt ?? null,
              occurredAtPrecision: current.occurredAtPrecision ?? "unknown",
              occurredAtZone: current.occurredAtZone ?? "unspecified",
            }}
            createdAt={current.createdAt ?? null}
            investigations={cases.map((row) => ({ id: row.id, title: row.title }))}
            onOccurrenceSaved={async () => {
              await Promise.all([refresh(), refreshActivity()]);
            }}
            onOpenInvestigation={(id) => openCase(id)}
          />
          <section className="situation__activity" aria-label="Recorded activity">
            <h4>Recorded activity</h4>
            <ul>
              <li>
                {events.length} timeline event{events.length === 1 ? "" : "s"}
              </li>
              <li>
                {contributions.filter((row) => !row.tombstoned).length} recorded contribution
                {contributions.filter((row) => !row.tombstoned).length === 1 ? "" : "s"}
              </li>
              <li>
                {runs.length} imported external run{runs.length === 1 ? "" : "s"}
              </li>
            </ul>
            <p className="stage-panel__note">
              Counts restate what the case has recorded. They do not measure progress or
              completeness.
            </p>
            {events.length ? (
              <ol className="situation__recent">
                {events.slice(-5).reverse().map((event) => {
                  const contribution = event.targetId
                    ? contributions.find((row) => row.id === event.targetId)
                    : undefined;
                  const destination = investigationEventDestination(event, contribution);
                  return (
                    <li key={event.seq}>
                      <button
                        type="button"
                        className="situation__activity-link"
                        onClick={() => {
                          if (props.onDeepNavigate) {
                            props.onDeepNavigate(destination.stage, destination.focus);
                          } else {
                            selectStage(destination.stage);
                          }
                        }}
                      >
                        <strong>{activityLabel({
                          caseId: current.id,
                          caseTitle: current.title,
                          caseStatus: current.status,
                          caseSeverity: current.severity,
                          seq: event.seq,
                          kind: event.kind,
                          actorUsername: event.actorUsername,
                          targetId: event.targetId ?? null,
                          occurredAt: event.serverTime,
                          details: contribution ? { kind: contribution.kind } : {},
                        })}</strong>
                        <span>{event.actorUsername} · {activityTime(event.serverTime)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>
          <section className="situation__next" aria-label="Work areas">
            <h4>Work areas</h4>
            <ul className="situation__links">
              {STAGES.filter((item) => item.id !== "situation").map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="situation__link"
                    onClick={() => selectStage(item.id)}
                  >
                    <strong>{item.label}</strong>
                    <span>{item.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </section>
        <section
          className="stage-panel"
          id="stage-capture"
          aria-label="Capture"
          tabIndex={-1}
          hidden={stage !== "capture"}
        >
          <TriageWorkspace
            key={current.id}
            caseId={current.id}
            canWrite={canWrite}
            readOnly={readOnly}
            sources={sources}
            events={events}
            contributions={contributions}
            runs={runs}
            importError={importError}
            {...(props.focus ? { routeFocus: props.focus } : {})}
            onAddNote={(event) => void addNote(event)}
            onImportRun={(event) => void importRun(event)}
            onCorroborate={(id, state, linkId) => void corroborate(id, state, linkId)}
          />
        </section>
        <section
          className="stage-panel"
          id="stage-analyze"
          aria-label="Analyze"
          tabIndex={-1}
          hidden={stage !== "analyze"}
        >
          <TriageStepSection
            id="triage-analyze"
            step={2}
            title="Analyze"
            lede={
              workstreamFocused
                ? "One workstream, in full: what it was asked, what it examined, what it found, and what it left unknown."
                : "Curate the evidence the investigation may rely on, freeze it, then read each workstream that examined exactly that evidence."
            }
          >
            <TriageAnchor id={WORKSTREAMS_SECTION} label="Workstreams">
              <Workstreams
                caseId={current.id}
                {...(props.focus ? { routeFocus: props.focus } : {})}
                {...(props.onDeepNavigate
                  ? {
                      onDeepNavigate: (focus: WorkFocus) =>
                        props.onDeepNavigate?.("analyze", focus),
                    }
                  : {})}
              />
            </TriageAnchor>
            {/* Opening one workstream is a real focus change, not a highlight:
                the evidence board and the run launcher step aside so the
                workstream's own record is the page. They also stop receiving
                the route focus while hidden, so only the workstream record
                claims keyboard focus for that address. */}
            <TriageAnchor id="triage-evidence-board" label="Evidence board and snapshots">
              <div hidden={workstreamFocused}>
                <CaseBoardPanel
                  caseId={current.id}
                  canWrite={canWrite}
                  canLead={canLead}
                  readOnly={readOnly}
                  {...(current.participants ? { participants: current.participants } : {})}
                  {...(props.focus && !workstreamFocused ? { routeFocus: props.focus } : {})}
                />
              </div>
            </TriageAnchor>
            <TriageAnchor id="triage-lane-runner" label="Run history and launcher">
              <div hidden={workstreamFocused}>
                <TriageRunPanel
                  caseId={current.id}
                  canLead={canLead}
                  readOnly={readOnly}
                  {...(current.participants ? { participants: current.participants } : {})}
                  {...(props.focus && !workstreamFocused ? { routeFocus: props.focus } : {})}
                />
              </div>
            </TriageAnchor>
          </TriageStepSection>
        </section>
        <section
          className="stage-panel"
          id="stage-compare"
          aria-label="Compare"
          tabIndex={-1}
          hidden={stage !== "compare"}
        >
          <TriageStepSection
            id="triage-compare"
            step={3}
            title="Compare"
            lede="Review model and strategy lanes side by side against the human benchmark. Agreement is not proof of correctness."
          >
            <TriageAnchor id="triage-comparison-lab" label="Comparison lab">
              <ExperimentLab
                caseId={current.id}
                surface="comparison"
                canWrite={canWrite}
                canLead={canLead}
                readOnly={readOnly}
                caseTitle={current.title}
                caseStatus={current.status}
                caseSeverity={current.severity}
                {...(props.focus ? { routeFocus: props.focus } : {})}
                {...(props.onDeepNavigate
                  ? { onDeepNavigate: (focus: WorkFocus) => props.onDeepNavigate?.("compare", focus) }
                  : {})}
                {...(props.participant ? { participant: props.participant } : {})}
              />
            </TriageAnchor>
          </TriageStepSection>
        </section>
        <section
          className="stage-panel"
          id="stage-decide"
          aria-label="Decide"
          tabIndex={-1}
          hidden={stage !== "decide"}
        >
          <TriageStepSection
            id="triage-decide"
            step={4}
            title="Decide"
            lede="Decisions are human calls. Analysis and agreement inform them; they never make them."
          >
            <div className="triage-decide">
              <p className="triage-step__note">
                Review the lanes in{" "}
                <button
                  type="button"
                  className="crumbs__link"
                  onClick={() => selectStage("compare")}
                >
                  Compare
                </button>{" "}
                first. The accepted decision and its history are recorded below; when the team has
                decided, update the status and export a share-safe record.
              </p>
              <ExperimentLab
                caseId={current.id}
                surface="decision"
                canWrite={canWrite}
                canLead={canLead}
                readOnly={readOnly}
                caseTitle={current.title}
                caseStatus={current.status}
                caseSeverity={current.severity}
                {...(props.focus ? { routeFocus: props.focus } : {})}
                {...(props.onDeepNavigate
                  ? { onDeepNavigate: (focus: WorkFocus) => props.onDeepNavigate?.("decide", focus) }
                  : {})}
                {...(props.participant ? { participant: props.participant } : {})}
              />
              {canLead && resolutionOpen ? (
                <ResolutionForm
                  prompted={resolutionPrompted}
                  error={resolutionError}
                  onSubmit={(payload) => setStatus("resolved", payload)}
                  onCancel={() => {
                    setResolutionOpen(false);
                    setResolutionPrompted(false);
                    setResolutionError(null);
                  }}
                />
              ) : null}
              {canLead ? (
                <form
                  key={current.id}
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = String(new FormData(e.currentTarget).get("status") ?? "");
                    if (next === "resolved") {
                      // The record comes first. Opening the form here rather
                      // than posting and waiting for a refusal keeps the
                      // conclusion and the status one action, not two.
                      setResolutionOpen(true);
                      setResolutionPrompted(false);
                      setResolutionError(null);
                      return;
                    }
                    void setStatus(next);
                  }}
                >
                  <select
                    className="login__input"
                    name="status"
                    aria-label="Case status"
                    defaultValue={current.status}
                  >
                    <option value="open">open</option>
                    <option value="monitoring">monitoring</option>
                    <option value="resolved">resolved</option>
                    <option value="archived">archived</option>
                  </select>
                  <button className="login__submit" type="submit">
                    Update status
                  </button>
                </form>
              ) : !readOnly ? (
                <p className="triage-step__note">Only a case lead can change the case status.</p>
              ) : null}
              {!readOnly ? (
                <details className="case-view__support">
                  <summary>Case export tools</summary>
                  <ExportPanel caseId={current.id} canWrite={canWrite} canLead={canLead} />
                </details>
              ) : (
                <p className="triage-step__note" role="status">
                  Static read-only view: status changes and exports are unavailable.
                </p>
              )}
            </div>
          </TriageStepSection>
        </section>
      </div>
      {discussionOpen ? (
        <CaseDiscussion
          key={current.id}
          caseId={current.id}
          {...(props.participant ? { participant: props.participant } : {})}
          canWrite={canWrite}
          readOnly={readOnly}
          onClose={closeDiscussion}
          onPosted={() => void loadTimeline(current.id)}
          onPresence={setDiscussionPresence}
          {...(props.focus ? { routeFocus: props.focus } : {})}
        />
      ) : null}
      </div>
    </article>
  );
}
