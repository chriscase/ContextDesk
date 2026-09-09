import { useEffect, useId, useRef, useState } from "react";

interface ImportedRunView {
  id: string;
  sourceId?: string;
  outputText: string;
  corroborationState: string;
  evidenceVisibility: string;
  snapshotBinding: string | null;
  importerUsername: string;
  operatorUsername: string;
  promptText: string | null;
  promptCompleteness: string;
  outputCompleteness?: string;
  workflowCompleteness?: string;
  visibilityNote?: string | null;
  provider?: string | null;
  model?: string | null;
  version?: string | null;
  claimedTraces?: string[];
  evidenceArtifactIds?: string[];
  uncertainty?: string | null;
  timing?: string | null;
  cost?: string | null;
  redacted?: boolean;
  privacyClass?: string;
  createdAt?: string;
}

function completenessLabel(value: string | undefined): string {
  if (value === "exact") return "Exact";
  if (value === "partial") return "Partial";
  return "Unknown";
}

function recordedValue(value: string | null | undefined): string {
  return value?.trim() ? value : "Not recorded";
}

function privacyLabel(value: string | undefined): string {
  if (value === "owner_only") return "Private to this case";
  if (value === "share_safe") return "Share safe";
  return "Not recorded";
}

function evidenceVisibilityLabel(value: string): string {
  return value === "importer_described"
    ? "Described by the importer"
    : "Unknown — not recorded";
}

function redactionLabel(value: boolean | undefined): string {
  if (value === true) {
    return "Importer recorded that secrets were redacted; ContextDesk did not verify that claim";
  }
  if (value === false) return "Importer recorded that secret redaction was not applied";
  return "Not recorded";
}

function timestampLabel(value: string | undefined): string {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Recorded time could not be interpreted" : parsed.toLocaleString();
}

export function ImportedRun(props: {
  run: ImportedRunView;
  /** Catalog entry matching run.sourceId; null when the id matches no loaded source. */
  source?: { id: string; name: string; kind: string } | null;
  linkOptions?: { id: string; label: string }[];
  focused?: boolean;
  canCorroborate: boolean;
  onCorroborate: (id: string, state: "corroborated" | "contradicted", linkId: string) => void;
}) {
  const run = props.run;
  const id = useId();
  const titleId = `${id}-title`;
  const provenanceId = `${id}-provenance`;
  const traceId = `${id}-traces`;
  const [provenanceOpen, setProvenanceOpen] = useState(Boolean(props.focused));
  const wasFocused = useRef(Boolean(props.focused));

  useEffect(() => {
    if (props.focused && !wasFocused.current) {
      setProvenanceOpen(true);
    }
    wasFocused.current = Boolean(props.focused);
  }, [props.focused]);
  const banner =
    run.corroborationState === "corroborated"
      ? "Corroborated by a human"
      : run.corroborationState === "contradicted"
        ? "Contradicted"
        : "Unverified imported run";
  return (
    <article
      data-route-item={run.id}
      data-route-kind="imported-run"
      data-focused={props.focused ? "true" : "false"}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={
        run.corroborationState === "contradicted"
          ? "imported-run imported-run--contradicted"
          : "imported-run"
      }
    >
      <header className="imported-run__head">
        <div>
          <p className="imported-run__eyebrow">Imported analysis</p>
          <h6 id={titleId} className="imported-run__title">
            {props.source ? props.source.name : "Recorded source unavailable"}
          </h6>
        </div>
        <span className="imported-run__privacy">{privacyLabel(run.privacyClass)}</span>
      </header>
      <p
        className={
          run.corroborationState === "unverified"
            ? "imported-run__banner"
            : run.corroborationState === "contradicted"
              ? "imported-run__banner imported-run__banner--contradicted"
              : "imported-run__banner imported-run__banner--ok"
        }
      >
        {banner}
      </p>
      <p className="imported-run__caveat">
        Imported output and its metadata are recorded context, not a verified finding.
      </p>
      <p className="timeline__meta">
        Imported by {run.importerUsername}
        {run.operatorUsername !== run.importerUsername ? ` · run by ${run.operatorUsername}` : ""}
      </p>
      {/* The primary line uses recognizable catalog metadata. Exact storage identities
          remain available below for audit/debug work, never substituted or guessed. */}
      {run.sourceId ? (
        <p className="catalog__meta">
          {props.source ? (
            <>
              From {props.source.name}
            </>
          ) : (
            <>Recorded source metadata unavailable</>
          )}
        </p>
      ) : null}
      <details
        className="triage-advanced imported-run__technical"
        open={provenanceOpen}
        onToggle={(event) => setProvenanceOpen(event.currentTarget.open)}
      >
          <summary>Inspect recorded provenance</summary>
          <p id={provenanceId} className="imported-run__guidance">
            Completeness, tool, timing, cost, visibility, and trace values below were recorded with
            the import. They are not independently verified by ContextDesk.
          </p>
          <dl className="imported-run__facts" aria-describedby={provenanceId}>
            <div><dt>Prompt coverage</dt><dd>{completenessLabel(run.promptCompleteness)}</dd></div>
            <div><dt>Output coverage</dt><dd>{completenessLabel(run.outputCompleteness)}</dd></div>
            <div><dt>Workflow coverage</dt><dd>{completenessLabel(run.workflowCompleteness)}</dd></div>
            <div><dt>Evidence visibility</dt><dd>{evidenceVisibilityLabel(run.evidenceVisibility)}</dd></div>
            <div>
              <dt>Frozen evidence</dt>
              <dd>{run.snapshotBinding ? "Snapshot binding recorded" : "No snapshot binding recorded"}</dd>
            </div>
            <div>
              <dt>Evidence items</dt>
              <dd>
                {run.evidenceArtifactIds === undefined
                  ? "Not recorded"
                  : `${run.evidenceArtifactIds.length} item${run.evidenceArtifactIds.length === 1 ? "" : "s"} recorded`}
              </dd>
            </div>
            <div><dt>Imported by</dt><dd>{recordedValue(run.importerUsername)}</dd></div>
            <div><dt>Run by</dt><dd>{recordedValue(run.operatorUsername)}</dd></div>
            <div>
              <dt>Tool identity</dt>
              <dd>{recordedValue([run.provider, run.model, run.version].filter((value) => value?.trim()).join(" · "))}</dd>
            </div>
            <div><dt>Imported at</dt><dd>{timestampLabel(run.createdAt)}</dd></div>
            <div><dt>Run timing</dt><dd>{recordedValue(run.timing)}</dd></div>
            <div><dt>Recorded cost</dt><dd>{recordedValue(run.cost)}</dd></div>
            <div><dt>Privacy</dt><dd>{privacyLabel(run.privacyClass)}</dd></div>
            <div>
              <dt>Secret redaction</dt>
              <dd>{redactionLabel(run.redacted)}</dd>
            </div>
          </dl>
          {run.visibilityNote?.trim() ? (
            <p className="imported-run__note"><strong>Recorded visibility note:</strong> {run.visibilityNote}</p>
          ) : null}
          {run.uncertainty?.trim() ? (
            <p className="imported-run__note"><strong>Recorded uncertainty:</strong> {run.uncertainty}</p>
          ) : (
            <p className="imported-run__note"><strong>Recorded uncertainty:</strong> None recorded</p>
          )}
          <section className="imported-run__trace-section" aria-labelledby={traceId}>
            <h6 id={traceId}>Claimed traces — not independently verified</h6>
            {run.claimedTraces && run.claimedTraces.length > 0 ? (
              <ul className="imported-run__traces">
                {run.claimedTraces.map((trace, index) => <li key={`${trace}-${index}`}>{trace}</li>)}
              </ul>
            ) : (
              <p>No claimed traces were recorded.</p>
            )}
          </section>
          {run.promptText === null ? (
            <p className="imported-run__note">Original prompt was not recorded.</p>
          ) : (
            <section className="imported-run__prompt" aria-label="Recorded prompt">
              <h6>Original prompt</h6>
              <pre className="imported-run__text">{run.promptText}</pre>
            </section>
          )}
          {run.sourceId ? (
            <p className="catalog__meta">
              Recorded source ID: <code>{run.sourceId}</code>
            </p>
          ) : null}
          {run.snapshotBinding ? (
            <p className="catalog__meta">
              Snapshot binding: <code>{run.snapshotBinding}</code>
            </p>
          ) : null}
      </details>
      <section className="imported-run__output" aria-label="Imported output">
        <h6>Imported output</h6>
        <pre className="imported-run__text">{run.outputText}</pre>
      </section>
      {props.canCorroborate && run.corroborationState === "unverified" ? (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const state = String(data.get("state"));
            const linkId = String(data.get("linkId") ?? "");
            if ((state === "corroborated" || state === "contradicted") && linkId) {
              props.onCorroborate(run.id, state, linkId);
            }
          }}
        >
          <select className="login__input" name="state" defaultValue="corroborated" aria-label="Human review result">
            <option value="corroborated">Supported by the linked record</option>
            <option value="contradicted">Contradicted by the linked record</option>
          </select>
          <select className="login__input" name="linkId" aria-label="Supporting record" required defaultValue="">
            <option value="" disabled>Choose a note or evidence item</option>
            {(props.linkOptions ?? []).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          {(props.linkOptions ?? []).length === 0 ? (
            <p className="triage-capture__hint">Add a human note or evidence item before reviewing this analysis.</p>
          ) : null}
          <button className="login__submit" type="submit">
            Save review
          </button>
        </form>
      ) : null}
    </article>
  );
}
