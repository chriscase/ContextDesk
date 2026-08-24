import type { FormEvent, ReactNode } from "react";
import { ImportedRun } from "./ImportedRun.js";
import type { WorkFocus } from "./app-location.js";
import { useRouteFocus } from "./route-focus.js";

export interface TimelineEvent {
  seq: number;
  kind: string;
  actorUsername: string;
  targetId?: string | null;
  clientTime?: string | null;
  serverTime: string;
  payload: string;
}

export interface ContributionView {
  id: string;
  kind: string;
  body: string | null;
  privacyClass: string;
  tombstoned: boolean;
  /** The wire payload records these; older fixtures and embeddings may omit them. */
  authorUsername?: string;
  createdAt?: string;
}

export interface RunRow {
  id: string;
  sourceId: string;
  outputText: string;
  corroborationState: string;
  evidenceVisibility: string;
  snapshotBinding: string | null;
  importerUsername: string;
  operatorUsername: string;
  promptText: string | null;
  promptCompleteness: string;
}

export interface SourceOption {
  id: string;
  name: string;
  kind: string;
  /** Catalog lifecycle ("active" | "retired"); older payloads may omit it. */
  lifecycle?: string;
}

const HUMAN_CONTRIBUTION_KINDS = new Set(["message", "note", "hypothesis", "action", "upload"]);

/**
 * Provenance chip for a timeline contribution. Human-authored only for kinds a
 * person writes directly; the server mirrors imported runs as `external_run`
 * contributions, which must never be labeled human. Unknown kinds get no chip
 * rather than a guessed one.
 */
function contributionChip(kind: string): { className: string; label: string } | null {
  if (kind === "external_run") {
    return { className: "triage-chip triage-chip--imported", label: "imported output" };
  }
  if (HUMAN_CONTRIBUTION_KINDS.has(kind)) {
    return { className: "triage-chip triage-chip--human", label: "human-authored" };
  }
  return null;
}

function parsedTimelinePayload(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function timelineTitle(event: TimelineEvent, contribution?: ContributionView): string {
  if (contribution?.tombstoned) return "A case entry was removed";
  if (contribution) {
    const labels: Record<string, string> = {
      note: "A human note was recorded",
      hypothesis: "A working hypothesis was recorded",
      action: "A next action was recorded",
      message: "A human observation was recorded",
      upload: "An evidence upload was recorded",
      external_run: "External analysis was imported",
    };
    return labels[contribution.kind] ?? "The case record was updated";
  }
  const kind = event.kind.toLowerCase();
  if (kind.includes("case_created")) return "The investigation was opened";
  if (kind.includes("status")) return "The investigation status changed";
  if (kind.includes("snapshot")) return "Evidence was frozen for repeatable analysis";
  if (kind.includes("experiment") || kind.includes("run")) return "An analysis run was recorded";
  if (kind.includes("decision")) return "A human decision was recorded";
  if (kind.includes("discussion") || kind.includes("comment")) return "A collaborator added context";
  return "Case activity was recorded";
}

function timelineMeaning(event: TimelineEvent, contribution?: ContributionView): string {
  if (contribution?.tombstoned) return "The audit history is preserved, but this entry is no longer part of the current working record.";
  if (contribution?.kind === "hypothesis") return "This is a possibility to test, not an established cause.";
  if (contribution?.kind === "action") return "This records work someone can perform and report back on.";
  if (contribution?.kind === "external_run") return "Imported output remains unverified until a person corroborates or contradicts it.";
  if (contribution) return "This adds human-attributed context to the shared investigation record.";
  const kind = event.kind.toLowerCase();
  if (kind.includes("snapshot")) return "Later model comparisons can be checked against the same bounded evidence state.";
  if (kind.includes("decision")) return "This captures human judgment without presenting model agreement as proof.";
  if (kind.includes("status")) return "This changes how collaborators understand the investigation’s current phase.";
  return "This event is retained for provenance; no more specific human-readable meaning was captured.";
}

function timelineTime(event: TimelineEvent): string {
  const value = event.serverTime || event.clientTime;
  if (!value) return "time not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "time not recorded" : parsed.toLocaleString();
}

function payloadSummary(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  for (const key of ["summary", "title", "status", "message", "reason"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * A step banner + focusable anchor target. Steps 2–4 wrap the existing
 * protected panels from Cases.tsx; step 1 is rendered by TriageWorkspace.
 */
export function TriageStepSection(props: {
  id: string;
  step: number;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <section
      id={props.id}
      className="triage-step"
      aria-labelledby={`${props.id}-title`}
      tabIndex={-1}
    >
      <header className="triage-step__banner">
        <span className="triage-step__num" aria-hidden="true">
          {props.step}
        </span>
        <div>
          <h3 id={`${props.id}-title`} className="triage-step__title">
            {props.title}
          </h3>
          <p className="triage-step__lede">{props.lede}</p>
        </div>
      </header>
      {props.children}
    </section>
  );
}

/** A focusable, labeled anchor around one existing panel. */
export function TriageAnchor(props: { id: string; label: string; children: ReactNode }) {
  return (
    <section id={props.id} className="triage-anchor" aria-label={props.label} tabIndex={-1}>
      {props.children}
    </section>
  );
}

const RAIL_STEPS = [
  { anchor: "triage-capture", name: "Capture", hint: "notes & imported output" },
  { anchor: "triage-analyze", name: "Analyze", hint: "evidence board & AI lanes" },
  { anchor: "triage-compare", name: "Compare", hint: "lanes side by side" },
  { anchor: "triage-decide", name: "Decide", hint: "status & share-safe export" },
] as const;

export function TriageWorkspace(props: {
  canWrite: boolean;
  readOnly: boolean;
  sources: SourceOption[];
  events: TimelineEvent[];
  contributions: ContributionView[];
  runs: RunRow[];
  importError: string | null;
  routeFocus?: WorkFocus;
  onAddNote: (event: FormEvent<HTMLFormElement>) => void;
  onImportRun: (event: FormEvent<HTMLFormElement>) => void;
  onCorroborate: (id: string, state: "corroborated" | "contradicted", linkId: string) => void;
}) {
  // Only an explicitly retired source is excluded from new intake; a source with
  // no recorded lifecycle stays selectable rather than being guessed retired. The
  // full catalog (props.sources) still resolves historical run attribution below,
  // so retired sources keep their recorded name and kind on existing imports.
  const activeSources = props.sources.filter((source) => source.lifecycle !== "retired");
  const humanEntries = props.contributions.filter(
    (row) => !row.tombstoned && HUMAN_CONTRIBUTION_KINDS.has(row.kind),
  ).length;
  const captureCount = humanEntries + props.runs.length;
  const nothingCaptured = captureCount === 0;
  useRouteFocus(props.routeFocus, true);

  return (
    <>
      <section className="triage-workspace" aria-labelledby="triage-workspace-heading">
        <header className="triage-workspace__header">
          <p className="case-memory__eyebrow">Guided triage</p>
          <h3 id="triage-workspace-heading" className="triage-workspace__title">
            Triage workspace
          </h3>
          <p className="triage-workspace__copy">
            Work the case in four steps: capture what you know, let analysis organize it, compare
            strategies side by side, and record a human decision. AI assists at every step —
            people stay the authors and the judges.
          </p>
        </header>
        <div className="triage-workspace__paths">
          <a className="triage-workspace__path" href="#triage-capture">
            <span className="triage-workspace__path-head">
              <strong>Capture findings yourself</strong>
              <span className="triage-chip triage-chip--human">human-authored</span>
            </span>
            <span className="triage-workspace__path-body">
              Write notes and hypotheses, or paste results you gathered anywhere else — terminals,
              dashboards, another AI chat. Every entry is labeled with who or what produced it.
            </span>
            <span className="triage-workspace__path-cta" aria-hidden="true">
              Go to capture ↓
            </span>
          </a>
          <a className="triage-workspace__path" href="#triage-analyze">
            <span className="triage-workspace__path-head">
              <strong>Analyze with ContextDesk</strong>
              <span className="triage-chip triage-chip--model">model lanes</span>
            </span>
            <span className="triage-workspace__path-body">
              Freeze an evidence snapshot, then run model lanes against exactly that snapshot.
              Lanes organize and compare recorded evidence; they never rewrite your material or
              declare a winner.
            </span>
            <span className="triage-workspace__path-cta" aria-hidden="true">
              Go to analysis ↓
            </span>
          </a>
        </div>
        <nav className="triage-rail" aria-label="Triage steps">
          <ol className="triage-rail__list">
            {RAIL_STEPS.map((step, index) => (
              <li key={step.anchor}>
                <a className="triage-rail__link" href={`#${step.anchor}`}>
                  <span className="triage-rail__num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="triage-rail__name">{step.name}</span>
                  <span className="triage-rail__hint">
                    {index === 0
                      ? `${captureCount} recorded ${captureCount === 1 ? "item" : "items"}`
                      : step.hint}
                  </span>
                  {index === 0 && nothingCaptured && props.canWrite ? (
                    <span className="triage-rail__badge">start here</span>
                  ) : null}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </section>
      <TriageStepSection
        id="triage-capture"
        step={1}
        title="Capture"
        lede="Record investigation material from anywhere. Both paths below are first-class, and both land on the case record with clear provenance."
      >
        {props.canWrite ? (
          <div className="triage-capture__paths">
            <article className="triage-capture__card" aria-labelledby="triage-capture-note-title">
              <header className="triage-capture__card-head">
                <h4 id="triage-capture-note-title">Your own findings</h4>
                <span className="triage-chip triage-chip--human">human-authored</span>
              </header>
              <p className="triage-capture__card-copy">
                A note, hypothesis, or action item — attributed to you on the case timeline. Messy
                is fine; provenance is what matters.
              </p>
              <form className="composer" onSubmit={props.onAddNote}>
                <label className="triage-field">
                  Entry kind
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
                </label>
                <textarea
                  className="login__input"
                  name="body"
                  aria-label="Timeline entry body"
                  required
                  rows={4}
                  placeholder="What did you observe, suspect, or decide to try?"
                />
                <details className="triage-advanced">
                  <summary>Sharing options</summary>
                  <label className="triage-field">
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
                  <p className="triage-capture__hint">
                    Entries stay private to the case unless you mark them share-safe.
                  </p>
                </details>
                <button className="login__submit" type="submit">
                  Add to timeline
                </button>
              </form>
            </article>
            <article className="triage-capture__card" aria-labelledby="triage-capture-import-title">
              <header className="triage-capture__card-head">
                <h4 id="triage-capture-import-title">Pasted external output</h4>
                <span className="triage-chip triage-chip--imported">imported · unverified</span>
              </header>
              <p className="triage-capture__card-copy">
                Paste output produced anywhere else — another AI, a diagnostic tool, an external
                service, a report someone curated, or material gathered by hand. It stays
                unverified until a person corroborates it against case evidence.
              </p>
              <p className="import-warn">
                Pasted prompts and outputs can contain secrets — mask them before saving. Evidence
                visibility is whatever the importer describes, or unknown; a package snapshot
                identity, when recorded, is a content-addressed reference — not a signature or a
                verification.
              </p>
              {props.importError ? (
                <p className="case-memory__error" role="alert">
                  {props.importError}
                </p>
              ) : null}
              <form className="composer" onSubmit={props.onImportRun}>
                <textarea
                  className="login__input"
                  name="outputText"
                  aria-label="External run output"
                  required
                  rows={4}
                  placeholder="Paste the output here"
                />
                <textarea
                  className="login__input"
                  name="promptText"
                  aria-label="External run prompt (optional)"
                  rows={2}
                  placeholder="Paste the prompt too (optional)"
                />
                <label className="triage-field">
                  Where it came from
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
                    {activeSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name} ({source.kind})
                      </option>
                    ))}
                  </select>
                </label>
                {activeSources.length === 0 ? (
                  <p className="triage-capture__hint">
                    {props.sources.length === 0
                      ? "No sources are registered yet. A case lead can add one in the source " +
                        "catalog further down the page."
                      : "All registered sources are retired, so none can be selected for new " +
                        "intake. A case lead can register an active source in the source catalog " +
                        "further down the page; imports already on the record keep their retired " +
                        "source’s name and kind."}
                  </p>
                ) : null}
                <div className="triage-capture__operator">
                  <label className="triage-field">
                    Operator username
                    <input
                      className="login__input"
                      name="operatorUsername"
                      aria-label="Operator username"
                      required
                    />
                  </label>
                  <label className="triage-field">
                    Operator identity
                    <input
                      className="login__input"
                      name="operatorId"
                      aria-label="Operator identity"
                      required
                    />
                  </label>
                </div>
                <label className="import-warn triage-capture__redaction">
                  <input type="checkbox" name="redacted" /> I redacted secrets before save
                </label>
                <details className="triage-advanced">
                  <summary>Provenance details (visibility, snapshot)</summary>
                  <label className="triage-field">
                    Evidence visibility
                    <select
                      className="login__input"
                      name="evidenceVisibility"
                      aria-label="External run evidence visibility"
                      defaultValue="unknown"
                    >
                      <option value="unknown">visibility unknown</option>
                      <option value="importer_described">importer-described</option>
                    </select>
                  </label>
                  <label className="triage-field">
                    Visibility note
                    <input
                      className="login__input"
                      name="visibilityNote"
                      aria-label="External run visibility note"
                      placeholder="Visibility note"
                    />
                  </label>
                  <label className="triage-field">
                    Package snapshot identity
                    <input
                      className="login__input"
                      name="snapshotBinding"
                      aria-label="Package snapshot identity"
                      placeholder="Package snapshot identity"
                    />
                  </label>
                  <p className="triage-capture__hint">
                    Leave these alone unless you know them; unknown visibility stays unknown rather
                    than being guessed.
                  </p>
                </details>
                <button className="login__submit" type="submit">
                  Import external run
                </button>
              </form>
              <p className="triage-capture__hint">
                Looking for ContextDesk&rsquo;s own model lanes instead?{" "}
                <a href="#triage-lane-runner">Open the AI lane runner</a>.
              </p>
            </article>
          </div>
        ) : props.readOnly ? (
          <p className="triage-capture__notice" role="status">
            Static read-only view: the record below is browsable, but capture, corroboration, and
            edits are unavailable.
          </p>
        ) : (
          <p className="triage-capture__notice" role="status">
            Your current role can review the case record but not add to it. Ask a case lead for
            contributor access.
          </p>
        )}
        <section className="triage-record" aria-labelledby="triage-record-title">
          <header className="triage-record__head">
            <h4 id="triage-record-title">The case record so far</h4>
            <span className="case-memory__badge">
              {humanEntries} human {humanEntries === 1 ? "entry" : "entries"} · {props.runs.length}{" "}
              imported {props.runs.length === 1 ? "run" : "runs"}
            </span>
          </header>
          <ul className="triage-legend" aria-label="Provenance classes">
            <li>
              <span className="triage-chip triage-chip--human">human-authored</span>
              <span>Notes, hypotheses, actions, and uploads written by named people.</span>
            </li>
            <li>
              <span className="triage-chip triage-chip--imported">imported · unverified</span>
              <span>
                Output pasted from an AI, a tool, a service, a report, or material gathered
                elsewhere; unverified until a person corroborates it.
              </span>
            </li>
            <li>
              <span className="triage-chip triage-chip--model">ContextDesk model run</span>
              <span>
                Launched in the <a href="#triage-lane-runner">AI lane runner</a> against a frozen
                snapshot; lanes never overwrite human entries.
              </span>
            </li>
          </ul>
          <details className="triage-record__timeline" open>
            <summary>
              Case timeline · {props.events.length} {props.events.length === 1 ? "event" : "events"}
            </summary>
            {props.events.length === 0 ? (
              <p className="case-memory__empty">Nothing has been recorded on this case yet.</p>
            ) : (
              <div
                className="triage-record__scroll"
                role="region"
                aria-label="Case timeline events"
                tabIndex={0}
              >
                <ol className="timeline">
                  {props.events.map((event) => {
                    const contribution = event.targetId
                      ? props.contributions.find((item) => item.id === event.targetId)
                      : undefined;
                    const chip = contribution ? contributionChip(contribution.kind) : null;
                    const payload = parsedTimelinePayload(event.payload);
                    const summary = payloadSummary(payload);
                    return (
                      <li
                        key={event.seq}
                        className="timeline__item"
                        data-route-item={contribution?.id ?? String(event.seq)}
                        data-route-kind={contribution ? "contribution" : "timeline"}
                        tabIndex={-1}
                      >
                        <h5 className="triage-record__event-title">{timelineTitle(event, contribution)}</h5>
                        <p className="timeline__meta">by {event.actorUsername} · {timelineTime(event)}</p>
                        {contribution?.body && !contribution.tombstoned ? (
                          <div className="triage-record__contribution">
                            <span className="timeline__meta">
                              {chip ? (
                                <>
                                  <span className={chip.className}>{chip.label}</span>{" "}
                                </>
                              ) : null}
                              Current {contribution.kind} · {contribution.privacyClass}
                            </span>
                            <div>{contribution.body}</div>
                          </div>
                        ) : summary ? <p>{summary}</p> : null}
                        <p className="triage-record__meaning">
                          <strong>Why it matters:</strong> {timelineMeaning(event, contribution)}
                        </p>
                        <details className="triage-record__audit">
                          <summary>Raw audit details</summary>
                          <dl>
                            <dt>Sequence</dt><dd>{event.seq}</dd>
                            <dt>Event kind</dt><dd>{event.kind}</dd>
                            <dt>Actor</dt><dd>{event.actorUsername}</dd>
                            <dt>Target</dt><dd>{event.targetId ?? "none"}</dd>
                            <dt>Client time</dt><dd>{event.clientTime ?? "not recorded"}</dd>
                            <dt>Server time</dt><dd>{event.serverTime}</dd>
                            <dt>Payload</dt><dd><code>{event.payload}</code></dd>
                          </dl>
                        </details>
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </details>
          <div className="triage-record__imports">
            <h5 className="triage-record__imports-title">Imported external output</h5>
            {props.runs.length === 0 ? (
              <p className="case-memory__empty">No external output has been imported yet.</p>
            ) : (
              props.runs.map((run) => (
                <ImportedRun
                  key={run.id}
                  run={run}
                  // Attribution searches the full catalog, retired sources included:
                  // a run recorded against a since-retired source keeps its name/kind.
                  source={props.sources.find((source) => source.id === run.sourceId) ?? null}
                  canCorroborate={props.canWrite}
                  onCorroborate={props.onCorroborate}
                />
              ))
            )}
          </div>
        </section>
      </TriageStepSection>
    </>
  );
}
