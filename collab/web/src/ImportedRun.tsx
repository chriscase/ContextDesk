interface ImportedRunView {
  id: string;
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
      {run.promptText === null ? (
        <p className="timeline__meta">Prompt unknown ({run.promptCompleteness})</p>
      ) : (
        <pre className="imported-run__text">{run.promptText}</pre>
      )}
      <pre className="imported-run__text">{run.outputText}</pre>
      {run.corroborationState === "unverified" ? (
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
