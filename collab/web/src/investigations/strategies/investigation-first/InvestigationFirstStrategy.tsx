import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
const UPLOAD_KINDS = ["attachment", "log", "email"] as const;
const PRIVACY_CLASSES = ["owner_only", "share_safe"] as const;
const SHARE_SAFE_PRIVACY_CLASSES = ["share_safe"] as const;
type UploadKind = (typeof UPLOAD_KINDS)[number];
type UploadPrivacyClass = (typeof PRIVACY_CLASSES)[number];

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function display(value: unknown): string { return text(value) || "Not recorded"; }
function compactByteLabel(value: number | null | undefined): string | null {
  if (value == null) return null;
  if (value < 1_024) return `${value.toLocaleString()} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MB`;
}
function previewableTextArtifact(artifact: { kind: string; filename: string | null; mediaType: string | null }): boolean {
  if (artifact.kind === "file_server_ref") return false;
  const mediaType = text(artifact.mediaType).split(";", 1)[0]?.toLocaleLowerCase() ?? "";
  if (
    mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/ld+json"
    || mediaType === "application/xml"
    || mediaType === "application/javascript"
    || mediaType === "application/x-javascript"
    || mediaType === "application/yaml"
    || mediaType === "application/x-yaml"
    || mediaType === "application/x-ndjson"
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml")
  ) return true;
  return artifact.kind === "log" || artifact.kind === "email" || /\.(log|txt|text|md|json|xml|ya?ml|csv|tsv|eml|html?|css|js|mjs|cjs|ts|tsx|jsx|ini|conf|cfg|env|sh|bash|diff|patch|svg)$/iu.test(artifact.filename ?? "");
}
function listQuestions(value: string): string[] { return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean); }
function contextPayload(value: InvestigationContext): InvestigationContext | null {
  const normalized: InvestigationContext = {
    productName: text(value.productName),
    version: text(value.version),
    build: text(value.build),
    component: text(value.component),
    environment: text(value.environment),
    organization: text(value.organization),
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
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

function createFailureCopy(error: RuntimeFailure): string {
  if (error.kind === "input") {
    if (error.field === "title") return "Add a title before creating the investigation.";
    return "The investigation could not be created because required input is missing. Review the form and try again.";
  }
  if (error.kind === "auth_lost") return "Your access changed before the investigation could be created. Sign in again to continue.";
  if (error.kind === "validation") return "The submitted values were not accepted, so the investigation was not created. Review the entries and try again.";
  if (error.kind === "conflict") return "The create request conflicted with current server state. Check the investigation list before trying again.";
  if (error.kind === "not_found") return "The create request could not find the required server resource. Check the investigation list before trying again.";
  if (error.kind === "network") return "The connection failed before ContextDesk could confirm the result. Check the investigation list before trying again.";
  if (error.kind === "unavailable" && error.reason === "commit_outcome_unknown") return "The create result was not confirmed. Check the investigation list before continuing.";
  if (error.kind === "unavailable" || error.kind === "server_failure") return "The service could not complete the create request right now. Check the investigation list before trying again.";
  if (error.kind === "aborted") return "The create request was canceled before it finished. Check the investigation list before trying again.";
  if (error.kind === "unexpected_response" || error.kind === "protocol") return "The server response could not be verified. Check the investigation list before trying again.";
  return "ContextDesk could not confirm the create result safely. Check the investigation list before trying again.";
}

function failureCopy(error: RuntimeFailure, subject: "list" | "detail" | "evidence" | "annotations" | "create" | "upload" | "lifecycle"): string {
  if (subject === "create") return createFailureCopy(error);
  if (error.kind === "input") {
    if (error.field === "title") return "Add a title before creating the investigation.";
    if (error.field === "file" && error.reason === "too_large") return "The selected file exceeds the server-configured evidence limit.";
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
  if (error.kind === "unavailable" && error.reason === "commit_outcome_unknown") {
    return subject === "upload"
      ? "The upload result was not confirmed. The evidence inventory is being refreshed; check it before uploading again."
      : `${labels[subject]} result was not confirmed. Check the current record before continuing.`;
  }
  if (error.kind === "unavailable" || error.kind === "server_failure" || error.kind === "network") return `${labels[subject]} could not be loaded right now. Try again.`;
  return `${labels[subject]} could not be processed safely. Try again.`;
}

/** Whether the recorded-value catalog behind the combo fields can be trusted. */
type CatalogState = "available" | "empty" | "loading" | "unavailable";

function comboHint(catalog: CatalogState, value: string, options: readonly string[]): string {
  // A comparison against a catalog that was never read is not a fact. Say what
  // is actually known instead of calling an unchecked value new. Context
  // payloads and catalog options share the same outer-whitespace normalization,
  // so the comparison copy also names that behavior explicitly.
  if (catalog === "loading") return "Recorded values are still loading, so this cannot be compared yet. Outer whitespace will be removed when it is saved.";
  if (catalog === "unavailable") return "Recorded values are unavailable, so this cannot be compared. Outer whitespace will be removed when it is saved.";
  const submittedLiteral = text(value);
  if (catalog === "empty" || options.length === 0) {
    return submittedLiteral
      ? "No recorded values yet. This will be saved as a new value after removing outer whitespace."
      : "No recorded values yet; enter a new value. Outer whitespace will be removed when saved.";
  }
  if (!submittedLiteral) return "Choose a recorded value or enter a new one. Outer whitespace will be removed when saved.";
  return options.some((option) => option === submittedLiteral)
    ? "Matches a recorded value after removing outer whitespace; that value will be reused."
    : "No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.";
}

/**
 * A native `input[list]`, deliberately without an authored combobox role. The
 * datalist popup is not scriptable, so expanded state, option ownership, and
 * selection belong to the browser; declaring them here would promise assistive
 * technology semantics this markup cannot keep.
 */
function ComboField(props: { field: keyof InvestigationContext; label: string; value: string; options: readonly string[]; catalog: CatalogState; onChange: (value: string) => void }) {
  const listId = `investigation-first-${props.field}-options`;
  const hintId = `${listId}-hint`;
  return <label className="investigation-first__field"><span>{props.label}</span><input className="login__input" type="text" aria-label={props.label} aria-describedby={hintId} list={listId} value={props.value} onChange={(event) => props.onChange(event.target.value)} /><datalist id={listId}>{props.options.map((option) => <option key={option} value={option} />)}</datalist><small id={hintId} aria-live="polite">{comboHint(props.catalog, props.value, props.options)}</small></label>;
}

function LifecycleControls({ investigation }: { investigation: CaseV1 }) {
  const runtime = useInvestigationRuntime();
  const lifecycle = selectResourceView(runtime.resources.lifecycle);
  const [confirmation, setConfirmation] = useState<LifecycleAction | null>(null);
  const action: LifecycleAction = investigation.status === "archived" ? "restore" : "archive";
  const descriptionId = "investigation-first-lifecycle-description";
  // Reset before paint so a late passive mount effect cannot erase an
  // immediate confirmation click after the lifecycle control becomes visible.
  useLayoutEffect(() => setConfirmation(null), [action, investigation.id]);
  // Answer the authority question before the transport question. Without
  // lifecycle authority no lifecycle read can change the outcome, so loading
  // and retry would offer this viewer work that cannot help them.
  if (!runtime.capabilities.canManageLifecycle) {
    if (investigation.status !== "archived") return null;
    return <section className="investigation-first__card investigation-first__lifecycle" aria-labelledby="investigation-first-lifecycle-title"><h3 id="investigation-first-lifecycle-title">Archive and restore</h3><p className="investigation-first__muted" role="status">Archiving and restoring are unavailable in this view.</p></section>;
  }
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
    {command === null ? <p className="investigation-first__muted" role="status">Archiving and restoring are unavailable in this view.</p>
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
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<CaseV1["severity"]>("medium");
  const [situation, setSituation] = useState<SituationDraft>(EMPTY_SITUATION);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [privacyClass, setPrivacyClass] = useState<UploadPrivacyClass>(
    runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe",
  );
  const titleRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const browseHeadingRef = useRef<HTMLHeadingElement>(null);
  const priorFocusId = useRef<string | null>(props.focusCaseId);
  const focusedArrival = useRef<string | null>(null);
  const draftOwnerKey = `${runtime.identity.id}\u0000${runtime.identity.username}`;
  const priorDraftOwnerKey = useRef(draftOwnerKey);
  const cases = investigations.availability === "available" ? investigations.value : [];
  const focusedTitle = props.focusCaseId !== null
    && investigation.availability === "available"
    && investigation.value.id === props.focusCaseId
      ? investigation.value.title || "Untitled investigation"
      : null;
  /**
   * Identifies one arrival at the focused record: a different case, or the
   * first terminal state that case reaches. A refused read is terminal too —
   * the runtime requests nothing, so no later state can settle it. It
   * deliberately excludes the title and the refresh lane, so a rename or a
   * re-read of the open record is not a new arrival and never pulls focus
   * back to the heading.
   */
  const detailArrival = props.focusCaseId === null
    ? null
    : !runtime.capabilities.canRead
      ? `denied:${props.focusCaseId}`
      : investigation.availability === "unavailable"
        ? `unavailable:${props.focusCaseId}`
        : investigation.availability === "available" && investigation.value.id === props.focusCaseId
          ? `available:${props.focusCaseId}`
          : null;
  const catalog: CatalogState = investigations.availability === "available"
    ? cases.length > 0 ? "available" : "empty"
    : investigations.availability === "unavailable"
      ? "unavailable"
      : "loading";
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

  useEffect(() => {
    if (!props.startSignal) return;
    const titleInput = titleRef.current;
    titleInput?.focus();
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    titleInput?.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [props.startSignal]);
  useLayoutEffect(() => {
    if (priorDraftOwnerKey.current === draftOwnerKey) return;
    priorDraftOwnerKey.current = draftOwnerKey;
    setTitle("");
    setSeverity("medium");
    setSituation(EMPTY_SITUATION);
    setAdvancedOpen(false);
  }, [draftOwnerKey]);
  useLayoutEffect(() => {
    setPrivacyClass(runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe");
  }, [runtime.capabilities.canReadPrivate]);
  useEffect(() => setSelectedEvidence([]), [props.focusCaseId]);
  useEffect(() => setPreviewArtifactId(null), [props.focusCaseId]);
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
  }, [focusedTitle, props.onFocusedCaseTitle]);
  useEffect(() => {
    if (detailArrival === null) {
      focusedArrival.current = null;
      return;
    }
    if (focusedArrival.current === detailArrival) return;
    focusedArrival.current = detailArrival;
    detailHeadingRef.current?.focus();
  }, [detailArrival]);

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
    const requestedKind = (form.elements.namedItem("kind") as HTMLSelectElement | null)?.value ?? "attachment";
    const kind: UploadKind = requestedKind === "log" || requestedKind === "email" || requestedKind === "attachment"
      ? requestedKind
      : "attachment";
    const requestedPrivacy = (form.elements.namedItem("privacyClass") as HTMLSelectElement | null)?.value
      ?? privacyClass;
    const submittedPrivacy: UploadPrivacyClass = runtime.capabilities.canReadPrivate
      && requestedPrivacy === "owner_only"
      ? "owner_only"
      : "share_safe";
    const result = await command({ file, summary, kind, privacyClass: submittedPrivacy });
    if (result.status === "succeeded") {
      form.reset();
      setPrivacyClass(runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe");
    }
  }

  function togglePreview(artifactId: string) {
    if (previewArtifactId === artifactId) {
      setPreviewArtifactId(null);
      runtime.evidencePreview.clear();
      return;
    }
    setPreviewArtifactId(artifactId);
    void runtime.evidencePreview.preview({ artifactId });
  }

  function renderCreateForm() {
    if (!runtime.capabilities.canCreate || runtime.commands.createInvestigation === null) return null;
    const creating = runtime.mutations.create.status === "running";
    return <section className="investigation-first__create" aria-labelledby="investigation-first-create-title" aria-busy={creating}>
      <div className="investigation-first__section-heading"><div><p className="investigation-first__eyebrow">Fast capture</p><h2 id="investigation-first-create-title">Create an investigation</h2><p>Start with what you know. Add technical context when it helps someone else find or understand this work.</p></div><span className="investigation-first__time">About 60–90 seconds</span></div>
      {runtime.mutations.create.status === "failed" ? <p className="investigation-first__error investigation-first__create-error" role="alert">{failureCopy(runtime.mutations.create.error, "create")}</p> : null}
      <form onSubmit={(event) => void createInvestigation(event)}><div className="investigation-first__form-grid">
        <label className="investigation-first__field investigation-first__field--wide"><span>What should the team call this?</span><input ref={titleRef} className="login__input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Short investigation title" required /></label>
        <label className="investigation-first__field"><span>Severity</span><select className="login__input" value={severity} onChange={(event) => setSeverity(event.target.value as CaseV1["severity"])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label className="investigation-first__field investigation-first__field--wide"><span>What was observed?</span><textarea value={situation.problemStatement} onChange={(event) => setSituation((current) => ({ ...current, problemStatement: event.target.value }))} placeholder="Describe the problem without assuming its cause." rows={3} /></label>
        <label className="investigation-first__field"><span>Who or what is affected?</span><textarea value={situation.affectedParties} onChange={(event) => setSituation((current) => ({ ...current, affectedParties: event.target.value }))} placeholder="People, services, or customers" rows={2} /></label>
        <label className="investigation-first__field"><span>What is the impact?</span><textarea value={situation.impact} onChange={(event) => setSituation((current) => ({ ...current, impact: event.target.value }))} placeholder="The recorded operational impact" rows={2} /></label>
      </div><details key={draftOwnerKey} className="investigation-first__advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>Advanced context <span>Product, build, timing, scope, and open questions</span></summary>
      {catalog === "unavailable" ? <div className="investigation-first__muted investigation-first__create-status" role="status"><p>Recorded values could not be loaded, so nothing entered below can be compared with them. Creating an investigation still works.</p><button type="button" onClick={runtime.refresh.investigations}>Retry recorded values</button></div> : null}
      <div className="investigation-first__form-grid">
        {CONTEXT_FIELDS.map(([field, label]) => <ComboField key={field} field={field} label={label} value={situation.investigationContext[field]} options={contextOptions[field]} catalog={catalog} onChange={(value) => setSituation((current) => ({ ...current, investigationContext: { ...current.investigationContext, [field]: value } }))} />)}
        <label className="investigation-first__field"><span>When did it happen? <small>optional</small></span><input className="login__input" aria-describedby="investigation-first-occurred-at-hint" value={situation.occurredAt} onChange={(event) => setSituation((current) => ({ ...current, occurredAt: event.target.value }))} placeholder="2026-08-29 or 2026-08-29T14:30:00-05:00" /><small id="investigation-first-occurred-at-hint">Use YYYY-MM-DD for a known date, or an ISO 8601 date-time with an offset when the local time is known. The server validates this value when you create the investigation.</small></label>
        <label className="investigation-first__field"><span>Scope</span><input className="login__input" value={situation.scope} onChange={(event) => setSituation((current) => ({ ...current, scope: event.target.value }))} placeholder="What is in or out of scope?" /></label>
        <label className="investigation-first__field investigation-first__field--wide"><span>Open questions <small>one per line</small></span><textarea value={situation.openQuestions} onChange={(event) => setSituation((current) => ({ ...current, openQuestions: event.target.value }))} placeholder="What still needs to be learned?" rows={3} /></label>
      </div></details><div className="investigation-first__form-actions"><button className="login__submit" type="submit" disabled={creating}>{creating ? "Creating…" : "Create investigation"}</button><span>Blank fields remain explicitly not recorded.</span></div></form>
    </section>;
  }

  function renderList() {
    // Without read authority the runtime requests nothing and the collection
    // stays idle. Reporting that as loading would promise an arrival that the
    // shared permission boundary has already refused.
    const denied = !runtime.capabilities.canRead;
    const busy = !denied && (investigations.availability === "loading" || (investigations.availability === "available" && investigations.refresh === "loading"));
    const countLabel = investigations.availability === "available"
      ? `${filteredCases.length} shown · ${cases.length} total`
      : denied || investigations.availability === "unavailable"
        ? "Count unavailable"
        : "Counting investigations…";
    return <section className="investigation-first__browse" aria-labelledby="investigation-first-browse-title" aria-busy={busy}>
      <div className="investigation-first__section-heading"><div><p className="investigation-first__eyebrow">Browse work</p><h2 id="investigation-first-browse-title" ref={browseHeadingRef} tabIndex={-1}>Investigations</h2><p>Open a record to see what is known, what is missing, and what can happen next.</p></div><span className="investigation-first__count" aria-live="polite">{countLabel}</span></div>
      <div className="investigation-first__filters"><label><span>Search</span><input className="login__input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, product, build, or problem" aria-label="Search investigations" /></label><label><span>Status</span><select className="login__input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter investigations by status"><option value="all">All statuses</option><option value="open">Open</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option><option value="archived">Archived</option></select></label></div>
      {denied ? <p className="investigation-first__empty" role="status">Your current access does not include reading investigations, so this list is unavailable. No investigation data was requested.</p> : null}
      {!denied && (investigations.availability === "idle" || investigations.availability === "loading") ? <p className="investigation-first__empty" role="status">Loading investigations…</p> : null}
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
    const previewState = runtime.evidencePreview.state;
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
      {inventory.availability === "available" && inventory.value.length > 0 ? (
        <ul className="investigation-first__evidence-list">
          {inventory.value.map(({ evidence, annotation }) => {
            const annotationFallback = annotationsPending ? "Annotation loading…" : "Annotation not available";
            const size = compactByteLabel(evidence.byteLength);
            const evidenceName = evidence.filename || evidence.uri || "Unnamed evidence";
            const canReadArtifact = evidence.privacyClass !== "owner_only" || runtime.capabilities.canReadPrivate;
            const canPreview = canReadArtifact && previewableTextArtifact(evidence);
            return (
              <li key={evidence.id}>
                <label className="investigation-first__evidence-select">
                  <input
                    type="checkbox"
                    checked={selectedEvidence.includes(evidence.id)}
                    onChange={(event) => setSelectedEvidence((current) => event.target.checked
                      ? [...new Set([...current, evidence.id])]
                      : current.filter((id) => id !== evidence.id))}
                  />
                  <span className="investigation-first__evidence-copy">
                    <span className="investigation-first__evidence-title-row">
                      <strong>{evidenceName}</strong>
                      <span className="investigation-first__evidence-facts">
                        <span>{display(evidence.kind)}</span>
                        {evidence.mediaType ? <span>{evidence.mediaType}</span> : null}
                        {size ? <span>{size}</span> : null}
                        <span>{display(evidence.verificationStatus)}</span>
                      </span>
                    </span>
                    <small>{annotation?.body || annotationFallback}</small>
                  </span>
                </label>
                <details>
                  <summary>More details<span className="sr-only"> about {evidenceName}</span></summary>
                  <dl className="investigation-first__evidence-meta"><div className="investigation-first__evidence-annotation"><dt>Annotation</dt><dd>{annotation?.body || annotationFallback}</dd></div><div><dt>Kind</dt><dd>{display(evidence.kind)}</dd></div><div><dt>Media type</dt><dd>{display(evidence.mediaType)}</dd></div><div><dt>Verification</dt><dd>{display(evidence.verificationStatus)}</dd></div><div><dt>Privacy</dt><dd>{display(evidence.privacyClass)}</dd></div><div><dt>Content hash</dt><dd>{display(evidence.contentHash)}</dd></div><div><dt>Expected hash</dt><dd>{display(evidence.expectedHash)}</dd></div><div><dt>Size</dt><dd>{evidence.byteLength == null ? "Not recorded" : `${evidence.byteLength.toLocaleString()} bytes`}</dd></div><div><dt>Source</dt><dd>{display(evidence.sourceId)}</dd></div><div><dt>Uploader</dt><dd>{display(evidence.uploaderId)}</dd></div><div><dt>Path</dt><dd>{display(evidence.relativePath)}</dd></div><div><dt>Intake batch</dt><dd>{display(evidence.intakeBatchId)}</dd></div><div><dt>Annotation author</dt><dd>{annotation ? display(annotation.authorUsername) : annotationFallback}</dd></div><div><dt>Annotated</dt><dd>{annotation ? dateLabel(annotation.createdAt) : annotationFallback}</dd></div></dl>
                </details>
                <div className="investigation-first__evidence-preview-tools">
                  {canPreview ? <button type="button" aria-expanded={previewArtifactId === evidence.id} onClick={() => togglePreview(evidence.id)}>{previewArtifactId === evidence.id ? "Hide preview" : "Preview"}</button> : null}
                  {previewArtifactId === evidence.id && previewState.status === "running" ? <span role="status">Loading preview…</span> : null}
                  {!canPreview && canReadArtifact && evidence.kind === "file_server_ref" ? <span className="investigation-first__muted">Metadata only; bytes are not stored here.</span> : null}
                </div>
                {previewArtifactId === evidence.id && canPreview && previewState.status === "failed" ? <p className="investigation-first__error" role="alert">{failureCopy(previewState.error, "evidence")}</p> : null}
                {previewArtifactId === evidence.id && canPreview && previewState.status === "succeeded" && previewState.value.artifactId === evidence.id ? <div className="investigation-first__evidence-preview" role="region" aria-label={`Preview of ${evidenceName}`}><pre>{previewState.value.text}</pre>{previewState.value.truncated ? <small role="status">Showing the first 64 KiB. Use War Room technical tools for the complete file.</small> : null}</div> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="investigation-first__bulk-actions"><span>{selectedEvidence.length} selected</span><button type="button" disabled aria-describedby="investigation-first-trash-description">Move selected to trash</button><button type="button" onClick={() => setSelectedEvidence([])} disabled={!selectedEvidence.length}>Clear selection</button><small id="investigation-first-trash-description">Bulk trash is reserved for a recoverable, audited lifecycle workflow; no file is deleted here.</small></div>
      {upload.status === "failed" ? <p className="investigation-first__error" role="alert">{failureCopy(upload.error, "upload")}</p> : null}
      {uploadCommand !== null ? <form className="investigation-first__upload" onSubmit={(event) => void uploadEvidence(event)}><h4>Add evidence</h4><div className="investigation-first__upload-grid"><label>File<input name="file" type="file" /></label><label>Kind<select name="kind" defaultValue="attachment">{UPLOAD_KINDS.map((option) => <option key={option} value={option}>{option === "attachment" ? "Attachment" : option === "log" ? "Log" : "Email"}</option>)}</select></label><label>Privacy<select name="privacyClass" value={privacyClass} onChange={(event) => setPrivacyClass(event.target.value === "owner_only" && runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe")}>{(runtime.capabilities.canReadPrivate ? PRIVACY_CLASSES : SHARE_SAFE_PRIVACY_CLASSES).map((option) => <option key={option} value={option}>{option === "owner_only" ? "Owner only" : "Share safe"}</option>)}</select></label><label className="investigation-first__field--wide">Annotation<input name="summary" placeholder="What is this file and why does it matter?" /></label></div><button type="submit" disabled={upload.status === "running"}>{upload.status === "running" ? "Adding…" : "Add to evidence inventory"}</button></form> : null}
    </section>;
  }

  function renderDetail() {
    // Without read authority the runtime requests nothing for this record, so
    // its lane stays idle for good. Calling that opening would promise an
    // arrival the shared permission boundary already refused, and would strand
    // the reader in a permanently busy surface with no way back.
    if (!runtime.capabilities.canRead) return <section className="investigation-first__detail" aria-labelledby="investigation-first-detail-denied-title" aria-busy={false}><h2 id="investigation-first-detail-denied-title" ref={detailHeadingRef} tabIndex={-1}>Investigation unavailable in this view</h2><p className="investigation-first__empty" role="status">Your current access does not include reading investigations, so this investigation cannot be opened. No investigation data was requested.</p><button type="button" onClick={props.onExitFocus}>Back to investigations</button></section>;
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
