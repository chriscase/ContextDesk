import { useCallback, useEffect, useState, type FormEvent } from "react";

interface CandidateRow {
  candidateId: string;
  modelLabel: string;
  role: string;
  runStatus: string;
  observedLatency: { status: string; milliseconds?: number };
  cost: { status: string };
  usage: { status: string };
  helpfulnessState: string;
  goldState: string;
}

interface ExperimentView {
  id: string;
  packageId: string;
  taskFingerprint: string;
  snapshotFingerprint: string;
  candidates: CandidateRow[];
  agreement: {
    sharedAnchors: { evidenceRef: string; role: string; candidateIds: string[] }[];
    candidateSpecific: { candidateId: string; evidenceRefs: string[] }[];
    roleConflicts: {
      evidenceRef: string;
      assignments: { candidateId: string; role: string }[];
    }[];
    notes: string[];
  };
  observations: {
    id: string;
    candidateId: string;
    dimension: string;
    score: number;
    rationale: string;
    reviewerUsername: string;
  }[];
  decisions: {
    id: string;
    status: string;
    revision: number;
    text: string;
    rationale: string;
    authorUsername?: string;
  }[];
  gold: {
    goldId: string;
    version: number;
    predecessorGoldId: string | null;
    packageId: string;
    acceptedDecisionId: string;
    acceptedDecisionRevision: number;
    evidenceAnchors: string[];
    promotedByUsername: string;
    notes: string[];
  } | null;
  alignments: {
    candidateId: string;
    status: string;
    matchedAnchors: string[];
    missingAnchors: string[];
    extraAnchors: string[];
    notes: string[];
  }[];
  traces: {
    candidateId: string;
    sourceKind: string;
    completeness: string;
    unknowns: string[];
    events: {
      eventId: string;
      sequence: number;
      kind: string;
      actor: string;
      authorUsername?: string;
      excerpt: string | null;
      evidenceRefs: string[];
      unknowns: string[];
    }[];
    efficiency: {
      turnCount: { status: string; count?: number };
      evidenceAcquisitionSteps: { status: string; count?: number };
      latency: { status: string; milliseconds?: number };
      cost: { status: string };
      providerCalls: { status: string; count?: number };
    };
  }[];
  comparison: {
    questionPaths: { pathId: string; excerpt: string | null; candidateIds: string[] }[];
    sharedEvidence: { evidenceRef: string; candidateIds: string[] }[];
    uniqueEvidence: { candidateId: string; evidenceRefs: string[] }[];
    divergence: { kind: string; summary: string }[];
    convergence: { evidenceRef: string; inGold: boolean; candidateIds: string[] }[];
    efficiency: { candidateId: string; efficiency: { turnCount: { status: string; count?: number } } }[];
    gold: { status: string; version: number | null; acceptedDecisionId: string | null };
    notes: string[];
  };
}

interface ShareSafeExport {
  schemaId?: string;
  privacyClass?: string;
  review?: {
    candidates?: unknown[];
    observations?: unknown[];
    decision?: { status?: string; revision?: number } | null;
    gold?: { version?: number } | null;
    omissions?: {
      modelLabelsIncluded?: boolean;
      participantIdentitiesIncluded?: boolean;
      freeTextIncluded?: boolean;
      privateContentIncluded?: boolean;
      correlatableMetadataIncluded?: boolean;
    };
  };
  traces?: unknown[];
}

const omissionLabels = [
  ["modelLabelsIncluded", "model labels"],
  ["participantIdentitiesIncluded", "participant identities"],
  ["freeTextIncluded", "free text"],
  ["privateContentIncluded", "private content"],
  ["correlatableMetadataIncluded", "correlatable metadata"],
] as const;

function exportOmissionSummary(exported: ShareSafeExport): string | null {
  const omissions = exported.review?.omissions;
  if (!omissions) return null;
  const omitted = omissionLabels
    .filter(([key]) => omissions[key] === false)
    .map(([, label]) => label);
  const included = omissionLabels
    .filter(([key]) => omissions[key] === true)
    .map(([, label]) => label);
  const parts: string[] = [];
  if (omitted.length) parts.push(`Omitted: ${omitted.join(", ")}.`);
  if (included.length) parts.push(`Included: ${included.join(", ")}.`);
  return parts.length ? parts.join(" ") : null;
}

function latencyLabel(value: CandidateRow["observedLatency"]): string {
  return value.status === "observed" && typeof value.milliseconds === "number"
    ? `${value.milliseconds} ms`
    : "unknown";
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error.trim()
    ) {
      return body.error;
    }
  } catch {
    // Preserve a useful fallback when the server returned no JSON body.
  }
  return fallback;
}

export function ExperimentLab(props: {
  caseId: string;
  canWrite: boolean;
  canLead: boolean;
  readOnly?: boolean;
  caseTitle?: string;
  caseStatus?: string;
  caseSeverity?: string;
  participant?: { username: string; roles: string[] };
}) {
  const readOnly = props.readOnly === true;
  const canWrite = props.canWrite && !readOnly;
  const canLead = props.canLead && !readOnly;
  const canExport = props.canLead || readOnly;
  const participantName = props.participant?.username || (readOnly ? "read-only viewer" : "authenticated participant");
  const participantRole = props.participant?.roles.join(", ") || (canLead ? "case-lead access" : canWrite ? "contributor access" : "read-only access");
  const [experiments, setExperiments] = useState<ExperimentView[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<ShareSafeExport | null>(null);

  const refresh = useCallback(async (preferredId?: string) => {
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments`);
      if (!res.ok) {
        setError(await responseError(res, "Experiment history could not be loaded"));
        return;
      }
      const body = (await res.json()) as { experiments?: ExperimentView[] };
      const nextExperiments = body.experiments ?? [];
      setExperiments(nextExperiments);
      if (preferredId && nextExperiments.some((row) => row.id === preferredId)) {
        setActive(preferredId);
      }
    } catch {
      setError("Experiment history could not be loaded");
    }
  }, [props.caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function handleExperimentCreated(event: Event) {
      const detail = (event as CustomEvent<{ experimentId?: unknown }>).detail;
      if (!detail || typeof detail.experimentId !== "string" || !detail.experimentId) return;
      setError(null);
      setExported(null);
      void refresh(detail.experimentId);
    }

    window.addEventListener("contextdesk:experiment-created", handleExperimentCreated);
    return () => window.removeEventListener("contextdesk:experiment-created", handleExperimentCreated);
  }, [refresh]);

  useEffect(() => {
    setActive(null);
    setExported(null);
    setError(null);
  }, [props.caseId]);

  const current = experiments.find((row) => row.id === active) ?? experiments[0] ?? null;

  function selectExperiment(id: string) {
    setActive(id);
    setExported(null);
    setError(null);
  }

  async function importPackage(event: FormEvent) {
    event.preventDefault();
    setError(null);
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      setError("Package JSON is invalid");
      return;
    }
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await responseError(res, "Experiment import failed"));
        return;
      }
      const json = (await res.json()) as ExperimentView;
      setPayload("");
      selectExperiment(json.id);
      await refresh();
    } catch {
      setError("Experiment import failed");
    }
  }

  async function recordHelpfulness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const data = new FormData(event.currentTarget);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments/${current.id}/helpfulness`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidateId: String(data.get("candidateId") ?? ""),
          dimension: String(data.get("dimension") ?? ""),
          score: Number(data.get("score")),
          rationale: String(data.get("rationale") ?? ""),
          evidenceRefs: String(data.get("evidenceRefs") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      });
      if (!res.ok) {
        setError(await responseError(res, "Helpfulness could not be recorded"));
        return;
      }
      event.currentTarget.reset();
      await refresh();
    } catch {
      setError("Helpfulness could not be recorded");
    }
  }

  async function proposeDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const data = new FormData(event.currentTarget);
    const latest = current.decisions.at(-1);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments/${current.id}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: String(data.get("text") ?? ""),
          rationale: String(data.get("rationale") ?? ""),
          evidenceRefs: String(data.get("evidenceRefs") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          expectedRevision: latest ? latest.revision : null,
        }),
      });
      if (!res.ok) {
        setError(await responseError(res, "Decision proposal could not be recorded"));
        return;
      }
      event.currentTarget.reset();
      await refresh();
    } catch {
      setError("Decision proposal could not be recorded");
    }
  }

  async function acceptDecision() {
    if (!current) return;
    const latest = current.decisions.at(-1);
    if (!latest) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/cases/${props.caseId}/experiments/${current.id}/decisions/${latest.id}/accept`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: latest.revision }),
        },
      );
      if (!res.ok) {
        setError(await responseError(res, "Decision could not be accepted"));
        return;
      }
      await refresh();
    } catch {
      setError("Decision could not be accepted");
    }
  }

  async function exportReview() {
    if (!current) return;
    setError(null);
    setExported(null);
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments/${current.id}/export`, {
        method: "POST",
      });
      const body = (await res.json()) as ShareSafeExport & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Share-safe export failed");
        return;
      }
      setExported(body);
    } catch {
      setError("Share-safe export failed because the response could not be read");
    }
  }

  async function promoteGold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const accepted = [...current.decisions].reverse().find((row) => row.status === "accepted");
    if (!accepted) return;
    const data = new FormData(event.currentTarget);
    const expectedGold = String(data.get("expectedGoldVersion") ?? "").trim();
    setError(null);
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments/${current.id}/gold`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decisionId: accepted.id,
          expectedRevision: accepted.revision,
          expectedGoldVersion: expectedGold ? Number(expectedGold) : current.gold?.version ?? 0,
          evidenceAnchors: String(data.get("evidenceAnchors") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          expectedRelationships: String(data.get("expectedRelationships") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => {
              const [evidenceRef, role] = item.split("=").map((part) => part.trim());
              return { evidenceRef, role };
            })
            .filter((row) => row.evidenceRef && row.role),
          helpfulnessDimensions: String(data.get("helpfulnessDimensions") ?? "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        }),
      });
      if (!res.ok) {
        setError(await responseError(res, "Gold promotion failed"));
        return;
      }
      event.currentTarget.reset();
      await refresh();
    } catch {
      setError("Gold promotion failed");
    }
  }

  async function importTrace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const data = new FormData(event.currentTarget);
    const raw = String(data.get("trace") ?? "");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      setError("Trace JSON is invalid");
      return;
    }
    try {
      const res = await fetch(`/api/cases/${props.caseId}/experiments/${current.id}/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await responseError(res, "Trace import failed"));
        return;
      }
      event.currentTarget.reset();
      await refresh();
    } catch {
      setError("Trace import failed");
    }
  }

  async function annotateTrace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const data = new FormData(event.currentTarget);
    const candidateId = String(data.get("candidateId") ?? "");
    setError(null);
    try {
      const res = await fetch(
        `/api/cases/${props.caseId}/experiments/${current.id}/traces/${candidateId}/annotations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: String(data.get("text") ?? ""),
            evidenceRefs: String(data.get("evidenceRefs") ?? "")
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          }),
        },
      );
      if (!res.ok) {
        setError(await responseError(res, "Trace annotation could not be recorded"));
        return;
      }
      event.currentTarget.reset();
      await refresh();
    } catch {
      setError("Trace annotation could not be recorded");
    }
  }

  return (
    <section className="experiment-lab">
      <header className="experiment-lab__header">
        <div>
          <p className="experiment-lab__eyebrow">
            Case {props.caseTitle ?? props.caseId} · collaborative triage war room
          </p>
          <h3 className="case-view__title">Experiment lab</h3>
          <p className="experiment-lab__case-state">
            <span>{props.caseStatus ?? "status unavailable"}</span>
            <span>{props.caseSeverity ?? "severity unavailable"} severity</span>
          </p>
        </div>
        <div className="experiment-lab__presence" aria-label="War room participant">
          <span className="experiment-lab__presence-dot" aria-hidden="true" />
          <div>
            <span className="experiment-lab__eyebrow">Current participant</span>
            <strong>{participantName}</strong>
            <span>{participantRole}</span>
          </div>
          {current ? (
            <span className="experiment-lab__status">{current.candidates.length} candidate lanes</span>
          ) : null}
        </div>
      </header>
      <p className="experiment-lab__intro">
        Compare seeded, connected ContextDesk, and pasted-chat triage candidates across model and
        strategy lanes. Agreement is not proof of correctness. A gold reference is a human
        benchmark decision, not an infallible truth claim. Gold alignment is scored separately
        from helpfulness.
      </p>
      <div className="experiment-lab__future-slots" aria-label="War room extension slots">
        <span>Sources: seeded · ContextDesk connector · pasted chat</span>
        <span>Next extensions: presence · live updates · semantic search</span>
      </div>
      <div className="experiment-lab__extension-grid" aria-label="War room extension points">
        <div>
          <span>Case comments</span>
          <small>Case timeline and notes</small>
        </div>
        <div>
          <span>Evidence notes</span>
          <small>Anchored in the evidence map</small>
        </div>
        <div>
          <span>Lane / run notes</span>
          <small>Candidate and replay context</small>
        </div>
        <div>
          <span>Trace event notes</span>
          <small>Annotations stay with the path</small>
        </div>
        <div>
          <span>Decision / gold history</span>
          <small>Revisions and provenance</small>
        </div>
        <div>
          <span>Connected run handoff</span>
          <small>ContextDesk host bridge to candidate path</small>
        </div>
        <div className="experiment-lab__extension-slot--future">
          <span>Semantic search</span>
          <small>Future slot · case-wide retrieval</small>
        </div>
      </div>
      <p className="experiment-lab__authority">
        Actions in this room are attributed to <strong>{participantName}</strong> ({participantRole}).
        The server remains authoritative for permissions, provenance, and accepted state.
      </p>
      {readOnly ? (
        <p className="experiment-lab__disclaimer" role="status">
          Static read-only mode: review the seeded comparison or export its share-safe
          projection. Editing, importing, scoring, and benchmark changes are unavailable.
        </p>
      ) : null}
      {canWrite ? (
        <details className="experiment-lab__tools">
          <summary>Import another experiment package</summary>
          <form className="composer" onSubmit={(event) => void importPackage(event)}>
            <textarea
              className="login__input"
              rows={6}
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              placeholder="Paste share-safe experiment, strategy package, or summary JSON"
              required
            />
            <button className="login__submit" type="submit">
              Import experiment
            </button>
          </form>
        </details>
      ) : null}
      {error ? (
        <p className="experiment-lab__error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      {experiments.length > 1 ? (
        <nav className="experiment-lab__experiments" aria-label="Historical triage artifacts">
          <p className="experiment-lab__eyebrow">Historical artifacts</p>
          <ul className="case-list__items">
            {experiments.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={row.id === current?.id ? "page" : undefined}
                  aria-pressed={row.id === current?.id}
                  onClick={() => selectExperiment(row.id)}
                >
                  {row.packageId}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {current ? (
        <>
          <p className="experiment-lab__identity">
            package {current.packageId} · task {current.taskFingerprint.slice(0, 12)} · snapshot{" "}
            {current.snapshotFingerprint.slice(0, 12)}
          </p>
          <div className="experiment-lab__scorecards" aria-label="Experiment summary">
            <article>
              <span>Candidates</span>
              <strong>{current.candidates.length}</strong>
            </article>
            <article>
              <span>Shared evidence</span>
              <strong>{current.agreement.sharedAnchors.length}</strong>
            </article>
            <article>
              <span>Differences</span>
              <strong>
                {current.agreement.candidateSpecific.reduce(
                  (count, row) => count + row.evidenceRefs.length,
                  0,
                ) + current.agreement.roleConflicts.length}
              </strong>
            </article>
            <article>
              <span>Human reviews</span>
              <strong>{current.observations.length}</strong>
            </article>
            <article>
              <span>Benchmark</span>
              <strong>{current.gold ? `v${current.gold.version}` : "—"}</strong>
            </article>
          </div>
          <section className="experiment-lab__gold" aria-label="Gold reference">
            {current.gold ? (
              <>
                <h4 className="experiment-lab__heading">Gold reference v{current.gold.version}</h4>
                <p className="timeline__meta">
                  Human benchmark from accepted decision {current.gold.acceptedDecisionId} r
                  {current.gold.acceptedDecisionRevision}, promoted by{" "}
                  {current.gold.promotedByUsername}. Evidence:{" "}
                  {current.gold.evidenceAnchors.join(", ")}.
                </p>
                <p className="experiment-lab__disclaimer">
                  A gold reference is a human benchmark decision, not an infallible truth claim.
                  Gold alignment is not a correctness verdict.
                </p>
              </>
            ) : (
              <p className="timeline__meta">
                No gold reference. Gold state stays unknown or absent until a case-lead promotes
                an accepted decision.
              </p>
            )}
          </section>
          <section className="experiment-lab__section" aria-labelledby="candidate-comparison-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Model / method lanes</p>
                <h4 id="candidate-comparison-heading" className="experiment-lab__heading">
                  Candidate comparison
                </h4>
              </div>
              <span className="experiment-lab__section-kicker">Observed + human signals</span>
            </div>
            <p className="experiment-lab__section-note">
              Run facts are shown beside separate helpfulness and gold signals. Unknown values stay
              unknown.
            </p>
          <div className="experiment-lab__matrix-wrap">
            <table className="experiment-lab__matrix">
              <caption>Candidate comparison — observed run facts and review signals</caption>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Latency</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Usage</th>
                  <th scope="col">Helpfulness</th>
                  <th scope="col">Gold</th>
                </tr>
              </thead>
              <tbody>
                {current.candidates.map((row) => (
                  <tr key={row.candidateId}>
                    <th scope="row">{row.modelLabel}</th>
                    <td>{row.role}</td>
                    <td>{row.runStatus}</td>
                    <td>{latencyLabel(row.observedLatency)}</td>
                    <td>{row.cost.status}</td>
                    <td>{row.usage.status}</td>
                    <td>{row.helpfulnessState}</td>
                    <td>{row.goldState}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </section>
          <section className="experiment-lab__section" aria-labelledby="evidence-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Evidence map</p>
                <h4 id="evidence-heading" className="experiment-lab__heading">
                  Shared and different evidence
                </h4>
              </div>
              <span className="experiment-lab__section-kicker">Agreement is not correctness</span>
            </div>
            <p className="experiment-lab__section-note">{current.agreement.notes.join(" ")}</p>
            <div className="experiment-lab__evidence-grid">
              <div className="experiment-lab__evidence-card">
                <h5>Shared evidence</h5>
                {current.agreement.sharedAnchors.length ? (
                  <ul className="experiment-lab__detail-list">
                    {current.agreement.sharedAnchors.map((anchor) => (
                      <li key={`${anchor.evidenceRef}:${anchor.role}`}>
                        Shared {anchor.evidenceRef} as {anchor.role} ({anchor.candidateIds.join(", ")})
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="experiment-lab__empty">No shared evidence recorded.</p>
                )}
              </div>
              <div className="experiment-lab__evidence-card">
                <h5>Different evidence</h5>
                {current.agreement.candidateSpecific.length || current.agreement.roleConflicts.length ? (
                  <ul className="experiment-lab__detail-list">
                    {current.agreement.candidateSpecific.map((row) => (
                      <li key={row.candidateId}>
                        {row.candidateId} only: {row.evidenceRefs.join(", ") || "none"}
                      </li>
                    ))}
                    {current.agreement.roleConflicts.map((row) => (
                      <li key={row.evidenceRef}>
                        Role conflict on {row.evidenceRef}:{" "}
                        {row.assignments.map((a) => `${a.candidateId}=${a.role}`).join("; ")}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="experiment-lab__empty">No candidate-specific evidence recorded.</p>
                )}
              </div>
            </div>
          </section>
          <section className="experiment-lab__section" aria-labelledby="strategy-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Strategy lanes</p>
                <h4 id="strategy-heading" className="experiment-lab__heading">Strategy comparison</h4>
              </div>
              <span className="experiment-lab__section-kicker">Path view</span>
            </div>
            <p className="experiment-lab__disclaimer">
              Textual similarity is not a winner. Ambiguous transcript structure stays unknown.
              Gold alignment and helpfulness stay independent of this projection.
            </p>
            <p className="timeline__meta">
              Gold {current.comparison?.gold.status ?? "unknown"}
              {current.comparison?.gold.acceptedDecisionId
                ? ` · accepted decision ${current.comparison.gold.acceptedDecisionId}`
                : " · no accepted gold decision"}
              {" · "}
              Helpfulness {current.candidates.map((row) => `${row.modelLabel}:${row.helpfulnessState}`).join(", ")}
            </p>
            <ul className="experiment-lab__signal-list">
              {(current.comparison?.questionPaths ?? []).map((path) => (
                <li key={path.pathId} className="timeline__item">
                  Question path: {path.excerpt ?? "unknown"} ({path.candidateIds.join(", ")})
                </li>
              ))}
              {(current.comparison?.sharedEvidence ?? []).map((row) => (
                <li key={`shared-${row.evidenceRef}`} className="timeline__item">
                  Shared evidence {row.evidenceRef} ({row.candidateIds.join(", ")})
                </li>
              ))}
              {(current.comparison?.uniqueEvidence ?? []).map((row) =>
                row.evidenceRefs.length ? (
                  <li key={`unique-${row.candidateId}`} className="timeline__item">
                    Unique to {row.candidateId}: {row.evidenceRefs.join(", ")}
                  </li>
                ) : null,
              )}
              {(current.comparison?.divergence ?? []).map((row) => (
                <li key={`${row.kind}:${row.summary}`} className="timeline__item">
                  Divergence ({row.kind}): {row.summary}
                </li>
              ))}
              {(current.comparison?.convergence ?? [])
                .filter((row) => row.inGold)
                .map((row) => (
                  <li key={`gold-${row.evidenceRef}`} className="timeline__item">
                    Converges on gold {row.evidenceRef}
                  </li>
                ))}
            </ul>
            <h5 className="experiment-lab__subheading">Strategy paths</h5>
            <div className="experiment-lab__paths">
              {(current.traces ?? []).map((trace) => (
                <article key={trace.candidateId} className="experiment-lab__path">
                  <header className="experiment-lab__path-header">
                    <div>
                      <p className="experiment-lab__eyebrow">Candidate path</p>
                      <h5 className="experiment-lab__path-title">{trace.candidateId}</h5>
                    </div>
                    <span className="experiment-lab__path-kind">
                      {trace.sourceKind} · {trace.completeness}
                    </span>
                  </header>
                  <p className="experiment-lab__path-meta">
                    turns {trace.efficiency.turnCount.status === "observed" ? trace.efficiency.turnCount.count : "unknown"}
                    {" · "}
                    evidence steps{" "}
                    {trace.efficiency.evidenceAcquisitionSteps.status === "observed"
                      ? trace.efficiency.evidenceAcquisitionSteps.count
                      : "unknown"}
                    {" · "}
                    cost {trace.efficiency.cost.status}
                    {trace.unknowns.length ? ` · unknown: ${trace.unknowns.join(", ")}` : ""}
                  </p>
                  <ol className="experiment-lab__path-events">
                    {trace.events.map((event) => (
                      <li key={event.eventId}>
                        {event.sequence}. {event.kind}/{event.actor}
                        {event.excerpt ? `: ${event.excerpt}` : " (unknown text)"}
                        {event.authorUsername ? ` · by ${event.authorUsername}` : ""}
                        {event.evidenceRefs.length ? ` [${event.evidenceRefs.join(", ")}]` : ""}
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          </section>
          {canWrite ? (
            <details className="experiment-lab__tools">
              <summary>Add a chat transcript or interaction trace</summary>
              <form className="composer" onSubmit={(event) => void importTrace(event)}>
                <textarea
                  className="login__input"
                  name="trace"
                  rows={4}
                  placeholder="Paste interaction trace or plain transcript JSON"
                  required
                />
                <button className="login__submit" type="submit">
                  Import trace
                </button>
              </form>
            </details>
          ) : null}
          {canWrite && (current.traces ?? []).length > 0 ? (
            <form className="composer" onSubmit={(event) => void annotateTrace(event)}>
              <select className="login__input" name="candidateId" defaultValue={current.traces[0]?.candidateId}>
                {current.traces.map((trace) => (
                  <option key={trace.candidateId} value={trace.candidateId}>
                    {trace.candidateId}
                  </option>
                ))}
              </select>
              <input className="login__input" name="evidenceRefs" placeholder="evidence refs, comma separated" />
              <textarea className="login__input" name="text" rows={2} required placeholder="Human annotation" />
              <button className="login__submit" type="submit">
                Annotate trace
              </button>
            </form>
          ) : null}
          <section className="experiment-lab__section" aria-labelledby="helpfulness-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Reviewer signals</p>
                <h4 id="helpfulness-heading" className="experiment-lab__heading">Helpfulness</h4>
              </div>
              <span className="experiment-lab__section-kicker">Separate from gold</span>
            </div>
            <p className="experiment-lab__section-note">
              Human helpfulness observations describe response usefulness and do not make live-provider claims.
            </p>
            {canWrite ? (
              <details className="experiment-lab__tools">
                <summary>Score candidate helpfulness</summary>
                <form className="composer" onSubmit={(event) => void recordHelpfulness(event)}>
                  <select className="login__input" name="candidateId" defaultValue={current.candidates[0]?.candidateId}>
                    {current.candidates.map((row) => (
                      <option key={row.candidateId} value={row.candidateId}>
                        {row.modelLabel}
                      </option>
                    ))}
                  </select>
                  <select className="login__input" name="dimension" defaultValue="evidence_support">
                    <option value="evidence_support">evidence support</option>
                    <option value="actionability">actionability</option>
                    <option value="uncertainty_calibration">uncertainty calibration</option>
                    <option value="unsafe_unsupported_claims">unsafe unsupported claims</option>
                  </select>
                  <input className="login__input" name="score" type="number" min={0} max={3} defaultValue={2} required />
                  <input className="login__input" name="evidenceRefs" placeholder="evidence refs, comma separated" />
                  <textarea className="login__input" name="rationale" rows={2} required placeholder="Helpfulness rationale" />
                  <button className="login__submit" type="submit">
                    Record helpfulness
                  </button>
                </form>
              </details>
            ) : null}
          <ul className="experiment-lab__detail-list">
            {current.observations.map((row) => (
              <li key={row.id} className="timeline__item">
                Helpfulness: {row.reviewerUsername} scored {row.candidateId} {row.dimension}{" "}
                {row.score}: {row.rationale}
              </li>
            ))}
          </ul>
          </section>
          <section className="experiment-lab__section" aria-labelledby="gold-alignment-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Benchmark signal</p>
                <h4 id="gold-alignment-heading" className="experiment-lab__heading">Gold alignment</h4>
              </div>
              <span className="experiment-lab__section-kicker">Independent signal</span>
            </div>
          <p className="timeline__meta">
            Separate from helpfulness scores. Gold alignment is not a correctness verdict.
          </p>
          <ul className="timeline">
            {(current.alignments ?? []).map((row) => (
              <li key={row.candidateId} className="timeline__item">
                {row.candidateId}: {row.status}
                {row.matchedAnchors.length ? ` · matched ${row.matchedAnchors.join(", ")}` : ""}
                {row.missingAnchors.length ? ` · missing ${row.missingAnchors.join(", ")}` : ""}
              </li>
            ))}
          </ul>
          </section>
          <section className="experiment-lab__section" aria-labelledby="decision-heading">
            <div className="experiment-lab__section-heading">
              <div>
                <p className="experiment-lab__eyebrow">Human adjudication</p>
                <h4 id="decision-heading" className="experiment-lab__heading">Accepted decision</h4>
              </div>
              <span className="experiment-lab__section-kicker">
                {current.decisions.at(-1)?.status ?? "awaiting proposal"}
              </span>
            </div>
            <p className="experiment-lab__section-note">
              Decision revisions and gold promotion remain server-recorded and attributable to the signed-in participant.
            </p>
          {canWrite ? (
            <details className="experiment-lab__tools">
              <summary>Propose a new human decision</summary>
              <form className="composer" onSubmit={(event) => void proposeDecision(event)}>
                <textarea className="login__input" name="text" rows={2} required placeholder="Proposed decision" />
                <textarea className="login__input" name="rationale" rows={2} required placeholder="Decision rationale" />
                <input className="login__input" name="evidenceRefs" placeholder="evidence refs, comma separated" />
                <button className="login__submit" type="submit">
                  Propose decision
                </button>
              </form>
            </details>
          ) : null}
          {current.decisions.length > 0 ? (
            <p className="experiment-lab__decision-line">
              Latest decision r{current.decisions.at(-1)?.revision} ({current.decisions.at(-1)?.status}):{" "}
              {current.decisions.at(-1)?.text}
              <span>
                Recorded by {current.decisions.at(-1)?.authorUsername ?? "identity unavailable in this view"}
              </span>
            </p>
          ) : null}
          {canLead && current.decisions.at(-1)?.status === "proposed" ? (
            <button className="login__submit" type="button" onClick={() => void acceptDecision()}>
              Accept decision
            </button>
          ) : null}
          {canLead && current.decisions.some((row) => row.status === "accepted") ? (
            <details className="experiment-lab__tools">
              <summary>Version the human benchmark</summary>
              <form className="composer" onSubmit={(event) => void promoteGold(event)}>
                <input
                  className="login__input"
                  name="evidenceAnchors"
                  placeholder="gold evidence anchors, comma separated"
                  required
                />
                <input
                  className="login__input"
                  name="expectedRelationships"
                  placeholder="optional evidence=role pairs, comma separated"
                />
                <input
                  className="login__input"
                  name="helpfulnessDimensions"
                  placeholder="optional helpfulness dimensions, comma separated"
                />
                {current.gold ? (
                  <input
                    className="login__input"
                    name="expectedGoldVersion"
                    type="number"
                    min={1}
                    defaultValue={current.gold.version}
                    aria-label="expected gold version"
                  />
                ) : null}
                <button className="login__submit" type="submit">
                  Promote accepted decision to gold
                </button>
              </form>
            </details>
          ) : null}
          </section>
          {canExport ? (
            <section className="experiment-lab__export" aria-labelledby="export-heading">
              <div className="experiment-lab__export-action">
                <div>
                  <p className="experiment-lab__eyebrow">Share boundary</p>
                  <h4 id="export-heading" className="experiment-lab__heading">Export review</h4>
                </div>
                <button className="login__submit" type="button" onClick={() => void exportReview()}>
                  Export share-safe review
                </button>
              </div>
              {exported ? (
                <div className="experiment-lab__export-result" aria-live="polite">
                  <div className="experiment-lab__section-heading">
                    <div>
                      <p className="experiment-lab__eyebrow">Ready to share</p>
                      <h5 className="experiment-lab__export-title">Share-safe export ready</h5>
                    </div>
                    <span className="experiment-lab__privacy-badge">{exported.privacyClass ?? "share_safe"}</span>
                  </div>
                  <p className="experiment-lab__section-note">
                    A concise privacy-safe summary is shown by default. The raw export stays hidden until you choose to view it.
                  </p>
                  <dl className="experiment-lab__export-facts">
                    <div>
                      <dt>Coverage</dt>
                      <dd>
                        {typeof exported.review?.candidates?.length === "number"
                          ? `${exported.review.candidates.length} candidate${exported.review.candidates.length === 1 ? "" : "s"}`
                          : "Review projection"}
                      </dd>
                    </div>
                    <div>
                      <dt>Decision</dt>
                      <dd>
                        {exported.review?.decision
                          ? `${exported.review.decision.status ?? "recorded"}${typeof exported.review.decision.revision === "number" ? ` · revision ${exported.review.decision.revision}` : ""}`
                          : "None recorded"}
                      </dd>
                    </div>
                    <div>
                      <dt>Benchmark</dt>
                      <dd>
                        {exported.review?.gold
                          ? typeof exported.review.gold.version === "number"
                            ? `v${exported.review.gold.version}`
                            : "Present"
                          : "Not present"}
                      </dd>
                    </div>
                    <div>
                      <dt>Trace coverage</dt>
                      <dd>
                        {typeof exported.traces?.length === "number"
                          ? `${exported.traces.length} trace${exported.traces.length === 1 ? "" : "s"}`
                          : "Included in projection"}
                      </dd>
                    </div>
                  </dl>
                  {exportOmissionSummary(exported) ? (
                    <p className="experiment-lab__privacy-note">{exportOmissionSummary(exported)}</p>
                  ) : null}
                  <details className="experiment-lab__raw-export">
                    <summary>View raw export</summary>
                    <pre className="imported-run__text">{JSON.stringify(exported, null, 2)}</pre>
                  </details>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
