import { useEffect, useMemo, useState } from "react";

export type MemoryDoc = {
  path: string;
  title: string;
  body: string;
  /** Durable store id when reading from MemoryStore (Phase 1). */
  id?: string;
  /** Kind taxonomy string (fact, decision, …). */
  kind?: string;
  /** personal | workspace */
  scope?: string;
  /** status: active | superseded | retracted | … */
  status?: string;
  /** Accept preview: redaction classes applied before persist. */
  redactionPreview?: string[];
};

type Props = {
  docs: MemoryDoc[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onSave: (path: string, body: string) => void;
  /** Optional: start a new note from empty state. */
  onCreateHint?: () => void;
  /** Request include_superseded listing from host (durable store). */
  onFilterChange?: (opts: {
    kind: string | null;
    includeSuperseded: boolean;
  }) => void;
  /** Open selected memory in Composition pane (#293). */
  onCompose?: (doc: MemoryDoc) => void;
};

const KIND_OPTIONS = [
  { value: "", label: "All kinds" },
  { value: "fact", label: "Fact" },
  { value: "decision", label: "Decision" },
  { value: "bookmark", label: "Bookmark" },
  { value: "preference", label: "Preference" },
  { value: "project_note", label: "Project note" },
  { value: "contact", label: "Contact" },
  { value: "term", label: "Term" },
  { value: "task", label: "Task" },
];

function kindLabel(kind: string): string {
  return KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

function snippet(body: string, max = 90): string {
  const t = body.replace(/\s+/g, " ").trim();
  if (!t) return "Empty body";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function MemoryPane({
  docs,
  activePath,
  onSelect,
  onSave,
  onCreateHint,
  onFilterChange,
  onCompose,
}: Props) {
  const [kindFilter, setKindFilter] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    let list = docs;
    if (kindFilter) {
      list = list.filter((d) => (d.kind ?? "") === kindFilter);
    }
    if (!includeSuperseded) {
      list = list.filter(
        (d) => !d.status || d.status === "active" || d.status === undefined,
      );
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.body.toLowerCase().includes(q) ||
          (d.kind ?? "").includes(q),
      );
    }
    return list;
  }, [docs, kindFilter, includeSuperseded, query]);

  const active =
    filtered.find((d) => d.path === activePath) ??
    docs.find((d) => d.path === activePath) ??
    filtered[0] ??
    null;
  const [draft, setDraft] = useState(active?.body ?? "");
  const [dirty, setDirty] = useState(false);
  const [syncedPath, setSyncedPath] = useState<string | null>(
    active?.path ?? null,
  );

  const isDurable = Boolean(active?.id || active?.path.startsWith("memory:"));
  const hasFilters = Boolean(kindFilter || query.trim() || includeSuperseded);

  // Re-sync draft when active doc path/body changes externally, unless dirty (#157).
  useEffect(() => {
    if (!active) {
      if (!dirty) {
        setDraft("");
        setSyncedPath(null);
      }
      return;
    }
    const pathChanged = active.path !== syncedPath;
    if (pathChanged) {
      setDraft(active.body);
      setDirty(false);
      setSyncedPath(active.path);
      return;
    }
    if (!dirty && draft !== active.body) {
      setDraft(active.body);
    }
  }, [active?.path, active?.body, active, dirty, draft, syncedPath]);

  useEffect(() => {
    onFilterChange?.({
      kind: kindFilter || null,
      includeSuperseded,
    });
  }, [kindFilter, includeSuperseded, onFilterChange]);

  const canSave = Boolean(active) && dirty && !isDurable;

  const handleSave = () => {
    if (!active || isDurable) return;
    if (!dirty && !draft.trim() && active.body.trim()) {
      return;
    }
    if (!dirty) return;
    onSave(active.path, draft);
    setDirty(false);
  };

  const emptyStore = docs.length === 0;
  const emptyFilter = !emptyStore && filtered.length === 0;

  return (
    <div className="pane pane--fill">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Memory</h2>
        <div className="pane-chrome__meta" aria-live="polite">
          <span className="chip chip--static">
            {filtered.length}
            {filtered.length !== docs.length ? ` / ${docs.length}` : ""}{" "}
            {filtered.length === 1 ? "item" : "items"}
          </span>
          {dirty ? (
            <span className="chip" data-tone="warn">
              Unsaved
            </span>
          ) : null}
        </div>
        <div className="pane-chrome__actions">
          {onCreateHint ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onCreateHint}
            >
              Refresh
            </button>
          ) : null}
          {onCompose ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() =>
                onCompose({
                  path: "",
                  title: "Untitled draft",
                  body: "",
                })
              }
            >
              New draft
            </button>
          ) : null}
        </div>
      </header>

      <div className="pane__toolbar">
        <input
          className="field__control"
          placeholder="Search memories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search memories"
        />
        <select
          className="field__control field__control--select"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          aria-label="Filter by kind"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value || "all"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <label className="pane__toolbar-toggle">
          <input
            type="checkbox"
            checked={includeSuperseded}
            onChange={(e) => setIncludeSuperseded(e.target.checked)}
          />
          Superseded
        </label>
      </div>

      {emptyStore ? (
        <div className="pane-empty">
          <div className="pane-empty__glyph pane-empty__glyph--memory" aria-hidden />
          <h3 className="pane-empty__title">No memories yet</h3>
          <p className="pane-empty__lead">
            Durable memories appear after the agent saves one with Accept, or
            when you draft in Compose.
          </p>
          <div className="pane-empty__actions">
            {onCompose ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  onCompose({
                    path: "",
                    title: "Untitled draft",
                    body: "",
                  })
                }
              >
                Open Compose
              </button>
            ) : null}
            {onCreateHint ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onCreateHint}
              >
                Refresh store
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="pane__split pane__split--memory">
          <ul className="mem-list" aria-label="Memory list">
            {emptyFilter ? (
              <li className="mem-list__empty">
                <div className="empty-state__title">No matches</div>
                <p className="empty-state__body">
                  {hasFilters
                    ? "Try clearing search or filters."
                    : "Nothing to show."}
                </p>
              </li>
            ) : (
              filtered.map((d) => (
                <li key={d.path}>
                  <button
                    type="button"
                    className="mem-list__item"
                    data-active={
                      d.path === (active?.path ?? "") ? "true" : "false"
                    }
                    onClick={() => {
                      onSelect(d.path);
                      setDraft(d.body);
                      setDirty(false);
                      setSyncedPath(d.path);
                    }}
                  >
                    <span className="mem-list__title">
                      {d.title || d.kind || "Memory"}
                    </span>
                    <span className="mem-list__snippet">{snippet(d.body)}</span>
                    <span className="mem-list__meta">
                      {d.kind ? (
                        <span className="chip chip--kind chip--static">
                          {kindLabel(d.kind)}
                        </span>
                      ) : null}
                      {d.scope ? (
                        <span className="chip chip--static">{d.scope}</span>
                      ) : null}
                      {d.status && d.status !== "active" ? (
                        <span className="chip chip--static" data-tone="warn">
                          {d.status}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>

          {active ? (
            <div className="mem-detail">
              <div className="mem-detail__head">
                <h3 className="mem-detail__title">
                  {active.title || active.kind || "Memory"}
                </h3>
                {active.kind ? (
                  <span className="chip chip--kind chip--static">
                    {kindLabel(active.kind)}
                  </span>
                ) : null}
                {active.scope ? (
                  <span className="chip chip--static">{active.scope}</span>
                ) : null}
                {active.id ? (
                  <span className="chip chip--mono chip--static" title={active.id}>
                    {active.id.slice(0, 8)}…
                  </span>
                ) : (
                  <span className="chip chip--mono chip--static" title={active.path}>
                    file
                  </span>
                )}
                {active.status && active.status !== "active" ? (
                  <span className="chip chip--static" data-tone="warn">
                    {active.status}
                  </span>
                ) : null}
                {dirty ? (
                  <span className="chip" data-tone="warn">
                    Unsaved
                  </span>
                ) : null}
              </div>
              {active.status === "retracted" ? (
                <div className="callout callout--warn" role="status">
                  Retracted (soft tombstone) — hidden from default recall;
                  reversible. Permanent purge is a separate type-to-confirm
                  operation.
                </div>
              ) : null}
              {active.redactionPreview && active.redactionPreview.length > 0 ? (
                <div className="callout callout--warn" role="status">
                  Secrets redacted before save:{" "}
                  {active.redactionPreview.join(", ")}
                </div>
              ) : null}
              <label className="sr-only" htmlFor="memory-body">
                Memory body
              </label>
              <textarea
                id="memory-body"
                className="mem-detail__body"
                value={draft}
                readOnly={isDurable}
                onChange={(e) => {
                  if (isDurable) return;
                  setDraft(e.target.value);
                  setDirty(true);
                }}
              />
              <footer className="mem-detail__footer">
                {isDurable ? (
                  <>
                    <p className="mem-detail__hint">
                      Store-backed — hand-edit in Compose, or ask the agent to
                      supersede / retract.
                    </p>
                    {onCompose ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => onCompose(active)}
                      >
                        Compose / edit
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="mem-detail__hint">
                      Workspace file note — Save writes the markdown file.
                    </p>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={!canSave}
                      onClick={handleSave}
                    >
                      Save note
                    </button>
                  </>
                )}
              </footer>
            </div>
          ) : (
            <div className="pane-empty">
              <div
                className="pane-empty__glyph pane-empty__glyph--memory"
                aria-hidden
              />
              <h3 className="pane-empty__title">Nothing selected</h3>
              <p className="pane-empty__lead">
                Pick a memory from the list to inspect, or open Compose to draft
                a new one.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
