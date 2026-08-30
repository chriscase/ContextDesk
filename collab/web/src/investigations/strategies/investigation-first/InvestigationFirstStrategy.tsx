import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  selectEvidenceInventory,
  selectResourceView,
  useInvestigationRuntime,
  type CaseV1,
  type LifecycleAction,
  type ResourceState,
} from "../../runtime/public.js";
import type { InvestigationStrategyShellProps } from "../contract.js";

type InvestigationContext = NonNullable<CaseV1["investigationContext"]>;
type RuntimeFailure = Extract<ResourceState<never>, { status: "failed" }>["error"];

interface SituationDraft {
  problemStatement: string;
  affectedParties: string;
  impact: string;
  scope: string;
  occurredAt: string;
  openQuestions: string;
  investigationContext: InvestigationContext;
}

const EMPTY_CONTEXT: InvestigationContext = {
  productName: "", version: "", build: "", component: "", environment: "", organization: "",
};
const EMPTY_SITUATION: SituationDraft = {
  problemStatement: "", affectedParties: "", impact: "", scope: "", occurredAt: "", openQuestions: "", investigationContext: EMPTY_CONTEXT,
};
const CONTEXT_FIELDS: readonly [keyof InvestigationContext, string][] = [
  ["productName", "Product or software"], ["version", "Version"], ["build", "Build"],
  ["component", "Component"], ["environment", "Environment"], ["organization", "Customer, team, or organization"],
];

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function display(value: unknown): string { return text(value) || "Not recorded"; }
function listQuestions(value: string): string[] { return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean); }
function contextPayload(value: InvestigationContext): InvestigationContext | null {
  return Object.values(value).some((item) => text(item)) ? { ...value } : null;
}
function dateLabel(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function occurrenceLabel(row: CaseV1): string {
  if (!row.occurredAt) return "Not recorded";
  if (row.occurredAtZone === "explicit") return dateLabel(row.occurredAt);
  const precision = row.occurredAtPrecision !== "unknown" ? `${row.occurredAtPrecision} precision` : "time zone not recorded";
  return `${row.occurredAt} (${precision})`;
}

function failureCopy(error: RuntimeFailure, subject: "list" | "detail" | "evidence" | "annotations" | "create" | "upload" | "lifecycle"): string {
  if (error.kind === "input") {
    if (error.field === "title") return "Add a title before creating the investigation.";
    if (error.field === "file" && error.reason === "too_large") return "Files must be 1 MB or smaller.";
    if (error.field === "file" && error.reason === "unreadable") return "The selected file could not be read.";
    if (error.field === "file") return "Choose a file to add to the evidence inventory.";
    return "Add a short annotation so the evidence can be understood later.";
  }
  if (error.kind === "lifecycle_refused") return error.detail;
  if (error.kind === "lifecycle_changed") return "The investigation changed before that action completed. Review its current state and try again if appropriate.";
  if (error.kind === "auth_lost") return "Your access changed while this page was open. Sign in again to continue.";
  if (error.kind === "not_found") return subject === "detail" ? "This investigation could not be found." : "The requested investigation record is no longer available.";
  if (error.kind === "validation") return "The recorded values could not be accepted. Review them and try again.";
  if (error.kind === "conflict") return "The investigation changed before this action completed. Refresh and try again.";
  const labels = { list: "Investigations", detail: "This investigation", evidence: "Evidence inventory", annotations: "Evidence annotations", create: "The investigation", upload: "The evidence", lifecycle: "Lifecycle information" } as const;
  if (error.kind === "unavailable" || error.kind === "server_failure" || error.kind === "network") return `${labels[subject]} could not be loaded right now. Try again.`;
  return `${labels[subject]} could not be processed safely. Try again.`;
}

function ComboField(props: { field: keyof InvestigationContext; label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  const listId = `investigation-first-${props.field}-options`;
  const hintId = `${listId}-hint`;
  const normalized = text(props.value).toLocaleLowerCase();
  const existing = normalized.length > 0 && props.options.some((option) => option.toLocaleLowerCase() === normalized);
  const hint = !normalized ? "Choose a recorded value or enter a new one." : existing ? "Using an existing recorded value." : "New value — it will be recorded exactly as entered.";
  return <label className="investigation-first__field"><span>{props.label}</span><input className="login__input" role="combobox" aria-label={props.label} aria-autocomplete="list" aria-controls={listId} aria-describedby={hintId} list={listId} value={props.value} onChange={(event) => props.onChange(event.target.value)} /><datalist id={listId}>{props.options.map((option) => <option key={option} value={option} />)}</datalist><small id={hintId} aria-live="polite">{hint}</small></label>;
}

function LifecycleControls({ investigation }: { investigation: CaseV1 }) {
  const runtime = useInvestigationRuntime();
  const lifecycle = selectResourceView(runtime.resources.lifecycle);
  const [confirmation, setConfirmation] = useState<LifecycleAction | null>(null);
  const action: LifecycleAction = investigation.status === "archived" ? "restore" : "archive";
  const descriptionId = "investigation-first-lifecycle-description";
  useEffect(() => setConfirmation(null), [action, investigation.id]);
  if (investigation.status !== "archived" && !runtime.capabilities.canManageLifecycle) return null;
  if (lifecycle.availability === "idle" || lifecycle.availability === "loading") return <section className="investigation-first__card investigation-first__lifecycle" aria-busy="true"><p role="status">Loading lifecycle options…</p></section>;
  if (lifecycle.availability === "unavailable") return <section className="investigation-first__card investigation-first__lifecycle"><h3>Archive and restore</h3><p className="investigation-first__error" role="alert">{failureCopy(lifecycle.error, "lifecycle")}</p><button type="button" onClick={runtime.refresh.lifecycle}>Retry lifecycle information</button></section>;
  if (lifecycle.refresh === "loading") return <section className="investigation-first__card investigation-first__lifecycle" aria-busy="true"><h3>Archive and restore</h3><p role="status">Refreshing lifecycle options…</p></section>;
  if (lifecycle.refresh === "failed") return <section className="investigation-first__card investigation-first__lifecycle"><h3>Archive and restore</h3><p className="investigation-first__error" role="alert">{failureCopy(lifecycle.refreshError, "lifecycle")}</p><button type="button" onClick={runtime.refresh.lifecycle}>Retry lifecycle information</button></section>;
  const verdict = action === "archive" ? lifecycle.value.archive : lifecycle.value.restore;
  const mutation = runtime.mutations.lifecycle;
  const command = runtime.commands.applyLifecycle;
  const working = mutation.status === "running";
  async function applyAction() {
    if (command === null || confirmation !== action || working) return;
    await command(action);
    setConfirmation(null);
  }
  return <section className="investigation-first__card investigation-first__lifecycle" aria-labelledby="investigation-first-lifecycle-title" aria-busy={working}>
    <h3 id="investigation-first-lifecycle-title">Archive and restore</h3><p id={descriptionId}>{lifecycle.value.deletion.detail}</p>
    {mutation.status === "failed" ? <p className="investigation-first__error" role="alert">{failureCopy(mutation.error, "lifecycle")}</p> : null}
    {!runtime.capabilities.canManageLifecycle || command === null ? <p className="investigation-first__muted" role="status">Archiving and restoring are unavailable in this view.</p>
      : !verdict.allowed ? <p className="investigation-first__muted" role="status">{verdict.detail}</p>
        : confirmation === action ? <div className="investigation-first__confirm" role="group" aria-label={`Confirm ${action}`}><p>{action === "archive" ? "Archive this investigation? Its record and evidence remain available and it can be restored." : `Restore this investigation to ${lifecycle.value.restoreTarget}?`}</p><button type="button" aria-describedby={descriptionId} disabled={working} onClick={() => void applyAction()}>{working ? `${action === "archive" ? "Archiving" : "Restoring"}…` : `Confirm ${action} investigation`}</button><button type="button" disabled={working} onClick={() => setConfirmation(null)}>Cancel</button></div>
          : <button type="button" aria-describedby={descriptionId} onClick={() => setConfirmation(action)}>{action === "archive" ? "Archive investigation" : "Restore investigation"}</button>}
    {mutation.status === "succeeded" ? <p role="status">Investigation {mutation.value.action === "archive" ? "archived" : "restored"}.</p> : null}
  </section>;
}

/** Presentation-only Investigation First strategy. All behavior comes from Runtime V1. */
export function InvestigationFirstStrategy(props: InvestigationStrategyShellProps) {
  const runtime = useInvestigationRuntime();
  const investigations = selectResourceView(runtime.resources.investigations);
  const investigation = selectResourceView(runtime.resources.investigation);
  const evidenceInventory = selectEvidenceInventory(runtime.resources.evidence, runtime.resources.contributions);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedEvidence, setSelectedEvidence] = useState<readonly string[]>([]);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<CaseV1["severity"]>("medium");
  const [situation, setSituation] = useState<SituationDraft>(EMPTY_SITUATION);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const browseHeadingRef = useRef<HTMLHeadingElement>(null);
  const priorFocusId = useRef<string | null>(props.focusCaseId);
  const cases = investigations.availability === "available" ? investigations.value : [];
  const focusedTitle = props.focusCaseId !== null
    && investigation.availability === "available"
    && investigation.value.id === props.focusCaseId
      ? investigation.value.title
      : null;
  const evidenceSelectionKey = evidenceInventory.inventory.availability === "available"
    ? evidenceInventory.inventory.value.map(({ evidence }) => evidence.id).join("\u0000")
    : "";
  const contextOptions = useMemo(() => {
    const result: Record<keyof InvestigationContext, string[]> = { productName: [], version: [], build: [], component: [], environment: [], organization: [] };
    for (const row of cases) for (const [field] of CONTEXT_FIELDS) { const value = text(row.investigationContext?.[field]); if (value && !result[field].includes(value)) result[field].push(value); }
    return result;
  }, [cases]);
  const filteredCases = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return cases.filter((row) => (statusFilter === "all" || row.status === statusFilter) && (!normalized || [row.id, row.title, row.problemStatement, row.affectedParties, row.impact, row.investigationContext?.productName, row.investigationContext?.build].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalized)));
  }, [cases, query, statusFilter]);

  useEffect(() => { if (props.startSignal) { titleRef.current?.focus(); titleRef.current?.scrollIntoView?.({ block: "center" }); } }, [props.startSignal]);
  useEffect(() => setSelectedEvidence([]), [props.focusCaseId]);
  useEffect(() => {
    const available = new Set(evidenceSelectionKey ? evidenceSelectionKey.split("\u0000") : []);
    setSelectedEvidence((current) => {
      const next = current.filter((id) => available.has(id));
      return next.length === current.length ? current : next;
    });
  }, [evidenceSelectionKey]);
  useEffect(() => { const previous = priorFocusId.current; priorFocusId.current = props.focusCaseId; if (previous !== null && props.focusCaseId === null) browseHeadingRef.current?.focus(); }, [props.focusCaseId]);
  useEffect(() => {
    props.onFocusedCaseTitle?.(focusedTitle);
    if (
      focusedTitle !== null
      || (props.focusCaseId !== null && investigation.availability === "unavailable")
    ) {
      detailHeadingRef.current?.focus();
    }
  }, [focusedTitle, investigation.availability, props.focusCaseId, props.onFocusedCaseTitle]);

  async function createInvestigation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = runtime.commands.createInvestigation;
    if (command === null || runtime.mutations.create.status === "running") return;
    const result = await command({ title, severity, problemStatement: situation.problemStatement, affectedParties: situation.affectedParties, impact: situation.impact, scope: situation.scope, openQuestions: listQuestions(situation.openQuestions), investigationContext: contextPayload(situation.investigationContext), ...(situation.occurredAt.trim() ? { occurredAt: situation.occurredAt.trim() } : {}) });
    if (result.status === "succeeded") { setTitle(""); setSeverity("medium"); setSituation(EMPTY_SITUATION); setAdvancedOpen(false); }
  }
  async function uploadEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = runtime.commands.uploadEvidence;
    if (command === null || runtime.mutations.uploadEvidence.status === "running") return;
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0] ?? null;
    const summary = (form.elements.namedItem("summary") as HTMLInputElement | null)?.value ?? "";
    const kind = ((form.elements.namedItem("kind") as HTMLSelectElement | null)?.value ?? "attachment") as "attachment" | "log" | "email" | "file_server_ref";
    const privacyClass = ((form.elements.namedItem("privacyClass") as HTMLSelectElement | null)?.value ?? "owner_only") as "owner_only" | "share_safe";
    const result = await command({ file, summary, kind, privacyClass });
    if (result.status === "succeeded") form.reset();
  }

  function renderCreateForm() {
    if (!runtime.capabilities.canCreate || runtime.commands.createInvestigation === null) return null;
    const creating = runtime.mutations.create.status === "running";
    return <section className="investigation-first__create" aria-labelledby="investigation-first-create-title" aria-busy={creating}>
      <div className="investigation-first__section-heading"><div><p className="investigation-first__eyebrow">Fast capture</p><h2 id="investigation-first-create-title">Create an investigation</h2><p>Start with what you know. Add technical context when it helps someone else find or understand this work.</p></div><span className="investigation-first__time">About 60–90 seconds</span></div>
      {runtime.mutations.create.status === "failed" ? <p className="investigation-first__error" role="alert">{failureCopy(runtime.mutations.create.error, "create")}</p> : null}
      <form onSubmit={(event) => void createInvestigation(event)}><div className="investigation-first__form-grid">
        <label className="investigation-first__field investigation-first__field--wide"><span>What should the team call this?</span><input ref={titleRef} className="login__input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Short investigation title" required /></label>
        <label className="investigation-first__field"><span>Severity</span><select className="login__input" value={severity} onChange={(event) => setSeverity(event.target.value as CaseV1["severity"])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label className="investigation-first__field investigation-first__field--wide"><span>What was observed?</span><textarea value={situation.problemStatement} onChange={(event) => setSituation((current) => ({ ...current, problemStatement: event.target.value }))} placeholder="Describe the problem without assuming its cause." rows={3} /></label>
        <label className="investigation-first__field"><span>Who or what is affected?</span><textarea value={situation.affectedParties} onChange={(event) => setSituation((current) => ({ ...current, affectedParties: event.target.value }))} placeholder="People, services, or customers" rows={2} /></label>
        <label className="investigation-first__field"><span>What is the impact?</span><textarea value={situation.impact} onChange={(event) => setSituation((current) => ({ ...current, impact: event.target.value }))} placeholder="The recorded operational impact" rows={2} /></label>
      </div><details className="investigation-first__advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>Advanced context <span>Product, build, timing, scope, and open questions</span></summary><div className="investigation-first__form-grid">
        {CONTEXT_FIELDS.map(([field, label]) => <ComboField key={field} field={field} label={label} value={situation.investigationContext[field]} options={contextOptions[field]} onChange={(value) => setSituation((current) => ({ ...current, investigationContext: { ...current.investigationContext, [field]: value } }))} />)}
        <label className="investigation-first__field"><span>When did it happen?</span><input className="login__input" value={situation.occurredAt} onChange={(event) => setSituation((current) => ({ ...current, occurredAt: event.target.value }))} placeholder="2026-08-29 or leave empty" /></label>
        <label className="investigation-first__field"><span>Scope</span><input className="login__input" value={situation.scope} onChange={(event) => setSituation((current) => ({ ...current, scope: event.target.value }))} placeholder="What is in or out of scope?" /></label>
        <label className="investigation-first__field investigation-first__field--wide"><span>Open questions <small>one per line</small></span><textarea value={situation.openQuestions} onChange={(event) => setSituation((current) => ({ ...current, openQuestions: event.target.value }))} placeholder="What still needs to be learned?" rows={3} /></label>
      </div></details><div className="investigation-first__form-actions"><button className="login__submit" type="submit" disabled={creating}>{creating ? "Creating…" : "Create investigation"}</button><span>Blank fields remain explicitly not recorded.</span></div></form>
    </section>;
  }

  function renderList() {
    const busy = investigations.availability === "loading" || (investigations.availability === "available" && investigations.refresh === "loading");
    const countLabel = investigations.availability === "available"
      ? `${filteredCases.length} shown · ${cases.length} total`
      : investigations.availability === "unavailable"
        ? "Count unavailable"
        : "Counting investigations…";
    return <section className="investigation-first__browse" aria-labelledby="investigation-first-browse-title" aria-busy={busy}>
      <div className="investigation-first__section-heading"><div><p className="investigation-first__eyebrow">Browse work</p><h2 id="investigation-first-browse-title" ref={browseHeadingRef} tabIndex={-1}>Investigations</h2><p>Open a record to see what is known, what is missing, and what can happen next.</p></div><span className="investigation-first__count" aria-live="polite">{countLabel}</span></div>
      <div className="investigation-first__filters"><label><span>Search</span><input className="login__input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, product, build, or problem" aria-label="Search investigations" /></label><label><span>Status</span><select className="login__input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter investigations by status"><option value="all">All statuses</option><option value="open">Open</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option><option value="archived">Archived</option></select></label></div>
      {investigations.availability === "idle" || investigations.availability === "loading" ? <p className="investigation-first__empty" role="status">Loading investigations…</p> : null}
      {investigations.availability === "unavailable" ? <div className="investigation-first__error" role="alert"><p>{failureCopy(investigations.error, "list")}</p><button type="button" onClick={runtime.refresh.investigations}>Retry loading investigations</button></div> : null}
      {investigations.availability === "available" && investigations.refresh === "failed" ? <div className="investigation-first__error" role="alert"><p>{failureCopy(investigations.refreshError, "list")}</p><button type="button" onClick={runtime.refresh.investigations}>Retry loading investigations</button></div> : null}
      {investigations.availability === "available" && filteredCases.length === 0 ? <p className="investigation-first__empty">{runtime.capabilities.canCreate ? "No investigations match this view. Try a different search or create a new one." : "No investigations match this view. Try a different search."}</p> : null}
      {investigations.availability === "available" ? <ul className="investigation-first__list">{filteredCases.map((row) => { const missing = [row.problemStatement, row.affectedParties, row.impact].filter((value) => !text(value)).length; return <li key={row.id} className="investigation-first__list-item"><button type="button" className="investigation-first__list-button" onClick={() => props.onOpenCase(row.id)}><span className="investigation-first__list-title">{row.title || "Untitled investigation"}</span><span className="investigation-first__list-meta"><span className={`status-pill status-pill--${row.status}`}>{row.status}</span><span>{row.severity}</span>{row.investigationContext?.productName ? <span>{row.investigationContext.productName}{row.investigationContext.build ? ` · ${row.investigationContext.build}` : ""}</span> : null}</span><span className="investigation-first__list-hint">{missing ? `${missing} key ${missing === 1 ? "field" : "fields"} not recorded` : "Core context recorded"}</span></button></li>; })}</ul> : null}
    </section>;
  }

  function renderEvidence() {
    const inventory = evidenceInventory.inventory;
    const annotations = evidenceInventory.annotations;
    const upload = runtime.mutations.uploadEvidence;
    const uploadCommand = runtime.commands.uploadEvidence;
    const busy = inventory.availability === "loading"
      || (inventory.availability === "available" && inventory.refresh === "loading")
      || annotations.availability === "loading"
      || (annotations.availability === "available" && annotations.refresh === "loading")
      || upload.status === "running";
    const evidenceCountLabel = inventory.availability === "available"
      ? `${inventory.value.length} ${inventory.value.length === 1 ? "item" : "items"}`
      : inventory.availability === "unavailable"
        ? "Count unavailable"
        : "Counting evidence…";
    const annotationsPending = annotations.availability === "idle"
      || annotations.availability === "loading";
    return <section className="investigation-first__card investigation-first__evidence" aria-labelledby="investigation-first-evidence-title" aria-busy={busy}>
      <div className="investigation-first__card-heading"><div><h3 id="investigation-first-evidence-title">Evidence inventory</h3><p>Files and references stay governed by the shared evidence and permission boundary.</p></div><span aria-live="polite">{evidenceCountLabel}</span></div>
      {inventory.availability === "idle" || inventory.availability === "loading" ? <p className="investigation-first__muted" role="status">Loading evidence inventory…</p> : null}
      {inventory.availability === "unavailable" ? <div className="investigation-first__error" role="alert"><p>{failureCopy(inventory.error, "evidence")}</p><button type="button" onClick={runtime.refresh.evidence}>Retry evidence inventory</button></div> : null}
      {inventory.availability === "available" && inventory.refresh === "failed" ? <div className="investigation-first__error" role="alert"><p>{failureCopy(inventory.refreshError, "evidence")}</p><button type="button" onClick={runtime.refresh.evidence}>Retry evidence inventory</button></div> : null}
      {annotationsPending ? <p className="investigation-first__muted" role="status">Loading evidence annotations…</p> : null}
      {annotations.availability === "unavailable" ? <div className="investigation-first__error" role="alert"><p>{failureCopy(annotations.error, "annotations")}</p><button type="button" onClick={runtime.refresh.contributions}>Retry evidence annotations</button></div> : null}
      {annotations.availability === "available" && annotations.refresh === "failed" ? <div className="investigation-first__error" role="alert"><p>{failureCopy(annotations.refreshError, "annotations")}</p><button type="button" onClick={runtime.refresh.contributions}>Retry evidence annotations</button></div> : null}
      {inventory.availability === "available" && inventory.value.length === 0 ? <p className="investigation-first__muted">No evidence has been registered yet.</p> : null}
      {inventory.availability === "available" && inventory.value.length > 0 ? <ul className="investigation-first__evidence-list">{inventory.value.map(({ evidence, annotation }) => { const annotationFallback = annotationsPending ? "Annotation loading…" : "Annotation not available"; return <li key={evidence.id}><label className="investigation-first__evidence-select"><input type="checkbox" checked={selectedEvidence.includes(evidence.id)} onChange={(event) => setSelectedEvidence((current) => event.target.checked ? [...new Set([...current, evidence.id])] : current.filter((id) => id !== evidence.id))} /><span><strong>{evidence.filename || evidence.uri || "Unnamed evidence"}</strong><small>{annotation?.body || annotationFallback}</small></span></label><details><summary>Metadata</summary><dl className="investigation-first__evidence-meta"><div><dt>Kind</dt><dd>{display(evidence.kind)}</dd></div><div><dt>Media type</dt><dd>{display(evidence.mediaType)}</dd></div><div><dt>Verification</dt><dd>{display(evidence.verificationStatus)}</dd></div><div><dt>Privacy</dt><dd>{display(evidence.privacyClass)}</dd></div><div><dt>Hash</dt><dd>{display(evidence.contentHash || evidence.expectedHash)}</dd></div><div><dt>Size</dt><dd>{evidence.byteLength == null ? "Not recorded" : `${evidence.byteLength.toLocaleString()} bytes`}</dd></div><div><dt>Source</dt><dd>{display(evidence.sourceId)}</dd></div><div><dt>Uploader</dt><dd>{display(evidence.uploaderId)}</dd></div><div><dt>Path</dt><dd>{display(evidence.relativePath)}</dd></div><div><dt>Intake batch</dt><dd>{display(evidence.intakeBatchId)}</dd></div><div><dt>Annotation author</dt><dd>{annotation ? display(annotation.authorUsername) : annotationFallback}</dd></div><div><dt>Annotated</dt><dd>{annotation ? dateLabel(annotation.createdAt) : annotationFallback}</dd></div></dl></details></li>; })}</ul> : null}
      <div className="investigation-first__bulk-actions"><span>{selectedEvidence.length} selected</span><button type="button" disabled aria-describedby="investigation-first-trash-description">Move selected to trash</button><button type="button" onClick={() => setSelectedEvidence([])} disabled={!selectedEvidence.length}>Clear selection</button><small id="investigation-first-trash-description">Bulk trash is reserved for a recoverable, audited lifecycle workflow; no file is deleted here.</small></div>
      {upload.status === "failed" ? <p className="investigation-first__error" role="alert">{failureCopy(upload.error, "upload")}</p> : null}
      {uploadCommand !== null ? <form className="investigation-first__upload" onSubmit={(event) => void uploadEvidence(event)}><h4>Add evidence</h4><div className="investigation-first__upload-grid"><label>File<input name="file" type="file" /></label><label>Kind<select name="kind" defaultValue="attachment"><option value="attachment">Attachment</option><option value="log">Log</option><option value="email">Email</option><option value="file_server_ref">File reference</option></select></label><label>Privacy<select name="privacyClass" defaultValue="owner_only"><option value="owner_only">Owner only</option><option value="share_safe">Share safe</option></select></label><label className="investigation-first__field--wide">Annotation<input name="summary" placeholder="What is this file and why does it matter?" /></label></div><button type="submit" disabled={upload.status === "running"}>{upload.status === "running" ? "Adding…" : "Add to evidence inventory"}</button></form> : null}
    </section>;
  }

  function renderDetail() {
    if (investigation.availability === "idle" || investigation.availability === "loading") return <section className="investigation-first__detail" aria-busy="true"><p className="investigation-first__empty" role="status">Opening investigation…</p></section>;
    if (investigation.availability === "unavailable") return <section className="investigation-first__detail" aria-labelledby="investigation-first-detail-unavailable-title"><h2 id="investigation-first-detail-unavailable-title" ref={detailHeadingRef} tabIndex={-1}>Investigation unavailable</h2><div className="investigation-first__error" role="alert"><p>{failureCopy(investigation.error, "detail")}</p><button type="button" onClick={runtime.refresh.investigation}>Retry opening investigation</button></div><button type="button" onClick={props.onExitFocus}>Back to investigations</button></section>;
    const selected = investigation.value;
    const missing = [selected.problemStatement, selected.affectedParties, selected.impact].filter((value) => !text(value)).length;
    return <section className="investigation-first__detail" aria-labelledby="investigation-first-detail-title" aria-busy={investigation.refresh === "loading"}>
      <button type="button" className="investigation-first__back" onClick={props.onExitFocus}>← Back to investigations</button>
      <header className="investigation-first__detail-header"><div><p className="investigation-first__eyebrow">Investigation</p><h2 id="investigation-first-detail-title" ref={detailHeadingRef} tabIndex={-1}>{selected.title || "Untitled investigation"}</h2><p className="investigation-first__detail-subtitle">{selected.id}</p></div><div className="investigation-first__detail-actions"><span className={`status-pill status-pill--${selected.status}`}>{selected.status}</span><span className="severity-pill">{selected.severity}</span>{props.onOpenAdvancedTools ? <button type="button" onClick={() => props.onOpenAdvancedTools?.(selected.id, "analyze")}>Open War Room technical tools</button> : null}</div></header>
      {investigation.refresh === "failed" ? <p className="investigation-first__error" role="alert">{failureCopy(investigation.refreshError, "detail")}</p> : null}
      <div className="investigation-first__next" role="status"><strong>{missing ? `${missing} key ${missing === 1 ? "detail" : "details"} still to record` : "Core context is recorded"}</strong><span>{missing ? "Add detail when it is known; this sparse record is still valid." : "Use the evidence inventory or technical tools to continue."}</span></div>
      <div className="investigation-first__detail-grid"><article className="investigation-first__card investigation-first__card--wide"><h3>What is known</h3><dl className="investigation-first__facts"><div><dt>Observed problem</dt><dd>{display(selected.problemStatement)}</dd></div><div><dt>Affected people or systems</dt><dd>{display(selected.affectedParties)}</dd></div><div><dt>Impact</dt><dd>{display(selected.impact)}</dd></div><div><dt>Scope</dt><dd>{display(selected.scope)}</dd></div><div><dt>When it happened</dt><dd>{occurrenceLabel(selected)}</dd></div><div><dt>Recorded</dt><dd>{dateLabel(selected.createdAt)}</dd></div></dl></article><article className="investigation-first__card"><h3>Technical context</h3><dl className="investigation-first__facts">{CONTEXT_FIELDS.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{display(selected.investigationContext?.[field])}</dd></div>)}</dl></article><article className="investigation-first__card"><h3>Open questions</h3>{selected.openQuestions.length ? <ul>{selected.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul> : <p className="investigation-first__muted">No questions recorded.</p>}</article></div>
      {renderEvidence()}<LifecycleControls investigation={selected} />
    </section>;
  }

  return <div className="investigation-first"><header className="investigation-first__hero"><div><p className="investigation-first__eyebrow">Investigation First</p><h1>Make the next useful action obvious.</h1><p>Capture a clear starting point quickly, then open a calm view of what is known, missing, and ready for deeper technical work.</p></div><div className="investigation-first__hero-note"><strong>One shared record</strong><span>Presentation changes here never change evidence, permissions, audit history, or triage integrity.</span></div></header>{props.focusCaseId ? renderDetail() : <>{renderCreateForm()}{renderList()}</>}</div>;
}
