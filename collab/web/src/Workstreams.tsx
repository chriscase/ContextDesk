import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { WorkFocus } from "./app-location.js";
import { ArtifactExcerpt } from "./evidence-excerpt.js";
import { protectedApiFetch } from "./protected-api.js";
import { useRouteFocus } from "./route-focus.js";

/**
 * Workstreams — the investigative work of an investigation, one addressable
 * unit at a time.
 *
 * A workstream is a unit of investigative work, not a model button: it has a
 * purpose, an owner, an exact frozen input, a history, findings, cited
 * evidence, and things it left unknown. The server projects these from the
 * recorded run records (see `cd-collab.workstream_view.v1`); this surface only
 * presents them. Raw identifiers stay behind Technical details, and nothing
 * here ranks a workstream, scores it, or presents analysis as a human finding.
 */

/** Mirrors `cd-collab.workstream_view.v1` — the server is authoritative. */
interface WorkstreamEvidenceCitation {
  evidenceId: string;
  label: string;
  kind: string;
  summary: string | null;
  inFrozenSnapshot: boolean;
  verification: string;
  resolved: boolean;
}

interface WorkstreamActivityEntry {
  at: string | null;
  label: string;
  actor: string;
  detail: string | null;
}

interface WorkstreamTechnical {
  workstreamKey: string;
  runId: string;
  candidateId: string;
  snapshotId: string;
  snapshotFingerprint: string;
  requestFingerprint: string;
  taskFingerprint: string;
  strategyId: string;
  modelId: string;
  modelVersion: string | null;
  provider: string;
  profileId: string | null;
  outputHash: string | null;
  benchmarkRunId: string | null;
  parentRunId: string | null;
  errorCode: string | null;
  privacyClass: string;
}

interface WorkstreamView {
  key: string;
  caseId: string;
  label: string;
  purpose: string;
  operatorKind: string;
  operatorLabel: string;
  assignedTo: string;
  strategyLabel: string;
  role: string;
  inputs: {
    question: string;
    snapshotLabel: string;
    snapshotEvidenceCount: number;
    snapshotFrozenAt: string | null;
    sameSnapshot: boolean | null;
    snapshotProofLabel: string;
  };
  statusCode: string;
  lifecycle: string;
  statusLabel: string;
  statusDetail: string;
  startedAt: string | null;
  finishedAt: string | null;
  findings: string | null;
  outcome: string;
  evidenceCited: WorkstreamEvidenceCitation[];
  unknowns: string[];
  activity: WorkstreamActivityEntry[];
  rerun: { isRerun: boolean; parentKey: string | null; note: string };
  agreementNotice: string;
  technical: WorkstreamTechnical;
}

export const WORKSTREAMS_SECTION = "workstreams";

/** Excerpts are read on demand, and only for the workstream actually opened. */
type ExcerptState =
  | { kind: "loading" }
  | { kind: "text"; text: string }
  | { kind: "binary" }
  | { kind: "unavailable" };

function timeLabel(value: string | null): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "not recorded";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function runGroupKey(view: WorkstreamView): string {
  return view.technical.runId;
}

function decodeEvidence(contentBase64: string): ExcerptState {
  try {
    const bytes = Uint8Array.from(atob(contentBase64), (character) => character.charCodeAt(0));
    // A NUL byte early in the stream means this is not text a reader can use;
    // show the recorded metadata rather than rendering binary noise.
    if (bytes.subarray(0, 1024).includes(0)) return { kind: "binary" };
    return { kind: "text", text: new TextDecoder().decode(bytes) };
  } catch {
    return { kind: "unavailable" };
  }
}

export function Workstreams(props: {
  caseId: string;
  routeFocus?: WorkFocus;
  onDeepNavigate?: (focus: WorkFocus) => void;
}) {
  const [workstreams, setWorkstreams] = useState<WorkstreamView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [excerpts, setExcerpts] = useState<Record<string, ExcerptState>>({});
  const requestToken = useRef(0);
  /** Evidence ids already requested, so a re-render never re-reads bytes. */
  const requestedExcerpts = useRef(new Set<string>());
  const loaded = workstreams !== null;
  const focusedKey = props.routeFocus?.section === WORKSTREAMS_SECTION
    ? props.routeFocus.lane
      ?? (props.routeFocus.itemKind === "workstream" ? props.routeFocus.item : null)
    : null;
  const focused = focusedKey
    ? workstreams?.find((row) => row.key === focusedKey) ?? null
    : null;

  useRouteFocus(props.routeFocus, loaded);

  const load = useCallback(async () => {
    const token = ++requestToken.current;
    setError(null);
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/workstreams`);
      if (token !== requestToken.current) return;
      if (!response.ok) {
        setWorkstreams([]);
        setError("Workstreams could not be loaded. Nothing recorded was changed.");
        return;
      }
      const body = (await response.json()) as { workstreams?: WorkstreamView[] };
      if (token !== requestToken.current) return;
      setWorkstreams(body.workstreams ?? []);
    } catch {
      if (token !== requestToken.current) return;
      setWorkstreams([]);
      setError("Workstreams could not be loaded. Check the connection and try again.");
    }
  }, [props.caseId]);

  useEffect(() => {
    setWorkstreams(null);
    setExcerpts({});
    requestedExcerpts.current = new Set<string>();
    void load();
  }, [load]);

  // A run started elsewhere in Analyze changes what workstreams exist.
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("contextdesk:triage-run-changed", refresh);
    return () => window.removeEventListener("contextdesk:triage-run-changed", refresh);
  }, [load]);

  // Poll only while work is genuinely unsettled, and stop as soon as it is.
  const unsettled = (workstreams ?? []).some((row) => row.lifecycle !== "settled");
  useEffect(() => {
    if (!unsettled) return undefined;
    const timer = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(timer);
  }, [unsettled, load]);

  // Read the cited evidence only for the workstream a reader actually opened.
  useEffect(() => {
    if (!focused) return;
    const pending = focused.evidenceCited.filter(
      (row) => row.resolved && !requestedExcerpts.current.has(row.evidenceId),
    );
    if (!pending.length) return;
    let active = true;
    for (const row of pending) requestedExcerpts.current.add(row.evidenceId);
    setExcerpts((current) => {
      const next = { ...current };
      for (const row of pending) next[row.evidenceId] = { kind: "loading" };
      return next;
    });
    void Promise.all(
      pending.map(async (row) => {
        try {
          const response = await protectedApiFetch(
            `/api/cases/${props.caseId}/evidence/${row.evidenceId}/bytes`,
          );
          if (!response.ok) return [row.evidenceId, { kind: "unavailable" } as ExcerptState] as const;
          const body = (await response.json()) as { contentBase64?: string };
          if (!body.contentBase64) {
            return [row.evidenceId, { kind: "unavailable" } as ExcerptState] as const;
          }
          return [row.evidenceId, decodeEvidence(body.contentBase64)] as const;
        } catch {
          return [row.evidenceId, { kind: "unavailable" } as ExcerptState] as const;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      setExcerpts((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      active = false;
    };
  }, [focused, props.caseId]);

  function focusFor(key: string | null): WorkFocus {
    return {
      section: WORKSTREAMS_SECTION,
      item: key,
      itemKind: key ? "workstream" : null,
      lane: key,
      experiment: null,
    };
  }

  function hrefFor(focus: WorkFocus): string {
    const params = new URLSearchParams({ section: focus.section });
    if (focus.item) params.set("item", focus.item);
    if (focus.itemKind) params.set("kind", focus.itemKind);
    if (focus.lane) params.set("lane", focus.lane);
    return `/investigations/${props.caseId}/analyze?${params.toString()}#${encodeURIComponent(focus.section)}`;
  }

  function navigate(key: string | null) {
    const focus = focusFor(key);
    if (props.onDeepNavigate) {
      props.onDeepNavigate(focus);
      return;
    }
    // Without a shell to own history, keep the address bar truthful anyway so
    // a copied link still resolves to this exact workstream.
    window.history.pushState(focus, "", hrefFor(focus));
  }

  function routeLink(key: string | null, label: string, className: string) {
    return (
      <a
        className={className}
        href={hrefFor(focusFor(key))}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          navigate(key);
        }}
      >
        {label}
      </a>
    );
  }

  const heading = (
    <div className="workstreams__intro">
      <p className="workstreams__eyebrow">Investigative work</p>
      <h4 className="workstreams__title" id="workstreams-title" tabIndex={-1}>
        Workstreams
      </h4>
      <p className="workstreams__lede">
        Each workstream is one line of investigation against a frozen set of evidence — what it
        was asked, who ran it, what it found, what it cited, and what it left unknown. Open one to
        read its own record.
      </p>
    </div>
  );

  if (!loaded) {
    return (
      <section className="workstreams" aria-labelledby="workstreams-title">
        {heading}
        <p className="workstreams__empty" role="status">
          Loading workstreams…
        </p>
      </section>
    );
  }

  if (focusedKey && !focused) {
    return (
      <section className="workstreams" aria-labelledby="workstreams-title">
        {heading}
        <p className="workstreams__empty" role="alert">
          That workstream is not part of this investigation, or it is no longer available to your
          account. Nothing else was opened from that address.
        </p>
        {routeLink(null, "Back to all workstreams", "workstreams__back")}
      </section>
    );
  }

  if (focused) {
    return (
      <section className="workstreams workstreams--focused" aria-labelledby="workstream-detail-title">
        <nav className="workstreams__crumbs" aria-label="Workstream">
          {routeLink(null, "All workstreams", "workstreams__back")}
        </nav>
        <article
          className="workstreams__detail"
          data-route-item={focused.key}
          data-route-kind="workstream"
          tabIndex={-1}
        >
          <header className="workstreams__detail-head">
            <div>
              <p className="workstreams__eyebrow">{focused.strategyLabel}</p>
              <h4 className="workstreams__title" id="workstream-detail-title">
                {focused.label}
              </h4>
              <p className="workstreams__purpose">
                <strong>Asked to find out:</strong> {focused.purpose}
              </p>
            </div>
            <p className={`workstreams__status workstreams__status--${focused.lifecycle}`}>
              {focused.statusLabel}
            </p>
          </header>
          <p className="workstreams__status-detail" role="status">
            {focused.statusDetail}
          </p>

          <dl className="workstreams__facts">
            <div>
              <dt>Performed by</dt>
              <dd>{focused.operatorLabel}</dd>
            </div>
            <div>
              <dt>Requested by</dt>
              <dd>{focused.assignedTo}</dd>
            </div>
            <div>
              <dt>Evidence it was given</dt>
              <dd>
                {focused.inputs.snapshotLabel} · {focused.inputs.snapshotEvidenceCount} item
                {focused.inputs.snapshotEvidenceCount === 1 ? "" : "s"}, frozen{" "}
                {timeLabel(focused.inputs.snapshotFrozenAt)}
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{timeLabel(focused.startedAt)}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{timeLabel(focused.finishedAt)}</dd>
            </div>
            <div>
              <dt>Same-evidence proof</dt>
              <dd>{focused.inputs.snapshotProofLabel}</dd>
            </div>
          </dl>

          <section className="workstreams__block" aria-labelledby="workstream-findings-title">
            <h5 id="workstream-findings-title">What it reported</h5>
            {focused.findings ? (
              <p className="workstreams__findings">{focused.findings}</p>
            ) : (
              <p className="workstreams__empty">
                No written finding was recorded for this workstream.
              </p>
            )}
            <p className="workstreams__outcome">{focused.outcome}</p>
            <p className="workstreams__notice" role="note">
              {focused.agreementNotice}
            </p>
          </section>

          <section className="workstreams__block" aria-labelledby="workstream-evidence-title">
            <h5 id="workstream-evidence-title">
              Evidence it cited
              <span className="workstreams__count">
                {focused.evidenceCited.length} item
                {focused.evidenceCited.length === 1 ? "" : "s"}
              </span>
            </h5>
            {focused.evidenceCited.length === 0 ? (
              <p className="workstreams__empty">
                This workstream cited no evidence. Treat anything it reported as unsupported until a
                person attaches the record it relies on.
              </p>
            ) : (
              <ul className="workstreams__evidence">
                {focused.evidenceCited.map((citation) => {
                  const excerpt = excerpts[citation.evidenceId];
                  return (
                    <li
                      key={citation.evidenceId}
                      className="workstreams__evidence-item"
                      data-route-item={citation.evidenceId}
                      data-route-kind="evidence"
                      tabIndex={-1}
                    >
                      <h6 className="workstreams__evidence-label">{citation.label}</h6>
                      <p className="workstreams__evidence-meta">
                        {citation.kind} ·{" "}
                        {citation.inFrozenSnapshot
                          ? "in the frozen evidence set"
                          : "not in the frozen evidence set"}{" "}
                        · integrity {citation.verification}
                      </p>
                      {citation.summary ? (
                        <p className="workstreams__evidence-summary">{citation.summary}</p>
                      ) : null}
                      {!citation.resolved ? (
                        <p className="workstreams__evidence-missing" role="note">
                          This reference no longer resolves to registered evidence. ContextDesk will
                          not reconstruct the record from an identifier.
                        </p>
                      ) : excerpt?.kind === "text" ? (
                        <ArtifactExcerpt text={excerpt.text} label={citation.label} copyable />
                      ) : excerpt?.kind === "loading" ? (
                        <p className="workstreams__evidence-missing" role="status">
                          Reading the recorded evidence…
                        </p>
                      ) : excerpt?.kind === "binary" ? (
                        <p className="workstreams__evidence-missing" role="note">
                          This evidence is not readable text. Its recorded metadata is shown above.
                        </p>
                      ) : (
                        <p className="workstreams__evidence-missing" role="note">
                          The recorded bytes are not available to this view. Its metadata is shown
                          above.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="workstreams__block" aria-labelledby="workstream-unknown-title">
            <h5 id="workstream-unknown-title">What it left unknown</h5>
            {focused.unknowns.length ? (
              <ul className="workstreams__unknowns">
                {focused.unknowns.map((unknown) => (
                  <li key={unknown}>{unknown}</li>
                ))}
              </ul>
            ) : (
              <p className="workstreams__empty">
                Nothing was recorded as unknown. That is not the same as nothing being unknown.
              </p>
            )}
          </section>

          <section className="workstreams__block" aria-labelledby="workstream-activity-title">
            <h5 id="workstream-activity-title">What happened, in order</h5>
            {focused.activity.length ? (
              <ol className="workstreams__activity">
                {focused.activity.map((entry, index) => (
                  <li key={`${entry.at ?? "unrecorded"}:${index}`}>
                    <p className="workstreams__activity-label">{entry.label}</p>
                    <p className="workstreams__activity-meta">
                      {entry.at ? (
                        <time dateTime={entry.at}>{timeLabel(entry.at)}</time>
                      ) : (
                        <span>Time not recorded</span>
                      )}
                      {" · "}
                      {entry.actor}
                    </p>
                    {entry.detail ? (
                      <p className="workstreams__activity-detail">{entry.detail}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="workstreams__empty">No activity has been recorded for this workstream.</p>
            )}
          </section>

          <section className="workstreams__block" aria-labelledby="workstream-rerun-title">
            <h5 id="workstream-rerun-title">Reruns</h5>
            <p className="workstreams__rerun">{focused.rerun.note}</p>
            {focused.rerun.parentKey
              ? routeLink(
                  focused.rerun.parentKey,
                  "Open the workstream this reran",
                  "workstreams__rerun-link",
                )
              : null}
          </section>

          <details className="workstreams__technical">
            <summary>Technical details — identifiers, fingerprints, and hashes</summary>
            <p className="workstreams__technical-note">
              These identifiers are what machine exports carry. They are kept out of the reading
              view above so the record stays legible; nothing here is hidden from an export.
            </p>
            <dl>
              <div>
                <dt>Workstream</dt>
                <dd><code>{focused.technical.workstreamKey}</code></dd>
              </div>
              <div>
                <dt>Run</dt>
                <dd><code>{focused.technical.runId}</code></dd>
              </div>
              <div>
                <dt>Lane</dt>
                <dd><code>{focused.technical.candidateId}</code></dd>
              </div>
              <div>
                <dt>Strategy</dt>
                <dd><code>{focused.technical.strategyId}</code></dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  <code>
                    {focused.technical.modelId}
                    {focused.technical.modelVersion ? ` @ ${focused.technical.modelVersion}` : ""}
                  </code>{" "}
                  via {focused.technical.provider}
                </dd>
              </div>
              <div>
                <dt>Snapshot</dt>
                <dd><code>{focused.technical.snapshotId}</code></dd>
              </div>
              <div>
                <dt>Snapshot fingerprint</dt>
                <dd><code>{focused.technical.snapshotFingerprint}</code></dd>
              </div>
              <div>
                <dt>Request fingerprint</dt>
                <dd><code>{focused.technical.requestFingerprint}</code></dd>
              </div>
              <div>
                <dt>Task fingerprint</dt>
                <dd><code>{focused.technical.taskFingerprint}</code></dd>
              </div>
              <div>
                <dt>Output hash</dt>
                <dd>
                  {focused.technical.outputHash ? (
                    <code>{focused.technical.outputHash}</code>
                  ) : (
                    "not recorded"
                  )}
                </dd>
              </div>
              <div>
                <dt>Gateway connection</dt>
                <dd>
                  {focused.technical.profileId ? (
                    <code>{focused.technical.profileId}</code>
                  ) : (
                    "none — this workstream did not use a gateway connection"
                  )}
                </dd>
              </div>
              <div>
                <dt>Experiment Lab run</dt>
                <dd>
                  {focused.technical.benchmarkRunId ? (
                    <code>{focused.technical.benchmarkRunId}</code>
                  ) : (
                    "not recorded"
                  )}
                </dd>
              </div>
              <div>
                <dt>Reran</dt>
                <dd>
                  {focused.technical.parentRunId ? (
                    <code>{focused.technical.parentRunId}</code>
                  ) : (
                    "not a rerun"
                  )}
                </dd>
              </div>
              <div>
                <dt>Stop reason</dt>
                <dd>
                  {focused.technical.errorCode ? (
                    <code>{focused.technical.errorCode}</code>
                  ) : (
                    "none recorded"
                  )}
                </dd>
              </div>
              <div>
                <dt>Privacy class</dt>
                <dd><code>{focused.technical.privacyClass}</code></dd>
              </div>
            </dl>
          </details>
        </article>
      </section>
    );
  }

  const groups: { key: string; rows: WorkstreamView[] }[] = [];
  for (const row of workstreams) {
    const key = runGroupKey(row);
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.rows.push(row);
    else groups.push({ key, rows: [row] });
  }

  return (
    <section className="workstreams" aria-labelledby="workstreams-title">
      {heading}
      {error ? (
        <p className="workstreams__error" role="alert">
          {error}
        </p>
      ) : null}
      {workstreams.length === 0 && !error ? (
        <p className="workstreams__empty">
          No workstream has run on this investigation yet. Freeze the evidence a workstream should
          see, then start one below.
        </p>
      ) : null}
      {groups.map((group) => {
        const first = group.rows[0]!;
        return (
          <section
            className="workstreams__group"
            key={group.key}
            aria-labelledby={`workstream-group-${group.key}`}
          >
            <header className="workstreams__group-head">
              <h5 id={`workstream-group-${group.key}`}>{first.strategyLabel}</h5>
              <p className="workstreams__group-question">
                <strong>Asked:</strong> {first.inputs.question}
              </p>
              <p className="workstreams__group-inputs">
                {first.inputs.snapshotLabel} · {first.inputs.snapshotEvidenceCount} evidence item
                {first.inputs.snapshotEvidenceCount === 1 ? "" : "s"} · requested by{" "}
                {first.assignedTo} · {timeLabel(first.inputs.snapshotFrozenAt)}
              </p>
            </header>
            <ul className="workstreams__list">
              {group.rows.map((row) => (
                <li
                  key={row.key}
                  className="workstreams__card"
                  data-route-item={row.key}
                  data-route-kind="workstream"
                  tabIndex={-1}
                >
                  <div className="workstreams__card-head">
                    <h6 className="workstreams__card-title">
                      {routeLink(row.key, row.label, "workstreams__card-open")}
                    </h6>
                    <span className={`workstreams__status workstreams__status--${row.lifecycle}`}>
                      {row.statusLabel}
                    </span>
                  </div>
                  <p className="workstreams__card-operator">{row.operatorLabel}</p>
                  {row.findings ? (
                    <p className="workstreams__card-findings">{row.findings}</p>
                  ) : (
                    <p className="workstreams__card-findings workstreams__empty">
                      No written finding recorded.
                    </p>
                  )}
                  <p className="workstreams__card-meta">
                    {row.evidenceCited.length} evidence cited · {row.unknowns.length} unknown
                    {row.unknowns.length === 1 ? "" : "s"} · finished {timeLabel(row.finishedAt)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
