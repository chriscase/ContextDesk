import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ExperimentLab } from "./ExperimentLab.js";
import { ExportPanel } from "./ExportPanel.js";
import { ImportedRun } from "./ImportedRun.js";
import { CaseBoardPanel } from "./CaseBoardPanel.js";
import { TriageRunPanel } from "./TriageRunPanel.js";

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

interface TimelineEvent {
  seq: number;
  kind: string;
  actorUsername: string;
  targetId?: string | null;
  clientTime?: string | null;
  serverTime: string;
  payload: string;
}

interface RunRow {
  id: string;
  outputText: string;
  corroborationState: string;
  evidenceVisibility: string;
  snapshotBinding: string | null;
  importerUsername: string;
  operatorUsername: string;
  promptText: string | null;
  promptCompleteness: string;
}

function timelinePayload(payload: string): string {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return String(value);
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => {
        const label = key.replaceAll(/([a-z])([A-Z])/g, "$1 $2");
        const rendered = Array.isArray(item)
          ? item.join(", ")
          : typeof item === "object" && item !== null
            ? JSON.stringify(item)
            : String(item);
        return `${label}: ${rendered}`;
      })
      .join(" · ");
  } catch {
    return payload;
  }
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
  const [title, setTitle] = useState("");
  const [sources, setSources] = useState<{ id: string; name: string; kind: string }[]>([]);
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
    const body = (await res.json()) as { sources?: { id: string; name: string; kind: string }[] };
    setSources(body.sources ?? []);
  }, []);

  const loadTimeline = useCallback(async (id: string) => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => generation === loadGeneration.current && activeCaseRef.current === id;
    const res = await fetch(`/api/cases/${id}/timeline`);
    if (!res.ok || !isCurrent()) return;
    const body = (await res.json()) as { events?: TimelineEvent[] };
    if (!isCurrent()) return;
    setEvents(body.events ?? []);
    const imported = await fetch(`/api/cases/${id}/imports`);
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
    activeCaseRef.current = active;
    loadGeneration.current += 1;
    setEvents([]);
    setRuns([]);
    setActionError(null);
    if (active) void loadTimeline(active);
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
            {canLead ? (
              <form
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
            ) : null}
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
            <CaseBoardPanel caseId={current.id} canWrite={canWrite} canLead={canLead} readOnly={readOnly} />
            <TriageRunPanel caseId={current.id} canLead={canLead} readOnly={readOnly} />
            <details className="case-view__support">
              <summary>Case timeline and external evidence</summary>
                <ol className="timeline">
                {events.map((ev) => (
                  <li key={ev.seq} className="timeline__item">
                    <div className="timeline__meta">
                      #{ev.seq} {ev.kind} · {ev.actorUsername}
                      {ev.targetId ? ` · target ${ev.targetId}` : ""}
                    </div>
                    <div>{timelinePayload(ev.payload)}</div>
                  </li>
                ))}
              </ol>
              {runs.map((run) => (
                <ImportedRun
                  key={run.id}
                  run={run}
                  canCorroborate={canWrite}
                  onCorroborate={corroborate}
                />
              ))}
              {canWrite ? (
                <form className="composer" onSubmit={(e) => void importRun(e)}>
                {importError ? <p className="import-warn" role="alert">{importError}</p> : null}
                <p className="import-warn">
                  Pasted prompts may contain secrets. Mask them before save. Imported
                  output stays unverified until a human corroborates it. Without a
                  #888 package, visibility is importer-described or unknown.
                </p>
                <textarea
                  className="login__input"
                  name="outputText"
                  aria-label="External run output"
                  required
                  rows={3}
                  placeholder="Output"
                />
                <textarea
                  className="login__input"
                  name="promptText"
                  aria-label="External run prompt (optional)"
                  rows={2}
                  placeholder="Prompt (optional)"
                />
                <select
                  className="login__input"
                  name="sourceId"
                  aria-label="External run source"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    Source
                  </option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.kind})
                    </option>
                  ))}
                </select>
                <input
                  className="login__input"
                  name="operatorUsername"
                  aria-label="Operator username"
                  placeholder="Operator username"
                  required
                />
                <input
                  className="login__input"
                  name="operatorId"
                  aria-label="Operator identity"
                  placeholder="Operator identity"
                  required
                />
                <select
                  className="login__input"
                  name="evidenceVisibility"
                  aria-label="External run evidence visibility"
                  defaultValue="unknown"
                >
                  <option value="unknown">visibility unknown</option>
                  <option value="importer_described">importer-described</option>
                </select>
                <input
                  className="login__input"
                  name="visibilityNote"
                  aria-label="External run visibility note"
                  placeholder="Visibility note"
                />
                <input
                  className="login__input"
                  name="snapshotBinding"
                  aria-label="Package snapshot identity"
                  placeholder="Package snapshot identity"
                />
                <label className="import-warn">
                  <input type="checkbox" name="redacted" /> I redacted secrets before save
                </label>
                <button className="login__submit" type="submit">
                  Import external run
                </button>
                </form>
              ) : null}
              {canWrite ? (
                <form className="composer" onSubmit={(e) => void addNote(e)}>
                <select
                  className="login__input"
                  name="kind"
                  aria-label="Timeline entry kind"
                  defaultValue="note"
                >
                  <option value="message">message</option>
                  <option value="note">note</option>
                  <option value="hypothesis">hypothesis</option>
                  <option value="action">action</option>
                </select>
                <label className="timeline__meta">
                  Timeline entry visibility
                  <select
                    className="login__input"
                    name="privacyClass"
                    aria-label="Timeline entry visibility"
                    defaultValue="owner_only"
                  >
                    <option value="owner_only">private to the case</option>
                    <option value="share_safe">eligible for share-safe export</option>
                  </select>
                </label>
                <textarea
                  className="login__input"
                  name="body"
                  aria-label="Timeline entry body"
                  required
                  rows={3}
                />
                <button className="login__submit" type="submit">
                  Add to timeline
                </button>
                </form>
              ) : null}
            </details>
            {!readOnly ? (
              <details className="case-view__support">
                <summary>Case export tools</summary>
                <ExportPanel caseId={current.id} canWrite={canWrite} canLead={canLead} />
              </details>
            ) : null}
          </>
        ) : (
          <p className="shell__copy">Select or create a case.</p>
        )}
      </article>
    </section>
  );
}
