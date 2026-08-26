import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ImportedRun } from "./ImportedRun.js";
import type { WorkFocus } from "./app-location.js";
import { CorpusIntakePanel } from "./CorpusIntakePanel.js";
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

function isCorpusFileContribution(row: ContributionView): boolean {
  return row.kind === "upload" && (row.body ?? "").startsWith("Corpus intake ");
}

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

export function TriageWorkspace(props: {
  caseId?: string;
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
    (row) =>
      !row.tombstoned
      && HUMAN_CONTRIBUTION_KINDS.has(row.kind)
      && !isCorpusFileContribution(row),
  ).length;
  const corpusIntakeEvents = props.events.filter((event) => event.kind === "corpus_intake_committed");
  const corpusFileCount = corpusIntakeEvents.reduce((total, event) => {
    const accepted = parsedTimelinePayload(event.payload)?.accepted;
    return total + (typeof accepted === "number" && Number.isFinite(accepted) ? accepted : 0);
  }, 0);
  const reviewLinks = props.contributions
    .filter(
      (row) =>
        !row.tombstoned
        && HUMAN_CONTRIBUTION_KINDS.has(row.kind)
        && !isCorpusFileContribution(row),
    )
    .map((row) => ({
      id: row.id,
      label: `${row.kind === "upload" ? "Evidence" : row.kind === "hypothesis" ? "Possible explanation" : row.kind === "action" ? "Next step" : row.kind === "message" ? "Observation" : "Note"}: ${(row.body ?? "Recorded item").slice(0, 100)}`,
    }));
  const exactTimelineRoute = props.routeFocus?.section === "triage-capture"
    && Boolean(props.routeFocus.item);
  const exactTimelineRouteSeen = useRef(exactTimelineRoute);
  // The source picker used to rely on the browser's own `required` handling,
  // which blocks submission, focuses the control, and says why in a tooltip
  // that disappears. With "Choose a label" still showing, the control looks
  // filled and the button looks broken. The requirement is stated here
  // instead, in the page, where it stays until it is met.
  const [importSourceMissing, setImportSourceMissing] = useState(false);
  const importSourceRef = useRef<HTMLSelectElement | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(
    props.events.length <= 5 || exactTimelineRoute,
  );
  useEffect(() => {
    if (exactTimelineRoute) {
      exactTimelineRouteSeen.current = true;
      setTimelineOpen(true);
      return;
    }
    // Timeline data arrives after the shell. Collapse a long ordinary history,
    // but never hide a record that this mounted workspace was asked to reveal.
    if (!exactTimelineRouteSeen.current) setTimelineOpen(props.events.length <= 5);
  }, [exactTimelineRoute, props.events.length]);
  useRouteFocus(props.routeFocus, true);

  return (
    <>
      <section className="triage-workspace" aria-labelledby="triage-workspace-heading">
        <header className="triage-workspace__header">
          <p className="case-memory__eyebrow">Current stage</p>
          <h3 id="triage-workspace-heading" className="triage-workspace__title">
            Capture evidence and observations
          </h3>
          <p className="triage-workspace__copy">
            Add what people observed, analysis brought in from another tool, and the files that
            support it. You can organize and compare it in the next stage.
          </p>
        </header>
      </section>
      <TriageStepSection
        id="triage-capture"
        step={1}
        title="Record what you know"
        lede="Start with a note, paste analysis gathered elsewhere, or add logs and files."
      >
        {props.canWrite ? (
          <div className="triage-capture__paths">
            <article className="triage-capture__card" aria-labelledby="triage-capture-note-title">
              <header className="triage-capture__card-head">
                <h4 id="triage-capture-note-title">Notes, observations, and next steps</h4>
                <span className="triage-chip triage-chip--human">written by you</span>
              </header>
              <p className="triage-capture__card-copy">
                Record what you saw, what might explain it, or what someone should try next.
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
                    <option value="message">Observation</option>
                    <option value="note">Note</option>
                    <option value="hypothesis">Possible explanation</option>
                    <option value="action">Next step</option>
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
                <h4 id="triage-capture-import-title">Paste analysis from another tool</h4>
                <span className="triage-chip triage-chip--imported">unverified until reviewed</span>
              </header>
              <p className="triage-capture__card-copy">
                Bring in a chat answer, diagnostic report, or other analysis. It stays clearly
                labeled until a person checks it against the evidence.
              </p>
              <p className="import-warn">
                Remove passwords, tokens, and other secrets before saving.
              </p>
              {props.importError ? (
                <p className="case-memory__error" role="alert">
                  {props.importError}
                </p>
              ) : null}
              <form
                className="composer"
                onSubmit={(event) => {
                  // Checked before the parent runs, so an unlabelled import
                  // never reaches the server and never looks like a no-op.
                  if (!importSourceRef.current?.value) {
                    event.preventDefault();
                    setImportSourceMissing(true);
                    importSourceRef.current?.focus();
                    return;
                  }
                  setImportSourceMissing(false);
                  props.onImportRun(event);
                }}
              >
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
                    ref={importSourceRef}
                    // Not `required`: native validation suppresses the submit
                    // event entirely, so the message below could never run.
                    aria-invalid={importSourceMissing || undefined}
                    aria-describedby={importSourceMissing ? "import-source-required" : undefined}
                    defaultValue=""
                    onChange={() => setImportSourceMissing(false)}
                    disabled={activeSources.length === 0}
                  >
                    <option value="" disabled>
                      Choose a label
                    </option>
                    {activeSources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </label>
                {importSourceMissing && activeSources.length > 0 ? (
                  <p className="case-memory__error" id="import-source-required" role="alert">
                    Choose where this analysis came from before importing it. An imported run is
                    only readable later if it says what produced it, so this one is not guessed.
                  </p>
                ) : null}
                {activeSources.length === 0 ? (
                  <p className="triage-capture__hint">
                    {props.sources.length === 0
                      ? "No attribution labels are available yet. A case lead can add one in Attribution."
                      : "All attribution labels are retired. A case lead can add an available label in Attribution; older imports keep their original attribution."}
                  </p>
                ) : null}
                <label className="import-warn triage-capture__redaction">
                  <input type="checkbox" name="redacted" /> I redacted secrets before save
                </label>
                <details className="triage-advanced">
                  <summary>Import details</summary>
                  <p className="triage-capture__hint">
                    Leave the person fields blank if you ran the analysis yourself. ContextDesk
                    will credit your signed-in account without displaying its directory identity.
                  </p>
                  <div className="triage-capture__operator">
                    <label className="triage-field">
                      Run by someone else (optional)
                      <input
                        className="login__input"
                        name="operatorUsername"
                        aria-label="Operator username"
                        placeholder="Name or username"
                      />
                    </label>
                    <label className="triage-field">
                      Recorded directory identity (optional)
                      <input
                        className="login__input"
                        name="operatorId"
                        aria-label="Operator identity"
                        placeholder="Only when required for historical attribution"
                      />
                    </label>
                  </div>
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
                    Leave these fields alone unless the source provides them. Unknown details stay
                    unknown rather than being guessed.
                  </p>
                </details>
                <button
                  className="login__submit"
                  type="submit"
                  // Truthful rather than hopeful: with no available label there
                  // is nothing this button could record the import against.
                  disabled={activeSources.length === 0}
                >
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
        {props.caseId ? (
          <CorpusIntakePanel
            caseId={props.caseId}
            canWrite={props.canWrite}
            readOnly={props.readOnly}
            {...(props.routeFocus ? { routeFocus: props.routeFocus } : {})}
          />
        ) : null}
        <section className="triage-record" aria-labelledby="triage-record-title">
          <header className="triage-record__head">
            <h4 id="triage-record-title">The case record so far</h4>
            <span className="case-memory__badge">
              {humanEntries} human {humanEntries === 1 ? "entry" : "entries"} · {props.runs.length}{" "}
              imported {props.runs.length === 1 ? "run" : "runs"}
              {corpusIntakeEvents.length > 0
                ? ` · ${corpusFileCount.toLocaleString()} files in ${corpusIntakeEvents.length} corpus ${corpusIntakeEvents.length === 1 ? "upload" : "uploads"}`
                : ""}
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
          <details
            className="triage-record__timeline"
            open={timelineOpen}
            onToggle={(event) => setTimelineOpen(event.currentTarget.open)}
          >
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
            <h5 className="triage-record__imports-title">Analysis imported from elsewhere</h5>
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
                  linkOptions={reviewLinks}
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
