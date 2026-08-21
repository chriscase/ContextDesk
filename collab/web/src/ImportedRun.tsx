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
        importer {run.importerUsername} · operator {run.operatorUsername} · visibility{" "}
        {run.evidenceVisibility}
        {run.snapshotBinding ? ` · snapshot ${run.snapshotBinding}` : " · no package snapshot"}
      </p>
      {/* Attribution shows only what was recorded: the exact source id, plus catalog
          name/kind when that id matches a loaded source. A missing match stays explicit
          ("catalog metadata unavailable") — never guessed. */}
      {run.sourceId ? (
        <p className="catalog__meta">
          source <code>{run.sourceId}</code>
          {props.source ? (
            <>
              {" "}
              · {props.source.name} · kind {props.source.kind}
            </>
          ) : (
            <> · catalog metadata unavailable</>
          )}
        </p>
      ) : null}
      {run.promptText === null ? (
        <p className="timeline__meta">Prompt unknown ({run.promptCompleteness})</p>
      ) : (
        <pre className="imported-run__text">{run.promptText}</pre>
      )}
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
          <select className="login__input" name="state" defaultValue="corroborated">
            <option value="corroborated">corroborated</option>
            <option value="contradicted">contradicted</option>
          </select>
          <input className="login__input" name="linkId" placeholder="Evidence or contribution id" required />
          <button className="login__submit" type="submit">
            Record human judgment
          </button>
        </form>
      ) : null}
    </article>
  );
}
