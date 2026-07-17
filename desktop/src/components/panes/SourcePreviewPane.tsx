type Props = {
  path: string | null;
  content: string;
  highlightLine?: number | null;
};

export function SourcePreviewPane({ path, content, highlightLine }: Props) {
  const lines = content.split("\n");
  return (
    <div className="pane">
      <div className="pane__header">Source preview</div>
      {!path ? (
        <p className="section-lead">Click a citation to open a file.</p>
      ) : (
        <>
          <div className="field__label mono">{path}</div>
          <pre className="tool-row__detail tool-row__detail--tall">
            {lines.map((line, i) => {
              const n = i + 1;
              const hi = highlightLine === n;
              return (
                <div key={n} className="source-line" data-hi={hi ? "true" : "false"}>
                  <span className="field__hint">{String(n).padStart(4, " ")}| </span>
                  {line}
                </div>
              );
            })}
          </pre>
        </>
      )}
    </div>
  );
}
