import { useEffect, useRef } from "react";

type Props = {
  path: string | null;
  content: string;
  highlightLine?: number | null;
};

export function SourcePreviewPane({ path, content, highlightLine }: Props) {
  const lines = content.length ? content.split("\n") : [];
  const hiRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlightLine != null && hiRef.current) {
      hiRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlightLine, path, content]);

  const basename = path
    ? (path.split(/[/\\]/).pop() ?? path)
    : null;

  return (
    <div className="pane pane--fill">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Source</h2>
        <div className="pane-chrome__meta">
          {path ? (
            <>
              <span className="chip chip--kind chip--static">File</span>
              <span className="chip chip--mono chip--static" title={path}>
                {basename}
              </span>
              {highlightLine != null ? (
                <span className="chip chip--static">L{highlightLine}</span>
              ) : null}
              <span className="chip chip--static">
                {lines.length} {lines.length === 1 ? "line" : "lines"}
              </span>
            </>
          ) : (
            <span className="chip chip--static">No file open</span>
          )}
        </div>
      </header>

      {!path ? (
        <div className="pane-empty">
          <div
            className="pane-empty__glyph pane-empty__glyph--source"
            aria-hidden
          />
          <h3 className="pane-empty__title">No source open</h3>
          <p className="pane-empty__lead">
            Click a file citation in chat (or a search-trail hit) to open it
            here with optional line highlight.
          </p>
        </div>
      ) : (
        <div className="source-view">
          <div className="source-view__head">
            <span className="source-view__path" title={path}>
              {path}
            </span>
          </div>
          <pre className="source-view__code" tabIndex={0}>
            {lines.map((line, i) => {
              const n = i + 1;
              const hi = highlightLine === n;
              return (
                <div
                  key={n}
                  ref={hi ? hiRef : undefined}
                  className="source-line"
                  data-hi={hi ? "true" : "false"}
                >
                  <span className="source-line__n" aria-hidden>
                    {n}
                  </span>
                  <span className="source-line__t">{line || " "}</span>
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
