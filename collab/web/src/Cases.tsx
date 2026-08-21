import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
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

interface CaseRow {
  id: string;
  title: string;
  status: string;
  severity: string;
  reportedProblem?: string | null;
  problem?: string | null;
  summary?: string | null;
  createdBy?: string | null;
  createdByUsername?: string | null;
  creator?: string | null;
}

export function Cases(props: {
  roles?: string[];
  readOnly?: boolean;
  participant?: { username: string; roles: string[] };
}) {
  const roles = props.roles ?? [];
  const readOnly = props.readOnly === true;
  const canLead = !readOnly && (roles.includes("case-lead") || roles.includes("admin"));
  const canWrite = !readOnly && (canLead || roles.includes("contributor"));
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [caseSearch, setCaseSearch] = useState("");
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [contributions, setContributions] = useState<ContributionView[]>([]);
  const [title, setTitle] = useState("");
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const activeCaseRef = useRef<string | null>(null);
  const loadGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/cases");
    if (!res.ok) return;
    const body = (await res.json()) as { cases?: CaseRow[] };
    const next = body.cases ?? [];
    setCases(next);
    setActive((current) => current ?? next[0]?.id ?? null);
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
    activeCaseRef.current = active;
    loadGeneration.current += 1;
    setEvents([]);
    setContributions([]);
    setRuns([]);
    setActionError(null);
    setImportError(null);
    if (active) void loadTimeline(active, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [active, loadTimeline]);

  async function createCase(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, severity: "medium" }),
    });
    if (!res.ok) {
      setActionError("Case could not be created. You may not have permission to create cases.");
      return;
    }
    const created = (await res.json()) as CaseRow;
    setTitle("");
    setActive(created.id);
    await refresh();
  }

  async function setStatus(status: string) {
    if (!active) return;
    setActionError(null);
    const response = await fetch(`/api/cases/${active}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      setActionError("Case status could not be updated. You may not have permission to change it.");
      return;
    }
    await refresh();
  }

  async function importRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active) return;
    const form = event.currentTarget;
    setImportError(null);
    const data = new FormData(form);
    try {
      const response = await fetch(`/api/cases/${active}/imports`, {
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
      await loadTimeline(active);
    } catch {
      setImportError("External run could not be imported. Check the connection and try again.");
    }
  }

  async function corroborate(
    id: string,
    state: "corroborated" | "contradicted",
    linkId: string,
  ) {
    if (!active) return;
    setActionError(null);
    const response = await fetch(`/api/cases/${active}/imports/${id}/corroborate`, {
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
    await loadTimeline(active);
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!active) return;
    setActionError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") ?? "");
    const kind = String(data.get("kind") ?? "note");
    const privacyClass = String(data.get("privacyClass") ?? "owner_only");
    const response = await fetch(`/api/cases/${active}/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, body, privacyClass }),
    });
    if (!response.ok) {
      setActionError("Timeline entry could not be added. You may not have permission to write to this case.");
      return;
    }
    form.reset();
    await loadTimeline(active);
  }

  const current = cases.find((c) => c.id === active);
  const normalizedSearch = caseSearch.trim().toLocaleLowerCase();
  const visibleCases = normalizedSearch
    ? cases.filter((c) =>
        [
          c.title,
          c.reportedProblem,
          c.problem,
          c.summary,
          c.id,
          c.createdBy,
          c.createdByUsername,
          c.creator,
        ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch)),
      )
    : cases;

  return (
    <section className="workbench">
      <aside className="case-list">
        <h2 className="case-list__title">Cases</h2>
        <label className="case-list__search">
          <span className="timeline__meta">Find a case</span>
          <input
            className="login__input"
            type="search"
            value={caseSearch}
            onChange={(e) => setCaseSearch(e.target.value)}
            placeholder="Title, problem, ID, or creator"
            aria-label="Search cases by title, problem, ID, or creator"
          />
        </label>
        <ul className="case-list__items">
          {visibleCases.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => setActive(c.id)}>
                {c.title}
              </button>
            </li>
          ))}
        </ul>
        {cases.length > 0 && visibleCases.length === 0 ? (
          <p className="timeline__meta">No cases match “{caseSearch}”.</p>
        ) : null}
        {canWrite ? (
          <form className="case-form" onSubmit={(e) => void createCase(e)}>
            <input
              className="login__input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New case title"
              required
            />
            <button className="login__submit" type="submit">
              Create case
            </button>
          </form>
        ) : null}
      </aside>
      <article className="case-view">
        {actionError ? <p className="case-memory__error" role="alert">{actionError}</p> : null}
        {current ? (
          <>
            <h2 className="case-view__title">
              {current.title}{" "}
              <span className="timeline__meta">
                {current.status} / {current.severity}
              </span>
            </h2>
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
            <TriageStepSection
              id="triage-compare"
              step={3}
              title="Compare"
              lede="Review model and strategy lanes side by side against the human benchmark. Agreement is not proof of correctness."
            >
              <TriageAnchor id="triage-comparison-lab" label="Comparison lab">
                <ExperimentLab
                  caseId={current.id}
                  canWrite={canWrite}
                  canLead={canLead}
                  readOnly={readOnly}
                  caseTitle={current.title}
                  caseStatus={current.status}
                  caseSeverity={current.severity}
                  {...(props.participant ? { participant: props.participant } : {})}
                />
              </TriageAnchor>
            </TriageStepSection>
            <TriageStepSection
              id="triage-decide"
              step={4}
              title="Decide"
              lede="Decisions are human calls. Analysis and agreement inform them; they never make them."
            >
              <div className="triage-decide">
                <p className="triage-step__note">
                  The accepted decision and its history live in the{" "}
                  <a href="#triage-comparison-lab">comparison lab&rsquo;s decision journal</a>.
                  When the team has decided, update the case status and export a share-safe
                  record.
                </p>
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
          </>
        ) : (
          <p className="shell__copy">Select or create a case.</p>
        )}
      </article>
    </section>
  );
}
