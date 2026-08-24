import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CaseDiscussion } from "./CaseDiscussion.js";
import { ExperimentLab } from "./ExperimentLab.js";
import { ExportPanel } from "./ExportPanel.js";
import { CaseBoardPanel } from "./CaseBoardPanel.js";
import { TriageRunPanel } from "./TriageRunPanel.js";
import {
  TriageAnchor,
  TriageStepSection,
  TriageWorkspace,
  type ContributionView,
  type RunRow,
  type SourceOption,
  type TimelineEvent,
} from "./TriageWorkspace.js";
import type { WorkFocus } from "./app-location.js";

export type StageId = "situation" | "capture" | "analyze" | "compare" | "decide";

interface CaseParticipantRow {
  identityId?: string;
  username?: string;
}

interface CaseRow {
  id: string;
  title: string;
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
  onExitFocus?: (target: "overview" | "investigations") => void;
}) {
  const roles = props.roles ?? [];
  const readOnly = props.readOnly === true;
  const canLead = !readOnly && (roles.includes("case-lead") || roles.includes("admin"));
  const canWrite = !readOnly && (canLead || roles.includes("contributor"));
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [casesLoaded, setCasesLoaded] = useState(false);
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
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionPresence, setDiscussionPresence] = useState<number | null>(null);
  const activeCaseRef = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const discussionToggleRef = useRef<HTMLButtonElement>(null);
  const previousStage = useRef<StageId | null>(null);

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
    const res = await fetch("/api/cases");
    if (!res.ok) return;
    const body = (await res.json()) as { cases?: CaseRow[] };
    setCases(body.cases ?? []);
    setCasesLoaded(true);
  }, []);

  const refreshSources = useCallback(async () => {
    const res = await fetch("/api/catalog/sources");
    if (!res.ok) return;
    const body = (await res.json()) as { sources?: SourceOption[] };
    setSources(body.sources ?? []);
  }, []);

  const loadTimeline = useCallback(async (id: string, signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current && activeCaseRef.current === id;
    const requestInit = signal ? { signal } : undefined;
    const res = await fetch(`/api/cases/${id}/timeline`, requestInit);
    if (!res.ok || !isCurrent()) return;
    const body = (await res.json()) as { events?: TimelineEvent[] };
    if (!isCurrent()) return;
    setEvents(body.events ?? []);
    const contributionResponse = await fetch(`/api/cases/${id}/contributions`, requestInit);
    if (contributionResponse.ok && isCurrent()) {
      const contributionBody = (await contributionResponse.json()) as {
        contributions?: ContributionView[];
      };
      setContributions(contributionBody.contributions ?? []);
    }
    const imported = await fetch(`/api/cases/${id}/imports`, requestInit);
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

  useEffect(() => {
    const controller = new AbortController();
    activeCaseRef.current = focusCaseId;
    loadGeneration.current += 1;
    setEvents([]);
    setContributions([]);
    setRuns([]);
    setActionError(null);
    setImportError(null);
    setDiscussionOpen(false);
    setDiscussionPresence(null);
    if (focusCaseId) void loadTimeline(focusCaseId, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [focusCaseId, loadTimeline]);

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
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, severity: "medium" }),
    });
    if (!res.ok) {
      setActionError("The investigation could not be created. You may not have permission to create one.");
      return;
    }
    const created = (await res.json()) as CaseRow;
    setTitle("");
    openCase(created.id);
    await refresh();
  }

  async function setStatus(status: string) {
    if (!focusCaseId) return;
    setActionError(null);
    const response = await fetch(`/api/cases/${focusCaseId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      setActionError("The status could not be updated. You may not have permission to change it.");
      return;
    }
    await refresh();
  }

  async function importRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!focusCaseId) return;
    const form = event.currentTarget;
    setImportError(null);
    const data = new FormData(form);
    try {
      const response = await fetch(`/api/cases/${focusCaseId}/imports`, {
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
      await loadTimeline(focusCaseId);
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
    const response = await fetch(`/api/cases/${focusCaseId}/imports/${id}/corroborate`, {
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
    await loadTimeline(focusCaseId);
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
    const response = await fetch(`/api/cases/${focusCaseId}/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, body, privacyClass }),
    });
    if (!response.ok) {
      setActionError("Timeline entry could not be added. You may not have permission to write to this case.");
      return;
    }
    form.reset();
    await loadTimeline(focusCaseId);
  }

  const current = cases.find((c) => c.id === focusCaseId);
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

  if (!current) {
    return (
      <div className="cases">
        {actionError ? (
          <p className="case-memory__error" role="alert">
            {actionError}
          </p>
        ) : null}
        {focusCaseId && !casesLoaded ? (
          <p className="case-list__empty" role="status">
            Loading the investigation…
          </p>
        ) : null}
        {focusCaseId && casesLoaded ? (
          <p className="case-list__empty" role="alert">
            That investigation is not available to your account.{" "}
            <button type="button" className="crumbs__link" onClick={() => exitFocus("overview")}>
              Back to the overview
            </button>
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
            {investigationList}
          </section>
        ) : (
          <section className="overview" aria-labelledby="investigations-title">
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
            canWrite={canWrite}
            readOnly={readOnly}
            sources={sources}
            events={events}
            contributions={contributions}
            runs={runs}
            importError={importError}
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
            lede="Curate the evidence the case may rely on, freeze a snapshot, then run ContextDesk model lanes against exactly that snapshot."
          >
            <TriageAnchor id="triage-evidence-board" label="Evidence board and snapshots">
              <CaseBoardPanel caseId={current.id} canWrite={canWrite} canLead={canLead} readOnly={readOnly} />
            </TriageAnchor>
            <TriageAnchor id="triage-lane-runner" label="AI lane runner">
              <TriageRunPanel caseId={current.id} canLead={canLead} readOnly={readOnly} />
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
        />
      ) : null}
      </div>
    </article>
  );
}
