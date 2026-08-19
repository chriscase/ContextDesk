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
}

function latencyLabel(value: CandidateRow["observedLatency"]): string {
  return value.status === "observed" && typeof value.milliseconds === "number"
    ? `${value.milliseconds} ms`
    : "unknown";
}

export function ExperimentLab(props: {
  caseId: string;
  canWrite: boolean;
  canLead: boolean;
}) {
  const [experiments, setExperiments] = useState<ExperimentView[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/cases/${props.caseId}/experiments`);
    if (!res.ok) return;
    const body = (await res.json()) as { experiments?: ExperimentView[] };
    setExperiments(body.experiments ?? []);
  }, [props.caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = experiments.find((row) => row.id === active) ?? experiments[0] ?? null;

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
    const res = await fetch(`/api/cases/${props.caseId}/experiments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as ExperimentView & { error?: string };
    if (!res.ok) {
      setError(json.error ?? "import failed");
      return;
    }
    setPayload("");
    setActive(json.id);
    await refresh();
  }

  async function recordHelpfulness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const data = new FormData(event.currentTarget);
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
    if (!res.ok) return;
    event.currentTarget.reset();
    await refresh();
  }

  async function proposeDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const data = new FormData(event.currentTarget);
    const latest = current.decisions.at(-1);
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
    if (!res.ok) return;
    event.currentTarget.reset();
    await refresh();
  }

  async function acceptDecision() {
    if (!current) return;
    const latest = current.decisions.at(-1);
    if (!latest) return;
    await fetch(
      `/api/cases/${props.caseId}/experiments/${current.id}/decisions/${latest.id}/accept`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: latest.revision }),
      },
    );
    await refresh();
  }

  async function exportReview() {
    if (!current) return;
    const res = await fetch(`/api/cases/${props.caseId}/experiments/${current.id}/export`, {
      method: "POST",
    });
    if (!res.ok) return;
    setExported(JSON.stringify(await res.json(), null, 2));
  }

  async function promoteGold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current) return;
    const accepted = [...current.decisions].reverse().find((row) => row.status === "accepted");
    if (!accepted) return;
    const data = new FormData(event.currentTarget);
    const expectedGold = String(data.get("expectedGoldVersion") ?? "").trim();
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
      const body = (await res.json()) as { error?: string };
      setError(body.error ?? "gold promotion failed");
      return;
    }
    event.currentTarget.reset();
    await refresh();
  }

  return (
    <section className="experiment-lab">
      <h3 className="case-view__title">Experiment lab</h3>
      <p className="timeline__meta">
        Import a share-safe experiment package or summary. Agreement is not proof of
        correctness. A gold reference is a human benchmark decision, not an infallible truth
        claim. Gold alignment is scored separately from helpfulness.
      </p>
      {props.canWrite ? (
        <form className="composer" onSubmit={(event) => void importPackage(event)}>
          <textarea
            className="login__input"
            rows={6}
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            placeholder="Paste share-safe experiment package or summary JSON"
            required
          />
          <button className="login__submit" type="submit">
            Import experiment
          </button>
        </form>
      ) : null}
      {error ? <p className="experiment-lab__error">{error}</p> : null}
      {experiments.length > 1 ? (
        <ul className="case-list__items">
          {experiments.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => setActive(row.id)}>
                {row.packageId}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {current ? (
        <>
          <p className="timeline__meta">
            package {current.packageId} · task {current.taskFingerprint.slice(0, 12)} · snapshot{" "}
            {current.snapshotFingerprint.slice(0, 12)}
          </p>
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
          <table className="experiment-lab__matrix">
            <thead>
              <tr>
                <th>Candidate</th>
                <th>Role</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Cost</th>
                <th>Usage</th>
                <th>Helpfulness</th>
                <th>Gold</th>
              </tr>
            </thead>
            <tbody>
              {current.candidates.map((row) => (
                <tr key={row.candidateId}>
                  <td>{row.modelLabel}</td>
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
          <h4 className="experiment-lab__heading">Similarities and differences</h4>
          <p className="timeline__meta">{current.agreement.notes.join(" ")}</p>
          <ul className="timeline">
            {current.agreement.sharedAnchors.map((anchor) => (
              <li key={`${anchor.evidenceRef}:${anchor.role}`} className="timeline__item">
                Shared {anchor.evidenceRef} as {anchor.role} ({anchor.candidateIds.join(", ")})
              </li>
            ))}
            {current.agreement.candidateSpecific.map((row) => (
              <li key={row.candidateId} className="timeline__item">
                {row.candidateId} only: {row.evidenceRefs.join(", ") || "none"}
              </li>
            ))}
            {current.agreement.roleConflicts.map((row) => (
              <li key={row.evidenceRef} className="timeline__item">
                Role conflict on {row.evidenceRef}:{" "}
                {row.assignments.map((a) => `${a.candidateId}=${a.role}`).join("; ")}
              </li>
            ))}
          </ul>
          {props.canWrite ? (
            <form className="composer" onSubmit={(event) => void recordHelpfulness(event)}>
              <select className="login__input" name="candidateId" defaultValue={current.candidates[0]?.candidateId}>
                {current.candidates.map((row) => (
                  <option key={row.candidateId} value={row.candidateId}>
                    {row.modelLabel}
                  </option>
                ))}
              </select>
              <select className="login__input" name="dimension" defaultValue="evidence_support">
                <option value="evidence_support">evidence_support</option>
                <option value="actionability">actionability</option>
                <option value="uncertainty_calibration">uncertainty_calibration</option>
                <option value="unsafe_unsupported_claims">unsafe_unsupported_claims</option>
              </select>
              <input className="login__input" name="score" type="number" min={0} max={3} defaultValue={2} required />
              <input className="login__input" name="evidenceRefs" placeholder="evidence refs, comma separated" />
              <textarea className="login__input" name="rationale" rows={2} required placeholder="Helpfulness rationale" />
              <button className="login__submit" type="submit">
                Record helpfulness
              </button>
            </form>
          ) : null}
          <ul className="timeline">
            {current.observations.map((row) => (
              <li key={row.id} className="timeline__item">
                Helpfulness: {row.reviewerUsername} scored {row.candidateId} {row.dimension}{" "}
                {row.score}: {row.rationale}
              </li>
            ))}
          </ul>
          <h4 className="experiment-lab__heading">Gold alignment</h4>
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
          {props.canWrite ? (
            <form className="composer" onSubmit={(event) => void proposeDecision(event)}>
              <textarea className="login__input" name="text" rows={2} required placeholder="Proposed decision" />
              <textarea className="login__input" name="rationale" rows={2} required placeholder="Decision rationale" />
              <input className="login__input" name="evidenceRefs" placeholder="evidence refs, comma separated" />
              <button className="login__submit" type="submit">
                Propose decision
              </button>
            </form>
          ) : null}
          {current.decisions.length > 0 ? (
            <p className="timeline__meta">
              Latest decision r{current.decisions.at(-1)?.revision} ({current.decisions.at(-1)?.status}):{" "}
              {current.decisions.at(-1)?.text}
            </p>
          ) : null}
          {props.canLead && current.decisions.at(-1)?.status === "proposed" ? (
            <button className="login__submit" type="button" onClick={() => void acceptDecision()}>
              Accept decision
            </button>
          ) : null}
          {props.canLead && current.decisions.some((row) => row.status === "accepted") ? (
            <form className="composer" onSubmit={(event) => void promoteGold(event)}>
              <input
                className="login__input"
                name="evidenceAnchors"
                defaultValue="ev-demo-checkout-log, ev-demo-inventory-timeout"
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
          ) : null}
          {props.canLead ? (
            <button className="login__submit" type="button" onClick={() => void exportReview()}>
              Export share-safe review
            </button>
          ) : null}
          {exported ? <pre className="imported-run__text">{exported}</pre> : null}
        </>
      ) : null}
    </section>
  );
}
