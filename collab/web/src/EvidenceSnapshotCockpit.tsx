import { useEffect, useRef, useState } from "react";

export interface CockpitSnapshot {
  id: string;
  fingerprint: string;
  evidence: { evidenceId: string; verificationStatus?: string | null }[];
  createdBy?: string;
  createdAt?: string;
  status?: string;
  visibility?: string;
  parentSnapshotId?: string | null;
  protocolVersion?: string;
}

export interface CockpitRun {
  id: string;
  status: string;
  snapshotId: string;
  snapshotFingerprint: string;
  sameSnapshot: boolean | null;
  request: { strategyId: string };
}

type FairnessVerdict =
  | { kind: "none" }
  | { kind: "single" }
  | { kind: "controlled"; runCount: number }
  | { kind: "mismatch"; explicitMismatch: boolean; distinctFingerprints: number }
  | { kind: "pending" };

function shortToken(value: string | null | undefined): string {
  return value ? `${value.slice(0, 12)}…` : "not available";
}

function statusText(status: string): string {
  return status.replaceAll("_", " ");
}

/**
 * Evidence-fairness verdict for a set of selected runs. "Controlled" requires
 * positive evidence: every run must carry an explicit same-snapshot proof AND
 * an exact, identical fingerprint. Anything less is mismatch (on explicit
 * contrary evidence) or unknown — never assumed fair.
 */
function fairnessVerdict(runs: CockpitRun[]): FairnessVerdict {
  if (runs.length === 0) return { kind: "none" };
  if (runs.length === 1) return { kind: "single" };
  const explicitMismatch = runs.some((run) => run.sameSnapshot === false);
  const fingerprints = runs
    .map((run) => run.snapshotFingerprint)
    .filter((fingerprint): fingerprint is string => typeof fingerprint === "string" && fingerprint.length > 0);
  const distinct = new Set(fingerprints).size;
  if (explicitMismatch || distinct > 1) {
    return { kind: "mismatch", explicitMismatch, distinctFingerprints: distinct };
  }
  if (
    runs.every((run) => run.sameSnapshot === true)
    && fingerprints.length === runs.length
    && distinct === 1
  ) {
    return { kind: "controlled", runCount: runs.length };
  }
  return { kind: "pending" };
}

function proofText(sameSnapshot: boolean | null): string {
  if (sameSnapshot === true) return "same-snapshot proof recorded";
  if (sameSnapshot === false) return "explicit mismatch recorded";
  return "proof pending or unavailable";
}

function frozenAtText(createdAt: string | undefined): string {
  if (!createdAt) return "unknown";
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(createdAt)
    ? `${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`
    : createdAt;
}

function mismatchReason(verdict: Extract<FairnessVerdict, { kind: "mismatch" }>): string {
  if (verdict.explicitMismatch && verdict.distinctFingerprints > 1) {
    return "These runs recorded an explicit snapshot mismatch and their evidence fingerprints differ.";
  }
  if (verdict.distinctFingerprints > 1) {
    return "The selected runs carry different exact evidence fingerprints.";
  }
  return "At least one selected run recorded an explicit snapshot mismatch.";
}

export function EvidenceSnapshotCockpit(props: {
  snapshots: CockpitSnapshot[];
  selectedRuns: CockpitRun[];
  finishedRunCount: number;
  focusSnapshotId: string;
  canAct: boolean;
}) {
  const { snapshots, selectedRuns } = props;
  const [inspectedId, setInspectedId] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle");
  const lastFocus = useRef(props.focusSnapshotId);

  // The launcher's snapshot selection (and "Use this setup again") stays the
  // source of truth: whenever it changes, the cockpit re-syncs to it.
  useEffect(() => {
    if (props.focusSnapshotId !== lastFocus.current) {
      lastFocus.current = props.focusSnapshotId;
      setInspectedId("");
    }
  }, [props.focusSnapshotId]);

  const inspected = snapshots.find((snapshot) => snapshot.id === inspectedId)
    ?? snapshots.find((snapshot) => snapshot.id === props.focusSnapshotId)
    ?? snapshots.at(-1);
  const inspectedKey = inspected?.id ?? "";
  useEffect(() => {
    setCopyState("idle");
  }, [inspectedKey]);

  const verdict = fairnessVerdict(selectedRuns);

  function snapshotRef(snapshotId: string, fingerprint: string): string {
    const index = snapshots.findIndex((snapshot) => snapshot.id === snapshotId);
    return index >= 0
      ? `S${index} (${shortToken(fingerprint)})`
      : `not in the visible snapshot list (${shortToken(fingerprint)})`;
  }

  async function copyFingerprint(fingerprint: string) {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setCopyState("unavailable");
      return;
    }
    try {
      await clipboard.writeText(fingerprint);
      setCopyState("copied");
    } catch {
      setCopyState("unavailable");
    }
  }

  const verificationKnown = inspected
    ? inspected.evidence.filter((item) => item.verificationStatus !== undefined && item.verificationStatus !== null)
    : [];
  const verifiedCount = verificationKnown.filter((item) => item.verificationStatus === "verified").length;
  const parentValue = inspected
    ? inspected.parentSnapshotId === undefined
      ? "unknown"
      : inspected.parentSnapshotId === null
        ? "none — root snapshot"
        : snapshotRef(
          inspected.parentSnapshotId,
          snapshots.find((snapshot) => snapshot.id === inspected.parentSnapshotId)?.fingerprint ?? "",
        )
    : "unknown";

  return (
    <section className="snapshot-cockpit" aria-labelledby="snapshot-cockpit-heading">
      <div className="snapshot-cockpit__header">
        <p className="case-memory__eyebrow">Evidence fairness</p>
        <h4 id="snapshot-cockpit-heading">Evidence snapshot cockpit</h4>
        <p className="case-memory__note">
          Every run is bound to one frozen evidence snapshot. This cockpit shows which
          snapshot each selected run used and whether a side-by-side read is evidence-fair.
          Evidence fairness is separate from model conclusions: identical evidence makes
          runs comparable — it does not make any lane&apos;s answer correct, and matching
          answers are not proof either.
        </p>
      </div>
      <div aria-live="polite">
        <div className={`snapshot-cockpit__verdict snapshot-cockpit__verdict--${
          verdict.kind === "controlled" ? "controlled"
            : verdict.kind === "mismatch" ? "mismatch"
              : verdict.kind === "pending" ? "pending"
                : "guide"
        }`}
        >
          {verdict.kind === "controlled" ? (
            <>
              <strong>Controlled comparison — same frozen evidence.</strong>
              <p>
                All {verdict.runCount} selected runs carry an explicit same-snapshot proof and
                identical exact evidence fingerprints. Differences between lanes reflect the
                models and settings, not what each run could see.
              </p>
            </>
          ) : null}
          {verdict.kind === "mismatch" ? (
            <>
              <strong>Evidence mismatch — not a fair head-to-head.</strong>
              <p>
                {mismatchReason(verdict)} When runs read different frozen evidence, a
                difference in their conclusions can come from the evidence rather than the
                models, so treat any side-by-side read as exploratory.
              </p>
              <p>
                {props.canAct
                  ? "Restore a fair comparison with existing controls: press “Use this setup again” on the run whose snapshot you trust — it preselects that exact snapshot in the launcher — then relaunch the other lane setups while keeping that Snapshot selection."
                  : "A case lead can restore fairness by relaunching the lane setups against one chosen snapshot; runs proved against the same fingerprint become directly comparable."}
              </p>
            </>
          ) : null}
          {verdict.kind === "pending" ? (
            <>
              <strong>Fairness unknown — snapshot proof incomplete.</strong>
              <p>
                At least one selected run is missing a settled same-snapshot proof or an exact
                evidence fingerprint. Until every run reports its proof, this comparison stays
                unknown rather than fair.
              </p>
            </>
          ) : null}
          {verdict.kind === "single" ? (
            <>
              <strong>One run selected.</strong>
              <p>
                A fairness verdict compares at least two runs. Select a second finished run in
                “Compare finished runs” to check whether both read the same frozen evidence.
              </p>
            </>
          ) : null}
          {verdict.kind === "none" ? (
            <>
              <strong>
                {props.finishedRunCount >= 2
                  ? "No runs selected yet."
                  : props.finishedRunCount === 1
                    ? "Not enough finished runs."
                    : "No finished runs yet."}
              </strong>
              <p>
                {props.finishedRunCount >= 2
                  ? "Select two or more finished runs in “Compare finished runs” to get an evidence-fairness verdict."
                  : props.finishedRunCount === 1
                    ? "A fairness verdict needs at least two finished runs; this case has one so far."
                    : "Once runs finish, select them in “Compare finished runs” to check evidence fairness."}
              </p>
            </>
          ) : null}
        </div>
      </div>
      {selectedRuns.length > 0 ? (
        <div>
          <h5 id="snapshot-cockpit-bindings-heading">Selected run evidence bindings</h5>
          <ul className="snapshot-cockpit__runs" aria-labelledby="snapshot-cockpit-bindings-heading">
            {selectedRuns.map((run) => (
              <li className="snapshot-cockpit__run" key={run.id}>
                <strong>{run.request.strategyId}</strong>
                <span>
                  {statusText(run.status)} · snapshot {snapshotRef(run.snapshotId, run.snapshotFingerprint)} · {proofText(run.sameSnapshot)}
                </span>
                {snapshots.some((snapshot) => snapshot.id === run.snapshotId) ? (
                  <button
                    className="case-memory__secondary-button"
                    type="button"
                    aria-label={`Inspect snapshot for run ${run.id}`}
                    onClick={() => setInspectedId(run.snapshotId)}
                  >
                    Inspect snapshot
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {inspected ? (
        <div className="snapshot-cockpit__identity">
          <div className="snapshot-cockpit__identity-header">
            <h5>Snapshot under inspection</h5>
            {snapshots.length > 1 ? (
              <select
                aria-label="Snapshot under inspection"
                value={inspected.id}
                onChange={(event) => setInspectedId(event.target.value)}
              >
                {snapshots.map((snapshot, index) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    S{index} · {snapshot.evidence.length} evidence · {shortToken(snapshot.fingerprint)}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <p className="snapshot-cockpit__fingerprint-label" id="snapshot-cockpit-fingerprint-label">
            Exact evidence fingerprint
          </p>
          <div className="snapshot-cockpit__fingerprint-row">
            <code
              className="snapshot-cockpit__fingerprint"
              aria-labelledby="snapshot-cockpit-fingerprint-label"
            >
              {inspected.fingerprint}
            </code>
            <button
              className="case-memory__secondary-button"
              type="button"
              aria-label="Copy snapshot fingerprint"
              onClick={() => void copyFingerprint(inspected.fingerprint)}
            >
              Copy
            </button>
          </div>
          {copyState !== "idle" ? (
            <p className="snapshot-cockpit__copy-note" role="status">
              {copyState === "copied"
                ? "Fingerprint copied to the clipboard."
                : "Clipboard copy is unavailable here — the fingerprint text is selectable for manual copy."}
            </p>
          ) : null}
          <dl className="snapshot-cockpit__meta">
            <div>
              <dt>Evidence items</dt>
              <dd>
                {inspected.evidence.length}
                {verificationKnown.length > 0 ? ` · ${verifiedCount} verified` : ""}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{inspected.status ? statusText(inspected.status) : "unknown"}</dd>
            </div>
            <div>
              <dt>Visibility</dt>
              <dd>{inspected.visibility ? statusText(inspected.visibility) : "unknown"}</dd>
            </div>
            <div>
              <dt>Created by</dt>
              <dd>{inspected.createdBy || "unknown"}</dd>
            </div>
            <div>
              <dt>Frozen at</dt>
              <dd>{frozenAtText(inspected.createdAt)}</dd>
            </div>
            <div>
              <dt>Parent snapshot</dt>
              <dd>{parentValue}</dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>{inspected.protocolVersion ?? "unknown"}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="case-memory__empty">
          Snapshot details unavailable — no frozen snapshots were returned for this case.
        </p>
      )}
    </section>
  );
}
