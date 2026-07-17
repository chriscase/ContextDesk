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
          <pre className="tool-row__detail" style={{ maxHeight: "60vh" }}>
            {lines.map((line, i) => {
              const n = i + 1;
              const hi = highlightLine === n;
              return (
                <div
                  key={n}
                  style={{
                    background: hi ? "var(--accent-soft)" : undefined,
                  }}
                >
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
