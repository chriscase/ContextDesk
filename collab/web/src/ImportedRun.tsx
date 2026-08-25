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
}

export function ImportedRun(props: {
  run: ImportedRunView;
  /** Catalog entry matching run.sourceId; null when the id matches no loaded source. */
  source?: { id: string; name: string; kind: string } | null;
  linkOptions?: { id: string; label: string }[];
  canCorroborate: boolean;
  onCorroborate: (id: string, state: "corroborated" | "contradicted", linkId: string) => void;
}) {
  const run = props.run;
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
      tabIndex={-1}
      className={
        run.corroborationState === "contradicted"
          ? "imported-run imported-run--contradicted"
          : "imported-run"
      }
    >
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
      {run.sourceId || run.snapshotBinding || run.promptText || run.promptCompleteness || run.evidenceVisibility ? (
        <details className="triage-advanced imported-run__technical">
          <summary>Prompt and import details</summary>
          <p className="catalog__meta">
            Evidence access: {run.evidenceVisibility === "unknown" ? "not recorded" : "described by the importer"}
            {run.snapshotBinding ? " · tied to a frozen evidence set" : " · no frozen evidence set recorded"}
          </p>
          {run.promptText === null ? (
            <p className="catalog__meta">Original prompt was not recorded.</p>
          ) : (
            <>
              <p className="catalog__meta">Original prompt</p>
              <pre className="imported-run__text">{run.promptText}</pre>
            </>
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
      ) : null}
      <pre className="imported-run__text">{run.outputText}</pre>
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
