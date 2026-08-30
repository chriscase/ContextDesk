import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { protectedApiFetch } from "./protected-api.js";
import { LifecyclePanel } from "./LifecyclePanel.js";
import type { StageId, WorkFocus } from "./app-location.js";

type InvestigationContext = {
  productName: string;
  version: string;
  build: string;
  component: string;
  environment: string;
  organization: string;
};

type InvestigationRow = {
  id: string;
  title: string;
  problemStatement?: string | null;
  affectedParties?: string | null;
  impact?: string | null;
  scope?: string | null;
  openQuestions?: string[];
  investigationContext?: InvestigationContext | null;
  occurredAt?: string | null;
  occurredAtPrecision?: string;
  occurredAtZone?: string;
  status: string;
  severity: string;
  participants?: { identityId?: string; username?: string }[];
  createdAt?: string;
  createdBy?: string;
  legalHold?: boolean;
  retentionClass?: string;
};

type EvidenceRow = {
  id: string;
  kind: string;
  filename?: string | null;
  uri?: string | null;
  mediaType?: string | null;
  byteLength?: number | null;
  contentHash?: string | null;
  expectedHash?: string | null;
  verificationStatus?: string | null;
  privacyClass?: string;
  summaryContributionId?: string | null;
  uploaderId?: string;
  relativePath?: string | null;
  sourceId?: string;
};

type ContributionRow = {
  id: string;
  body?: string | null;
  tombstoned?: boolean;
};

type SituationDraft = {
  problemStatement: string;
  affectedParties: string;
  impact: string;
  scope: string;
  occurredAt: string;
  openQuestions: string;
  investigationContext: InvestigationContext;
};

const EMPTY_CONTEXT: InvestigationContext = {
  productName: "",
  version: "",
  build: "",
  component: "",
  environment: "",
  organization: "",
};

const EMPTY_SITUATION: SituationDraft = {
  problemStatement: "",
  affectedParties: "",
  impact: "",
  scope: "",
  occurredAt: "",
  openQuestions: "",
  investigationContext: EMPTY_CONTEXT,
};

const CONTEXT_FIELDS: readonly [keyof InvestigationContext, string][] = [
  ["productName", "Product or software"],
  ["version", "Version"],
  ["build", "Build"],
  ["component", "Component"],
  ["environment", "Environment"],
  ["organization", "Customer, team, or organization"],
];

const MAX_UPLOAD_BYTES = 1_000_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function display(value: unknown): string {
  const cleaned = text(value);
  return cleaned || "Not recorded";
}

function listQuestions(value: string): string[] {
  return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
}

function contextPayload(context: InvestigationContext): InvestigationContext | null {
  return Object.values(context).some((value) => text(value)) ? { ...context } : null;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function occurrenceLabel(row: InvestigationRow): string {
  if (!row.occurredAt) return "Not recorded";
  if (row.occurredAtZone === "explicit") return dateLabel(row.occurredAt);
  const precision = row.occurredAtPrecision && row.occurredAtPrecision !== "exact"
    ? `${row.occurredAtPrecision} only`
    : "time zone not recorded";
  return `${row.occurredAt} (${precision})`;
}

function errorMessage(response: Response, fallback: string): Promise<string> {
  return response.json().catch(() => ({})).then((body: unknown) => {
    if (typeof body === "object" && body !== null) {
      const detail = "detail" in body && typeof body.detail === "string" ? body.detail.trim() : "";
      if (detail) return `${fallback} ${detail}`;
    }
    return fallback;
  });
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("The selected file could not be read."));
        return;
      }
      const comma = reader.result.indexOf(",");
      resolve(comma === -1 ? reader.result : reader.result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("The selected file could not be read."));
    reader.readAsDataURL(file);
  });
}

function ComboField(props: {
  field: keyof InvestigationContext;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const listId = `investigation-first-${props.field}-options`;
  const hintId = `${listId}-hint`;
  const normalizedValue = text(props.value).toLocaleLowerCase();
  const existing = normalizedValue.length > 0 && props.options.some((option) => option.toLocaleLowerCase() === normalizedValue);
  const hint = !normalizedValue
    ? "Choose a recorded value or enter a new one."
    : existing
      ? "Using an existing recorded value."
      : "New value — it will be recorded exactly as entered.";
  return (
    <label className="investigation-first__field">
      <span>{props.label}</span>
      <input
        className="login__input"
        role="combobox"
        aria-autocomplete="list"
        aria-describedby={hintId}
        list={listId}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <datalist id={listId}>
        {props.options.map((option) => <option key={option} value={option} />)}
      </datalist>
      <small id={hintId}>{hint}</small>
    </label>
  );
}

export function InvestigationFirst(props: {
  canWrite: boolean;
  canLead: boolean;
  readOnly: boolean;
  view: "overview" | "investigations";
  focusCaseId: string | null;
  stage: StageId;
  focus?: WorkFocus;
  startSignal?: number;
  onOpenCase: (caseId: string) => void;
  onExitFocus: () => void;
  onOpenAdvancedTools?: (caseId: string, stage: StageId) => void;
  onFocusedCaseTitle?: (title: string | null) => void;
}) {
  const [cases, setCases] = useState<InvestigationRow[]>([]);
  const [selected, setSelected] = useState<InvestigationRow | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [contributions, setContributions] = useState<ContributionRow[]>([]);
  const [evidenceLoadError, setEvidenceLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [situation, setSituation] = useState<SituationDraft>(EMPTY_SITUATION);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const detailGeneration = useRef(0);
  const activeFocusCaseId = useRef(props.focusCaseId);
  activeFocusCaseId.current = props.focusCaseId;

  const refreshCases = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const response = await protectedApiFetch("/api/cases");
      if (!response.ok) throw new Error(await errorMessage(response, "Investigations could not be loaded."));
      const body = (await response.json()) as { cases?: InvestigationRow[] };
      setCases(body.cases ?? []);
      setListError(null);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Investigations could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (caseId: string) => {
    if (caseId !== activeFocusCaseId.current) return;
    const generation = detailGeneration.current + 1;
    detailGeneration.current = generation;
    setDetailLoading(true);
    setDetailError(null);
    setSelectedEvidence([]);
    setEvidenceLoadError(null);
    try {
      const [caseResponse, evidenceResponse, contributionsResponse] = await Promise.all([
        protectedApiFetch(`/api/cases/${caseId}`),
        protectedApiFetch(`/api/cases/${caseId}/evidence`),
        protectedApiFetch(`/api/cases/${caseId}/contributions`),
      ]);
      if (generation !== detailGeneration.current || caseId !== activeFocusCaseId.current) return;
      if (!caseResponse.ok) {
        const fallback = caseResponse.status === 404
          ? "This investigation could not be found."
          : caseResponse.status === 403
            ? "You no longer have access to this investigation."
            : "This investigation could not be opened.";
        throw new Error(await errorMessage(caseResponse, fallback));
      }
      const evidenceBodyPromise: Promise<{ artifacts?: EvidenceRow[]; loadError?: string }> = evidenceResponse.ok
        ? evidenceResponse.json()
        : errorMessage(evidenceResponse, "Evidence inventory could not be loaded.").then((loadError) => ({ artifacts: [], loadError }));
      const contributionsBodyPromise: Promise<{ contributions?: ContributionRow[]; loadError?: string }> = contributionsResponse.ok
        ? contributionsResponse.json()
        : errorMessage(contributionsResponse, "Evidence annotations could not be loaded.").then((loadError) => ({ contributions: [], loadError }));
      const [caseBody, evidenceBody, contributionsBody] = await Promise.all([
        caseResponse.json() as Promise<InvestigationRow>,
        evidenceBodyPromise,
        contributionsBodyPromise,
      ]);
      if (generation !== detailGeneration.current || caseId !== activeFocusCaseId.current) return;
      setSelected(caseBody);
      setEvidence(evidenceBody.artifacts ?? []);
      setContributions(contributionsBody.contributions ?? []);
      setEvidenceLoadError(evidenceBody.loadError ?? contributionsBody.loadError ?? null);
      props.onFocusedCaseTitle?.(caseBody.title);
      setDetailError(null);
    } catch (cause) {
      if (generation !== detailGeneration.current || caseId !== activeFocusCaseId.current) return;
      setSelected(null);
      setEvidence([]);
      setContributions([]);
      setEvidenceLoadError(null);
      setDetailError(cause instanceof Error ? cause.message : "This investigation could not be opened.");
      props.onFocusedCaseTitle?.(null);
    } finally {
      if (generation === detailGeneration.current && caseId === activeFocusCaseId.current) setDetailLoading(false);
    }
  }, [props.onFocusedCaseTitle]);

  useEffect(() => { void refreshCases(); }, [refreshCases]);

  useEffect(() => {
    if (props.focusCaseId) {
      void refreshDetail(props.focusCaseId);
    } else {
      detailGeneration.current += 1;
      setDetailLoading(false);
      setSelected(null);
      setEvidence([]);
      setContributions([]);
      setEvidenceLoadError(null);
      setDetailError(null);
      props.onFocusedCaseTitle?.(null);
    }
  }, [props.focusCaseId, refreshDetail, props.onFocusedCaseTitle]);

  useEffect(() => {
    if (!props.startSignal) return;
    titleRef.current?.focus();
    titleRef.current?.scrollIntoView?.({ block: "center" });
  }, [props.startSignal]);

  const contextOptions = useMemo(() => {
    const result: Record<keyof InvestigationContext, string[]> = {
      productName: [], version: [], build: [], component: [], environment: [], organization: [],
    };
    for (const row of cases) {
      for (const [field] of CONTEXT_FIELDS) {
        const value = text(row.investigationContext?.[field]);
        if (value && !result[field].includes(value)) result[field].push(value);
      }
    }
    return result;
  }, [cases]);

  const filteredCases = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return cases.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!normalized) return true;
      return [row.id, row.title, row.problemStatement, row.affectedParties, row.impact, row.investigationContext?.productName, row.investigationContext?.build]
        .filter(Boolean).join(" ").toLocaleLowerCase().includes(normalized);
    });
  }, [cases, query, statusFilter]);

  const summaryById = useMemo(() => new Map(contributions.map((item) => [item.id, item])), [contributions]);

  async function createInvestigation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || creating || !props.canWrite || props.readOnly) return;
    setCreating(true);
    setError(null);
    try {
      const response = await protectedApiFetch("/api/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          severity,
          problemStatement: situation.problemStatement,
          affectedParties: situation.affectedParties,
          impact: situation.impact,
          scope: situation.scope,
          openQuestions: listQuestions(situation.openQuestions),
          investigationContext: contextPayload(situation.investigationContext),
          ...(situation.occurredAt.trim() ? { occurredAt: situation.occurredAt.trim() } : {}),
        }),
      });
      if (!response.ok) {
        setError(await errorMessage(response, "The investigation could not be created. Check your permission and try again."));
        return;
      }
      const created = (await response.json()) as InvestigationRow;
      setTitle("");
      setSeverity("medium");
      setSituation(EMPTY_SITUATION);
      setAdvancedOpen(false);
      setCases((current) => [created, ...current.filter((row) => row.id !== created.id)]);
      props.onOpenCase(created.id);
      await refreshCases();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The investigation could not be created.");
    } finally {
      setCreating(false);
    }
  }

  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || uploading || !props.canWrite || props.readOnly) return;
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
    const summary = text((form.elements.namedItem("summary") as HTMLInputElement | null)?.value);
    const kind = text((form.elements.namedItem("kind") as HTMLSelectElement | null)?.value) || "attachment";
    const privacyClass = text((form.elements.namedItem("privacyClass") as HTMLSelectElement | null)?.value) || "owner_only";
    if (!file) { setError("Choose a file to add to the evidence inventory."); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setError("Files must be 1 MB or smaller."); return; }
    if (!summary) { setError("Add a short annotation so the evidence can be understood later."); return; }
    setUploading(true);
    setError(null);
    try {
      const response = await protectedApiFetch(`/api/cases/${selected.id}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, mediaType: file.type || "application/octet-stream", contentBase64: await readBase64(file), kind, summary, privacyClass }),
      });
      if (!response.ok) { setError(await errorMessage(response, "The evidence could not be added.")); return; }
      form.reset();
      await refreshDetail(selected.id);
      await refreshCases();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The evidence could not be added.");
    } finally {
      setUploading(false);
    }
  }

  function renderCreateForm() {
    if (!props.canWrite || props.readOnly) return null;
    return (
      <section className="investigation-first__create" aria-labelledby="investigation-first-create-title">
        <div className="investigation-first__section-heading">
          <div>
            <p className="investigation-first__eyebrow">Fast capture</p>
            <h2 id="investigation-first-create-title">Create an investigation</h2>
            <p>Start with what you know. Add technical context when it helps someone else find or understand this work.</p>
          </div>
          <span className="investigation-first__time">About 60–90 seconds</span>
        </div>
        <form onSubmit={(event) => void createInvestigation(event)}>
          <div className="investigation-first__form-grid">
            <label className="investigation-first__field investigation-first__field--wide">
              <span>What should the team call this?</span>
              <input ref={titleRef} className="login__input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Short investigation title" required />
            </label>
            <label className="investigation-first__field">
              <span>Severity</span>
              <select className="login__input" value={severity} onChange={(event) => setSeverity(event.target.value)}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
              </select>
            </label>
            <label className="investigation-first__field investigation-first__field--wide">
              <span>What was observed?</span>
              <textarea value={situation.problemStatement} onChange={(event) => setSituation((current) => ({ ...current, problemStatement: event.target.value }))} placeholder="Describe the problem without assuming its cause." rows={3} />
            </label>
            <label className="investigation-first__field">
              <span>Who or what is affected?</span>
              <textarea value={situation.affectedParties} onChange={(event) => setSituation((current) => ({ ...current, affectedParties: event.target.value }))} placeholder="People, services, or customers" rows={2} />
            </label>
            <label className="investigation-first__field">
              <span>What is the impact?</span>
              <textarea value={situation.impact} onChange={(event) => setSituation((current) => ({ ...current, impact: event.target.value }))} placeholder="The recorded operational impact" rows={2} />
            </label>
          </div>
          <details className="investigation-first__advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}>
            <summary>Advanced context <span>Product, build, timing, scope, and open questions</span></summary>
            <div className="investigation-first__form-grid">
              {CONTEXT_FIELDS.map(([field, label]) => <ComboField key={field} field={field} label={label} value={situation.investigationContext[field]} options={contextOptions[field]} onChange={(value) => setSituation((current) => ({ ...current, investigationContext: { ...current.investigationContext, [field]: value } }))} />)}
              <label className="investigation-first__field">
                <span>When did it happen?</span>
                <input className="login__input" value={situation.occurredAt} onChange={(event) => setSituation((current) => ({ ...current, occurredAt: event.target.value }))} placeholder="2026-08-29 or leave empty" />
              </label>
              <label className="investigation-first__field">
                <span>Scope</span>
                <input className="login__input" value={situation.scope} onChange={(event) => setSituation((current) => ({ ...current, scope: event.target.value }))} placeholder="What is in or out of scope?" />
              </label>
              <label className="investigation-first__field investigation-first__field--wide">
                <span>Open questions <small>one per line</small></span>
                <textarea value={situation.openQuestions} onChange={(event) => setSituation((current) => ({ ...current, openQuestions: event.target.value }))} placeholder="What still needs to be learned?" rows={3} />
              </label>
            </div>
          </details>
          <div className="investigation-first__form-actions">
            <button className="login__submit" type="submit" disabled={creating}>{creating ? "Creating…" : "Create investigation"}</button>
            <span>Blank fields remain explicitly not recorded.</span>
          </div>
        </form>
      </section>
    );
  }

  function renderList() {
    return (
      <section className="investigation-first__browse" aria-labelledby="investigation-first-browse-title">
        <div className="investigation-first__section-heading">
          <div><p className="investigation-first__eyebrow">Browse work</p><h2 id="investigation-first-browse-title">Investigations</h2><p>Open a record to see what is known, what is missing, and what can happen next.</p></div>
          <span className="investigation-first__count" aria-live="polite">{filteredCases.length} shown · {cases.length} total</span>
        </div>
        <div className="investigation-first__filters">
          <label><span>Search</span><input className="login__input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, product, build, or problem" aria-label="Search investigations" /></label>
          <label><span>Status</span><select className="login__input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter investigations by status"><option value="all">All statuses</option><option value="open">Open</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option><option value="archived">Archived</option></select></label>
        </div>
        {loading ? <p className="investigation-first__empty" role="status">Loading investigations…</p> : null}
        {!loading && listError ? <div className="investigation-first__error" role="alert"><p>{listError}</p><button type="button" onClick={() => void refreshCases()}>Retry loading investigations</button></div> : null}
        {!loading && !listError && filteredCases.length === 0 ? <p className="investigation-first__empty">{props.canWrite && !props.readOnly ? "No investigations match this view. Try a different search or create a new one." : "No investigations match this view. Try a different search."}</p> : null}
        <ul className="investigation-first__list">
          {filteredCases.map((row) => {
            const missing = [row.problemStatement, row.affectedParties, row.impact].filter((value) => !text(value)).length;
            return <li key={row.id} className="investigation-first__list-item">
              <button type="button" className="investigation-first__list-button" onClick={() => props.onOpenCase(row.id)}>
                <span className="investigation-first__list-title">{row.title || "Untitled investigation"}</span>
                <span className="investigation-first__list-meta"><span className={`status-pill status-pill--${row.status}`}>{row.status}</span><span>{row.severity}</span>{row.investigationContext?.productName ? <span>{row.investigationContext.productName}{row.investigationContext.build ? ` · ${row.investigationContext.build}` : ""}</span> : null}</span>
                <span className="investigation-first__list-hint">{missing ? `${missing} key ${missing === 1 ? "field" : "fields"} not recorded` : "Core context recorded"}</span>
              </button>
            </li>;
          })}
        </ul>
      </section>
    );
  }

  function renderDetail() {
    if (detailLoading || (!detailError && selected?.id !== props.focusCaseId)) return <section className="investigation-first__detail" aria-busy="true"><p className="investigation-first__empty" role="status">Opening investigation…</p></section>;
    if (detailError) return <section className="investigation-first__detail"><p className="investigation-first__error" role="alert">{detailError}</p><button type="button" onClick={props.onExitFocus}>Back to investigations</button></section>;
    if (!selected) return <section className="investigation-first__detail"><p className="investigation-first__empty">This investigation is unavailable.</p><button type="button" onClick={props.onExitFocus}>Back to investigations</button></section>;
    const missing = [selected.problemStatement, selected.affectedParties, selected.impact].filter((value) => !text(value)).length;
    return (
      <section className="investigation-first__detail" aria-labelledby="investigation-first-detail-title">
        <button type="button" className="investigation-first__back" onClick={props.onExitFocus}>← Back to investigations</button>
        <header className="investigation-first__detail-header">
          <div><p className="investigation-first__eyebrow">Investigation</p><h2 id="investigation-first-detail-title">{selected.title || "Untitled investigation"}</h2><p className="investigation-first__detail-subtitle">{selected.id}</p></div>
          <div className="investigation-first__detail-actions"><span className={`status-pill status-pill--${selected.status}`}>{selected.status}</span><span className="severity-pill">{selected.severity}</span>{props.onOpenAdvancedTools ? <button type="button" onClick={() => props.onOpenAdvancedTools?.(selected.id, "analyze")}>Open War Room technical tools</button> : null}</div>
        </header>
        {error ? <p className="investigation-first__error" role="alert">{error}</p> : null}
        <div className="investigation-first__next" role="status"><strong>{missing ? `${missing} key ${missing === 1 ? "detail" : "details"} still to record` : "Core context is recorded"}</strong><span>{missing ? "Add detail when it is known; this sparse record is still valid." : "Use the evidence inventory or technical tools to continue."}</span></div>
        <div className="investigation-first__detail-grid">
          <article className="investigation-first__card investigation-first__card--wide"><h3>What is known</h3><dl className="investigation-first__facts"><div><dt>Observed problem</dt><dd>{display(selected.problemStatement)}</dd></div><div><dt>Affected people or systems</dt><dd>{display(selected.affectedParties)}</dd></div><div><dt>Impact</dt><dd>{display(selected.impact)}</dd></div><div><dt>Scope</dt><dd>{display(selected.scope)}</dd></div><div><dt>When it happened</dt><dd>{occurrenceLabel(selected)}</dd></div><div><dt>Recorded</dt><dd>{dateLabel(selected.createdAt)}</dd></div></dl></article>
          <article className="investigation-first__card"><h3>Technical context</h3><dl className="investigation-first__facts">{CONTEXT_FIELDS.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{display(selected.investigationContext?.[field])}</dd></div>)}</dl></article>
          <article className="investigation-first__card"><h3>Open questions</h3>{selected.openQuestions?.length ? <ul>{selected.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul> : <p className="investigation-first__muted">No questions recorded.</p>}</article>
        </div>
        <section className="investigation-first__card investigation-first__evidence" aria-labelledby="investigation-first-evidence-title">
          <div className="investigation-first__card-heading"><div><h3 id="investigation-first-evidence-title">Evidence inventory</h3><p>Files and references stay governed by the shared evidence and permission boundary.</p></div><span>{evidence.length} {evidence.length === 1 ? "item" : "items"}</span></div>
          {evidenceLoadError ? <p className="investigation-first__error" role="alert">{evidenceLoadError}</p> : null}
          {evidence.length === 0 ? (evidenceLoadError ? null : <p className="investigation-first__muted">No evidence has been registered yet.</p>) : <ul className="investigation-first__evidence-list">{evidence.map((artifact) => { const annotation = artifact.summaryContributionId ? summaryById.get(artifact.summaryContributionId)?.body : null; return <li key={artifact.id}><label className="investigation-first__evidence-select"><input type="checkbox" checked={selectedEvidence.includes(artifact.id)} onChange={(event) => setSelectedEvidence((current) => event.target.checked ? [...new Set([...current, artifact.id])] : current.filter((id) => id !== artifact.id))} /><span><strong>{artifact.filename || artifact.uri || "Unnamed evidence"}</strong><small>{annotation || "Annotation not available"}</small></span></label><details><summary>Metadata</summary><dl className="investigation-first__evidence-meta"><div><dt>Kind</dt><dd>{display(artifact.kind)}</dd></div><div><dt>Media type</dt><dd>{display(artifact.mediaType)}</dd></div><div><dt>Verification</dt><dd>{display(artifact.verificationStatus)}</dd></div><div><dt>Privacy</dt><dd>{display(artifact.privacyClass)}</dd></div><div><dt>Hash</dt><dd>{display(artifact.contentHash || artifact.expectedHash)}</dd></div><div><dt>Size</dt><dd>{artifact.byteLength == null ? "Not recorded" : `${artifact.byteLength.toLocaleString()} bytes`}</dd></div><div><dt>Source</dt><dd>{display(artifact.sourceId)}</dd></div><div><dt>Uploader</dt><dd>{display(artifact.uploaderId)}</dd></div><div><dt>Path</dt><dd>{display(artifact.relativePath)}</dd></div></dl></details></li>; })}</ul>}
          <div className="investigation-first__bulk-actions"><span>{selectedEvidence.length} selected</span><button type="button" disabled title="Recoverable trash is not enabled in this slice">Move selected to trash</button><button type="button" onClick={() => setSelectedEvidence([])} disabled={!selectedEvidence.length}>Clear selection</button><small>Bulk trash is reserved for a recoverable, audited lifecycle workflow; no file is deleted here.</small></div>
          {props.canWrite && !props.readOnly ? <form className="investigation-first__upload" onSubmit={(event) => void uploadEvidence(event)}><h4>Add evidence</h4><div className="investigation-first__upload-grid"><label>File<input name="file" type="file" /></label><label>Kind<select name="kind" defaultValue="attachment"><option value="attachment">Attachment</option><option value="log">Log</option><option value="email">Email</option><option value="file_server_ref">File reference</option></select></label><label>Privacy<select name="privacyClass" defaultValue="owner_only"><option value="owner_only">Owner only</option><option value="share_safe">Share safe</option></select></label><label className="investigation-first__field--wide">Annotation<input name="summary" placeholder="What is this file and why does it matter?" /></label></div><button type="submit" disabled={uploading}>{uploading ? "Adding…" : "Add to evidence inventory"}</button></form> : null}
        </section>
        {selected.status === "archived" || props.canLead ? <LifecyclePanel caseId={selected.id} status={selected.status} canLead={props.canLead && !props.readOnly} onChanged={async () => { await refreshCases(); await refreshDetail(selected.id); }} /> : null}
      </section>
    );
  }

  return <div className="investigation-first"><header className="investigation-first__hero"><div><p className="investigation-first__eyebrow">Investigation First</p><h1>Make the next useful action obvious.</h1><p>Capture a clear starting point quickly, then open a calm view of what is known, missing, and ready for deeper technical work.</p></div><div className="investigation-first__hero-note"><strong>One shared record</strong><span>Presentation changes here never change evidence, permissions, audit history, or triage integrity.</span></div></header>{error && !selected && !props.focusCaseId ? <p className="investigation-first__error" role="alert">{error}</p> : null}{props.focusCaseId ? renderDetail() : <>{renderCreateForm()}{renderList()}</>}</div>;
}
