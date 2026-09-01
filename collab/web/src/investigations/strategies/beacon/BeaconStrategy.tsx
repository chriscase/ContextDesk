import { useEffect, useMemo, useRef, useState, type FormEvent, type Ref } from "react";
import {
  MAX_EVIDENCE_UPLOAD_BYTES,
  selectResourceView,
  useInvestigationRuntime,
  type ArtifactKind,
  type CaseV1,
  type CommandOutcome,
  type ContributionV1,
  type PrivacyClass,
  type ResourceState,
} from "../../runtime/public.js";
import type { InvestigationStrategyShellProps } from "../contract.js";
import {
  StrategyActionRow,
  StrategyBadge,
  StrategyHero,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "../shared/index.js";

type RuntimeFailure = Extract<ResourceState<never>, { status: "failed" }>["error"];

function titleOf(investigation: CaseV1): string {
  return investigation.title.trim() || "Untitled investigation";
}

function failureCopy(error: RuntimeFailure, subject: string): string {
  if (error.kind === "auth_lost") return "Your access changed while this view was open. Sign in again to continue.";
  if (error.kind === "not_found") return `${subject} is no longer available in your current scope.`;
  if (error.kind === "conflict") return `${subject} changed before this action finished. Review the refreshed record before trying again.`;
  if (error.kind === "input") return `${subject} was rejected because one or more values were invalid.`;
  return `${subject} could not be completed right now.`;
}

function commandFailureCopy(outcome: Exclude<CommandOutcome<unknown>, { status: "succeeded" }>, subject: string): string {
  return outcome.status === "failed"
    ? failureCopy(outcome.error, subject)
    : `${subject} was not started because the record changed or another action was already running.`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function recorded(value: string | null | undefined): string {
  return value?.trim() || "Not recorded";
}

function contributionLabel(contribution: ContributionV1): string {
  if (contribution.kind === "hypothesis") return "Hypothesis";
  if (contribution.kind === "action") return "Next action";
  if (contribution.kind === "message") return "Team update";
  if (contribution.kind === "upload") return "Evidence added";
  return "Observation";
}

function PriorValueField(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (value: string) => void;
}) {
  const normalized = props.value.trim().toLocaleLowerCase();
  const existing = normalized !== "" && props.options.some((option) => option.toLocaleLowerCase() === normalized);
  const hintId = `${props.id}-hint`;
  return <div className="beacon__field"><label htmlFor={props.id}>{props.label}</label>
    <input
      id={props.id}
      value={props.value}
      list={`${props.id}-options`}
      aria-describedby={hintId}
      onChange={(event) => props.onChange(event.target.value)}
    />
    <datalist id={`${props.id}-options`}>{props.options.map((option) => <option key={option} value={option} />)}</datalist>
    <small id={hintId} aria-live="polite">{props.value.trim() ? existing ? "Existing recorded value selected." : "New value; it will be recorded exactly as entered." : "Choose a prior value or enter a new one."}</small>
  </div>;
}

function CreateCard({ startSignal }: { readonly startSignal?: number }) {
  const runtime = useInvestigationRuntime();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [observation, setObservation] = useState("");
  const [affected, setAffected] = useState("");
  const [impact, setImpact] = useState("");
  const [product, setProduct] = useState("");
  const [build, setBuild] = useState("");
  const investigations = selectResourceView(runtime.resources.investigations);
  const priorValues = useMemo(() => {
    const cases = investigations.availability === "available" ? investigations.value : [];
    const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.flatMap((value) => value?.trim() ? [value.trim()] : []))].sort((left, right) => left.localeCompare(right));
    return {
      products: unique(cases.map((item) => item.investigationContext?.productName)),
      builds: unique(cases.map((item) => item.investigationContext?.build)),
    };
  }, [investigations]);

  useEffect(() => { if (startSignal) titleRef.current?.focus(); }, [startSignal]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = runtime.commands.createInvestigation;
    if (!command || runtime.mutations.create.status === "running") return;
    const result = await command({
      title,
      problemStatement: observation,
      affectedParties: affected,
      impact,
      investigationContext: product.trim() || build.trim() ? {
        productName: product,
        version: "",
        build,
        component: "",
        environment: "",
        organization: "",
      } : null,
    });
    if (result.status === "succeeded") {
      setTitle(""); setObservation(""); setAffected(""); setImpact(""); setProduct(""); setBuild("");
    }
  }

  if (!runtime.capabilities.canCreate) return null;
  const running = runtime.mutations.create.status === "running";
  return (
    <StrategyPanel
      title="Start with the signal"
      titleId="beacon-create-title"
      description="Record the smallest useful starting point. Technical detail can follow without blocking creation."
      className="beacon__create"
      busy={running}
    >
      {runtime.mutations.create.status === "failed" ? (
        <StrategyStateNotice tone="danger" role="alert" title="Investigation not created">
          {failureCopy(runtime.mutations.create.error, "The investigation")}
        </StrategyStateNotice>
      ) : null}
      <form className="beacon__create-form" onSubmit={(event) => void submit(event)}>
        <label className="beacon__field beacon__field--wide"><span>Investigation title</span><input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} required placeholder="A short name the team will recognize" /></label>
        <label className="beacon__field beacon__field--wide"><span>What did you observe?</span><textarea value={observation} onChange={(event) => setObservation(event.target.value)} rows={3} placeholder="Record the signal without guessing at the cause" /></label>
        <label className="beacon__field"><span>Who or what is affected?</span><input value={affected} onChange={(event) => setAffected(event.target.value)} /></label>
        <label className="beacon__field"><span>Recorded impact</span><input value={impact} onChange={(event) => setImpact(event.target.value)} /></label>
        <details className="beacon__advanced beacon__field--wide"><summary>Optional technical context</summary><div className="beacon__advanced-grid"><PriorValueField id="beacon-product" label="Product" value={product} options={priorValues.products} onChange={setProduct} /><PriorValueField id="beacon-build" label="Build" value={build} options={priorValues.builds} onChange={setBuild} /></div></details>
        <div className="beacon__submit beacon__field--wide"><button type="submit" disabled={running || !runtime.commands.createInvestigation}>{running ? "Creating…" : runtime.commands.createInvestigation ? "Create and open" : "Preparing create…"}</button><span>Blank values remain explicitly not recorded.</span></div>
      </form>
    </StrategyPanel>
  );
}

function Browse({ onOpenCase, focusRef }: Pick<InvestigationStrategyShellProps, "onOpenCase"> & { readonly focusRef: Ref<HTMLInputElement> }) {
  const runtime = useInvestigationRuntime();
  const view = selectResourceView(runtime.resources.investigations);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => view.availability === "available"
    ? view.value.filter((item) => [item.title, item.problemStatement, item.impact, item.investigationContext?.productName, item.investigationContext?.build].filter(Boolean).join(" ").toLocaleLowerCase().includes(normalized))
    : [], [normalized, view]);

  if (!runtime.capabilities.canRead) return (
    <StrategyStateNotice title="Investigations unavailable">Your account cannot read investigations, so no investigation data was requested.</StrategyStateNotice>
  );
  return (
    <StrategyPanel title="Recent signals" titleId="beacon-browse-title" description="Open a record to append what happened next or attach supporting material." busy={view.availability === "loading" || (view.availability === "available" && view.refresh === "loading")}>
      <label className="beacon__search"><span>Find an investigation</span><input ref={focusRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, problem, product, or build" /></label>
      {view.availability === "idle" || view.availability === "loading" ? <StrategyStateNotice busy>Loading investigations…</StrategyStateNotice> : null}
      {view.availability === "unavailable" ? <StrategyStateNotice tone="danger" role="alert" title="Investigation list unavailable" action={<button type="button" onClick={runtime.refresh.investigations}>Retry</button>}>{failureCopy(view.error, "The investigation list")}</StrategyStateNotice> : null}
      {view.availability === "available" && view.refresh === "failed" ? <StrategyStateNotice tone="warning" role="alert" title="Refresh failed" action={<button type="button" onClick={runtime.refresh.investigations}>Retry</button>}>The previously loaded list is still shown.</StrategyStateNotice> : null}
      {view.availability === "available" && filtered.length === 0 ? <StrategyStateNotice>{normalized ? "No investigations match this search." : "No investigations have been recorded yet."}</StrategyStateNotice> : null}
      {view.availability === "available" && filtered.length > 0 ? <ul className="beacon__case-list">{filtered.map((item) => <li key={item.id}><button type="button" onClick={() => onOpenCase(item.id)}><span><strong>{titleOf(item)}</strong><small>{recorded(item.problemStatement)}</small></span><span className="beacon__case-state"><StrategyBadge tone={item.status === "resolved" ? "success" : item.status === "open" ? "accent" : "neutral"}>{item.status}</StrategyBadge><small>{dateLabel(item.createdAt)}</small></span></button></li>)}</ul> : null}
    </StrategyPanel>
  );
}

function EntryComposer({ investigation }: { readonly investigation: CaseV1 }) {
  const runtime = useInvestigationRuntime();
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"note" | "message" | "action">("note");
  const [feedback, setFeedback] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const busy = runtime.mutations.createContribution.status === "running";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = runtime.commands.createContribution;
    if (!command || !body.trim() || busy) return;
    setFeedback(null);
    const result = await command({ kind, body, clientTime: new Date().toISOString() });
    if (result.status === "succeeded") {
      setBody("");
      setFeedback({ tone: "success", text: "Dated entry recorded." });
    } else {
      setFeedback({ tone: "danger", text: commandFailureCopy(result, "The entry") });
    }
  }
  if (!runtime.capabilities.canContribute) return (
    <StrategyStateNotice title="Append is read-only">You can review recorded entries, but your current access cannot add one.</StrategyStateNotice>
  );
  return (
    <form className="beacon__entry-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <label className="beacon__field"><span>Entry type</span><select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="note">Observation</option><option value="message">Team update</option><option value="action">Next action</option></select></label>
      <label className="beacon__field beacon__field--wide"><span>What happened next?</span><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} required placeholder={`Append a dated entry to ${titleOf(investigation)}`} /></label>
      {feedback ? <StrategyStateNotice tone={feedback.tone} role={feedback.tone === "danger" ? "alert" : "status"}>{feedback.text}</StrategyStateNotice> : null}
      <button type="submit" disabled={busy || !body.trim() || !runtime.commands.createContribution}>{busy ? "Recording…" : runtime.commands.createContribution ? "Record entry" : "Preparing entry…"}</button>
    </form>
  );
}

function EvidenceCard() {
  const runtime = useInvestigationRuntime();
  const view = selectResourceView(runtime.resources.evidence);
  const [kind, setKind] = useState<ArtifactKind>("attachment");
  const [summary, setSummary] = useState("");
  const [privacyClass, setPrivacyClass] = useState<PrivacyClass>(runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe");
  const [feedback, setFeedback] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = runtime.mutations.uploadEvidence.status === "running";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = runtime.commands.uploadEvidence;
    const file = fileRef.current?.files?.[0] ?? null;
    if (!command || !file || busy) return;
    setFeedback(null);
    const result = await command({ file, kind, summary, privacyClass });
    if (result.status === "succeeded") {
      setSummary("");
      if (fileRef.current) fileRef.current.value = "";
      setFeedback({ tone: "success", text: `${file.name} was attached to the evidence inventory.` });
    } else {
      setFeedback({ tone: "danger", text: commandFailureCopy(result, "The upload") });
    }
  }
  return (
    <StrategyPanel title="Supporting material" titleId="beacon-evidence-title" description="Attach logs, emails, and files to the shared evidence inventory." busy={busy}>
      {view.availability === "idle" || view.availability === "loading" ? <StrategyStateNotice busy>Loading evidence…</StrategyStateNotice> : null}
      {view.availability === "unavailable" ? <StrategyStateNotice tone="danger" role="alert" title="Evidence unavailable" action={<button type="button" onClick={runtime.refresh.evidence}>Retry</button>}>{failureCopy(view.error, "Evidence")}</StrategyStateNotice> : null}
      {view.availability === "available" && view.refresh === "failed" ? <StrategyStateNotice tone="warning" role="alert" title="Evidence refresh failed" action={<button type="button" onClick={runtime.refresh.evidence}>Retry</button>}>The previously loaded inventory remains visible.</StrategyStateNotice> : null}
      {view.availability === "available" && view.value.length === 0 ? <StrategyStateNotice>No supporting material has been recorded yet.</StrategyStateNotice> : null}
      {view.availability === "available" && view.value.length > 0 ? <ul className="beacon__evidence-list">{view.value.map((item) => <li key={item.id}><span><strong>{item.filename || item.uri || "Unnamed evidence"}</strong><small>{item.kind} · {item.mediaType || "media type not recorded"} · {item.privacyClass === "owner_only" ? "owner only" : "share safe"}</small></span><StrategyBadge>{item.verificationStatus || "verification not recorded"}</StrategyBadge></li>)}</ul> : null}
      {runtime.capabilities.canUpload ? <form className="beacon__upload" onSubmit={(event) => void submit(event)}><label className="beacon__field"><span>File (up to {(MAX_EVIDENCE_UPLOAD_BYTES / 1_000_000).toFixed(0)} MB)</span><input ref={fileRef} type="file" required /></label><label className="beacon__field"><span>Kind</span><select value={kind} onChange={(event) => setKind(event.target.value as ArtifactKind)}><option value="attachment">Attachment</option><option value="log">Log</option><option value="email">Email</option></select></label><label className="beacon__field"><span>Privacy</span><select value={privacyClass} onChange={(event) => setPrivacyClass(event.target.value === "owner_only" && runtime.capabilities.canReadPrivate ? "owner_only" : "share_safe")}><option value="share_safe">Share safe</option>{runtime.capabilities.canReadPrivate ? <option value="owner_only">Owner only</option> : null}</select></label><label className="beacon__field beacon__field--wide"><span>Why does this matter?</span><input value={summary} onChange={(event) => setSummary(event.target.value)} required /></label>{feedback ? <StrategyStateNotice tone={feedback.tone} role={feedback.tone === "danger" ? "alert" : "status"}>{feedback.text}</StrategyStateNotice> : null}<button type="submit" disabled={busy || !runtime.commands.uploadEvidence}>{busy ? "Attaching…" : runtime.commands.uploadEvidence ? "Attach evidence" : "Preparing upload…"}</button></form> : <StrategyStateNotice title="Evidence upload is read-only">You can review supporting material, but your current access cannot attach a file.</StrategyStateNotice>}
    </StrategyPanel>
  );
}

function PromoteCard({ investigation, contributions }: { readonly investigation: CaseV1; readonly contributions: readonly ContributionV1[] }) {
  const runtime = useInvestigationRuntime();
  const [situation, setSituation] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [situationFeedback, setSituationFeedback] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [hypothesisFeedback, setHypothesisFeedback] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  async function promoteSituation() {
    const command = runtime.commands.updateSituation;
    if (!command || !situation.trim()) return;
    setSituationFeedback(null);
    const result = await command({ problemStatement: situation });
    if (result.status === "succeeded") {
      setSituation("");
      setSituationFeedback({ tone: "success", text: "Situation updated from the reviewed statement." });
    } else {
      setSituationFeedback({ tone: "danger", text: commandFailureCopy(result, "The Situation update") });
    }
  }
  async function promoteHypothesis() {
    const command = runtime.commands.createContribution;
    if (!command || !hypothesis.trim()) return;
    setHypothesisFeedback(null);
    const result = await command({
      kind: "hypothesis",
      body: hypothesis,
      ...(sourceId ? { hypothesisLinks: [{ kind: "contribution" as const, id: sourceId }] } : {}),
      clientTime: new Date().toISOString(),
    });
    if (result.status === "succeeded") {
      setHypothesis(""); setSourceId("");
      setHypothesisFeedback({ tone: "success", text: "Cited hypothesis recorded in the dated stream." });
    } else {
      setHypothesisFeedback({ tone: "danger", text: commandFailureCopy(result, "The hypothesis") });
    }
  }
  return (
    <StrategyPanel title="Promote a recorded entry" titleId="beacon-promote-title" description="Promotion is always a separate, explicit action. The original dated entry remains in the stream.">
      <div className="beacon__promote-grid">
        <section><h4>Update the Situation</h4><p>Replace the recorded problem statement after reviewing the current value: <strong>{recorded(investigation.problemStatement)}</strong></p>{runtime.capabilities.canEditSituation ? <><label className="beacon__field"><span>New problem statement</span><textarea value={situation} onChange={(event) => setSituation(event.target.value)} rows={3} /></label><button type="button" onClick={() => void promoteSituation()} disabled={!situation.trim() || runtime.mutations.updateSituation.status === "running" || !runtime.commands.updateSituation}>Promote to Situation</button>{situationFeedback ? <StrategyStateNotice tone={situationFeedback.tone} role={situationFeedback.tone === "danger" ? "alert" : "status"}>{situationFeedback.text}</StrategyStateNotice> : null}</> : <StrategyStateNotice title="Situation is read-only">Your current access can review this statement but cannot replace it.</StrategyStateNotice>}</section>
        <section><h4>Record a cited hypothesis</h4>{runtime.capabilities.canContribute ? <><label className="beacon__field"><span>Hypothesis</span><textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} rows={3} /></label><label className="beacon__field"><span>Source entry (optional)</span><select value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">No source selected</option>{contributions.filter((item) => !item.tombstoned).map((item) => <option key={item.id} value={item.id}>{contributionLabel(item)} · {dateLabel(item.createdAt)}</option>)}</select></label><button type="button" onClick={() => void promoteHypothesis()} disabled={!hypothesis.trim() || runtime.mutations.createContribution.status === "running" || !runtime.commands.createContribution}>Record hypothesis</button>{hypothesisFeedback ? <StrategyStateNotice tone={hypothesisFeedback.tone} role={hypothesisFeedback.tone === "danger" ? "alert" : "status"}>{hypothesisFeedback.text}</StrategyStateNotice> : null}</> : <StrategyStateNotice title="Hypothesis entry is read-only">Your current access can review hypotheses but cannot add one.</StrategyStateNotice>}</section>
      </div>
    </StrategyPanel>
  );
}

function Detail(props: InvestigationStrategyShellProps) {
  const runtime = useInvestigationRuntime();
  const investigation = selectResourceView(runtime.resources.investigation);
  const contributions = selectResourceView(runtime.resources.contributions);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedArrival = useRef<string | null>(null);
  const arrival = !runtime.capabilities.canRead ? `denied:${props.focusCaseId}`
    : investigation.availability === "available" ? `available:${props.focusCaseId}`
    : investigation.availability === "unavailable" ? `unavailable:${props.focusCaseId}` : null;
  const focusedTitle = investigation.availability === "available" ? titleOf(investigation.value) : null;
  useEffect(() => { props.onFocusedCaseTitle?.(focusedTitle); }, [focusedTitle, props.onFocusedCaseTitle]);
  useEffect(() => { if (arrival && focusedArrival.current !== arrival) { focusedArrival.current = arrival; headingRef.current?.focus(); } }, [arrival]);

  if (!runtime.capabilities.canRead) return <>
    <StrategyHero
      eyebrow="Beacon · Rapid Intake"
      title="Investigation unavailable in this view"
      titleId="beacon-detail-title"
      headingRef={headingRef}
      headingTabIndex={-1}
      actions={<button type="button" onClick={props.onExitFocus}>Back to investigations</button>}
    />
    <StrategyStateNotice>Your account cannot read investigations, so no record data was requested.</StrategyStateNotice>
  </>;
  if (investigation.availability === "idle" || investigation.availability === "loading") return <>
    <StrategyHero eyebrow="Beacon · Rapid Intake" title="Opening investigation" titleId="beacon-detail-title" />
    <StrategyStateNotice busy>Loading the authoritative investigation record…</StrategyStateNotice>
  </>;
  if (investigation.availability === "unavailable") return <>
    <StrategyHero
      eyebrow="Beacon · Rapid Intake"
      title="Investigation unavailable"
      titleId="beacon-detail-title"
      headingRef={headingRef}
      headingTabIndex={-1}
      actions={<StrategyActionRow><button type="button" onClick={runtime.refresh.investigation}>Retry</button><button type="button" onClick={props.onExitFocus}>Back</button></StrategyActionRow>}
    />
    <StrategyStateNotice tone="danger" role="alert">{failureCopy(investigation.error, "The investigation")}</StrategyStateNotice>
  </>;
  const selected = investigation.value;
  const entries = contributions.availability === "available" ? [...contributions.value].sort((left, right) => left.createdAt.localeCompare(right.createdAt)) : [];
  return (
    <>
      <StrategyHero eyebrow="Beacon · Rapid Intake" title={titleOf(selected)} titleId="beacon-detail-title" headingRef={headingRef} headingTabIndex={-1} description={<><span>{selected.id}</span> · <span>{selected.status}</span> · <span>{selected.severity}</span></>} actions={<StrategyActionRow><button type="button" onClick={props.onExitFocus}>Back to investigations</button>{props.onOpenAdvancedTools ? <button type="button" onClick={() => props.onOpenAdvancedTools?.(selected.id, "analyze")}>Open technical tools</button> : null}</StrategyActionRow>} />
      <div className="beacon__detail-grid">
        <div className="beacon__primary">
          <StrategyPanel title="Dated investigation stream" titleId="beacon-stream-title" description="Append observations, team updates, and next actions without rewriting earlier entries." busy={contributions.availability === "loading"}>
            <EntryComposer investigation={selected} />
            {contributions.availability === "idle" || contributions.availability === "loading" ? <StrategyStateNotice busy>Loading recorded entries…</StrategyStateNotice> : null}
            {contributions.availability === "unavailable" ? <StrategyStateNotice tone="danger" role="alert" title="Entries unavailable" action={<button type="button" onClick={runtime.refresh.contributions}>Retry</button>}>{failureCopy(contributions.error, "Recorded entries")}</StrategyStateNotice> : null}
            {contributions.availability === "available" && contributions.refresh === "failed" ? <StrategyStateNotice tone="warning" role="alert" title="Entry refresh failed" action={<button type="button" onClick={runtime.refresh.contributions}>Retry</button>}>The previously loaded dated stream remains visible.</StrategyStateNotice> : null}
            {contributions.availability === "available" && entries.length === 0 ? <StrategyStateNotice>No dated entries have been recorded yet.</StrategyStateNotice> : null}
            {entries.length > 0 ? <ol className="beacon__stream">{entries.map((entry) => <li key={entry.id}><div className="beacon__stream-marker" aria-hidden="true" /><article><header><StrategyBadge tone={entry.kind === "hypothesis" ? "warning" : entry.kind === "action" ? "accent" : "neutral"}>{contributionLabel(entry)}</StrategyBadge><time dateTime={entry.createdAt}>{dateLabel(entry.createdAt)}</time></header><p>{entry.tombstoned ? "This entry was removed from the active record." : recorded(entry.body)}</p><footer>Recorded by {entry.authorUsername || "unknown author"}{entry.hypothesisLinks?.length ? ` · ${entry.hypothesisLinks.length} cited source${entry.hypothesisLinks.length === 1 ? "" : "s"}` : ""}</footer></article></li>)}</ol> : null}
          </StrategyPanel>
          <EvidenceCard />
        </div>
        <aside className="beacon__side">
          <StrategyPanel title="Current Situation" titleId="beacon-situation-title"><dl className="beacon__facts"><div><dt>Observed problem</dt><dd>{recorded(selected.problemStatement)}</dd></div><div><dt>Affected</dt><dd>{recorded(selected.affectedParties)}</dd></div><div><dt>Impact</dt><dd>{recorded(selected.impact)}</dd></div><div><dt>Product / build</dt><dd>{[selected.investigationContext?.productName, selected.investigationContext?.build].filter(Boolean).join(" · ") || "Not recorded"}</dd></div></dl></StrategyPanel>
          <PromoteCard investigation={selected} contributions={entries} />
        </aside>
      </div>
    </>
  );
}

export function BeaconStrategy(props: InvestigationStrategyShellProps) {
  const browseFocusRef = useRef<HTMLInputElement>(null);
  const priorFocusId = useRef<string | null>(props.focusCaseId);
  useEffect(() => {
    const previous = priorFocusId.current;
    priorFocusId.current = props.focusCaseId;
    if (previous !== null && props.focusCaseId === null) browseFocusRef.current?.focus();
  }, [props.focusCaseId]);
  return (
    <StrategySurface className="beacon" labelledBy={props.focusCaseId ? "beacon-detail-title" : "beacon-page-title"}>
      {props.focusCaseId ? <Detail {...props} /> : <>
        <StrategyHero eyebrow="Beacon · Rapid Intake" title="Capture the signal. Keep the trail." titleId="beacon-page-title" description="A calm, append-first workspace for fast triage intake and clear handoff. Every promotion is explicit; the shared record remains authoritative." />
        <div className="beacon__browse-grid"><CreateCard {...(props.startSignal === undefined ? {} : { startSignal: props.startSignal })} /><Browse onOpenCase={props.onOpenCase} focusRef={browseFocusRef} /></div>
      </>}
    </StrategySurface>
  );
}
