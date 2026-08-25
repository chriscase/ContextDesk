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
import { focusArrivalCopy } from "./route-focus-copy.js";
import { protectedApiFetch } from "./protected-api.js";

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
  const canLead = !readOnly && (roles.includes("case-lead") || roles.includes("admin"));
  const canWrite = !readOnly && (canLead || roles.includes("contributor"));
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
    void refreshActivity();
    void refreshSources();
    const refreshCatalog = () => void refreshSources();
    window.addEventListener("contextdesk:source-catalog-changed", refreshCatalog);
    return () => window.removeEventListener("contextdesk:source-catalog-changed", refreshCatalog);
  }, [refresh, refreshActivity, refreshSources]);

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
      }),
    });
    if (!res.ok) {
      setActionError("The investigation could not be created. You may not have permission to create one.");
      return;
    }
    const created = (await res.json()) as CaseRow;
    setTitle("");
    setNewSituation(EMPTY_SITUATION);
    // Make the server-confirmed investigation available before changing the URL.
    // A list refresh may still be in flight (or fail), but the focused workspace
    // must never momentarily fall back to the inventory for a case we just created.
    setCases((current) => [created, ...current.filter((row) => row.id !== created.id)]);
    openCase(created.id);
    await Promise.all([refresh(), refreshActivity()]);
  }

  async function setStatus(status: string) {
    if (!focusCaseId) return;
    setActionError(null);
    const response = await protectedApiFetch(`/api/cases/${focusCaseId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      setActionError("The status could not be updated. You may not have permission to change it.");
      return;
    }
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
  useEffect(() => {
    props.onFocusedCaseTitle?.(current?.title ?? null);
  }, [current?.title, props.onFocusedCaseTitle]);
  const normalizedSearch = caseSearch.trim().toLocaleLowerCase();
  const visibleCases = cases.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
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
        <p className="case-list__empty">
          No investigations are recorded yet.
          {canWrite ? " Start the first one below." : ""}
        </p>
      ) : null}
      {cases.length > 0 && visibleCases.length === 0 ? (
        <p className="case-list__empty">No investigations match the current search or filter.</p>
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
            <h2 id="missing-investigation-title">Investigation unavailable</h2>
            <p>That investigation is not available to your account.</p>
            <button type="button" className="crumbs__link" onClick={() => exitFocus("overview")}>
              Back to the overview
            </button>
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
            <dl className="overview__counts" aria-label="Investigations by recorded status">
              {statusCounts.map(([status, count]) => (
                <div key={status} className="overview__count">
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
                  <p className="overview__empty">No activity has been recorded yet.</p>
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
                              {investigation ? (
                                <span className={`status-pill status-pill--${investigation.status}`}>
                                  {investigation.status}
                                </span>
                              ) : null}
                              {item.provenanceClass !== "human" ? (
                                <span>{item.provenanceClass.replaceAll("_", " ")} · not a human finding</span>
                              ) : null}
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
              <aside className="overview__attention" aria-labelledby="overview-attention-title">
                <header className="overview__section-head">
                  <div>
                    <p className="overview__eyebrow">Needs attention</p>
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
                  <p className="overview__empty">No high-impact active investigations are recorded.</p>
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
                <span className="stage-nav__name">{item.label}</span>
                <span className="stage-nav__hint">{item.hint}</span>
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
              {canLead ? (
                <form
                  key={current.id}
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = String(new FormData(e.currentTarget).get("status") ?? "");
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
