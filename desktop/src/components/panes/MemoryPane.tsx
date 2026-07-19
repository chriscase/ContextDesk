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

  return (
    <div className="pane">
      <div className="pane__header">Memory</div>
      <div className="pane__toolbar" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", padding: "0.5rem" }}>
        <input
          className="field__control"
          style={{ flex: "1 1 8rem", minWidth: "6rem" }}
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search memories"
        />
        <select
          className="field__control"
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
        <label className="field__label" style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <input
            type="checkbox"
            checked={includeSuperseded}
            onChange={(e) => setIncludeSuperseded(e.target.checked)}
          />
          Include superseded
        </label>
      </div>
      <div className="pane__split">
        <ul className="session-list">
          {filtered.length === 0 ? (
            <li className="empty-state empty-state--inline">
              <div className="empty-state__title">No memories yet</div>
              <p className="empty-state__body">
                Durable memories appear here after{" "}
                <code>save_memory</code> (Accept). Ask the agent to remember a
                fact, or refresh after a save.
              </p>
              {onCreateHint ? (
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={onCreateHint}
                >
                  Refresh memory
                </button>
              ) : null}
            </li>
          ) : (
            filtered.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  className="session-list__item"
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
                  <span>{d.title || d.kind || "Memory"}</span>
                  {d.kind ? (
                    <span className="badge badge--muted"> {d.kind}</span>
                  ) : null}
                  {d.scope ? (
                    <span className="badge badge--muted"> {d.scope}</span>
                  ) : null}
                  {d.status && d.status !== "active" ? (
                    <span className="badge"> {d.status}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        {active ? (
          <div className="pane__editor">
            <div className="field__label">
              {active.path}
              {active.scope ? ` · ${active.scope}` : ""}
              {active.id ? ` · ${active.id.slice(0, 8)}…` : ""}
              {active.status ? ` · ${active.status}` : ""}
            </div>
            {active.status === "retracted" ? (
              <div className="callout callout--warn" role="status">
                Retracted (soft tombstone) — hidden from default recall; reversible.
                Permanent purge is a separate type-to-confirm operation.
              </div>
            ) : null}
            {active.redactionPreview && active.redactionPreview.length > 0 ? (
              <div className="callout callout--warn" role="status">
                Secrets redacted before save:{" "}
                {active.redactionPreview.join(", ")}
              </div>
            ) : null}
            <textarea
              className="field__control"
              rows={16}
              value={draft}
              readOnly={isDurable}
              onChange={(e) => {
                if (isDurable) return;
                setDraft(e.target.value);
                setDirty(true);
              }}
            />
            {isDurable ? (
              <>
                <p className="section-lead">
                  Store-backed memory. Hand-edit in Compose, or ask the agent to{" "}
                  <code>supersede_memory</code> / <code>retract_memory</code>.
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
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canSave}
                onClick={handleSave}
              >
                Save note
              </button>
            )}
          </div>
        ) : filtered.length > 0 ? null : (
          <div className="empty-state pane__editor">
            <div className="empty-state__title">Nothing selected</div>
            <p className="empty-state__body">
              Memories appear after the agent saves one with Accept, or when the
              host lists the durable store.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
