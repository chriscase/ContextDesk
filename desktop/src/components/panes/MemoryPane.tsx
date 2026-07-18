import { useEffect, useState } from "react";

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
};

export function MemoryPane({
  docs,
  activePath,
  onSelect,
  onSave,
  onCreateHint,
}: Props) {
  const active = docs.find((d) => d.path === activePath) ?? docs[0] ?? null;
  const [draft, setDraft] = useState(active?.body ?? "");
  const [dirty, setDirty] = useState(false);
  const [syncedPath, setSyncedPath] = useState<string | null>(
    active?.path ?? null,
  );

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
    // Same path, body updated externally (e.g. agent save_memory refresh)
    if (!dirty && draft !== active.body) {
      setDraft(active.body);
    }
  }, [active?.path, active?.body, active, dirty, draft, syncedPath]);

  const canSave = Boolean(active) && dirty;

  const handleSave = () => {
    if (!active) return;
    // Never overwrite a non-empty loaded note with empty stale draft (#157).
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
      <div className="pane__split">
        <ul className="session-list">
          {docs.length === 0 ? (
            <li className="empty-state empty-state--inline">
              <div className="empty-state__title">No memory notes yet</div>
              <p className="empty-state__body">
                Project notes live here. Ask the agent to{" "}
                <code>save_memory</code>, or open Settings → Workspace first.
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
            docs.map((d) => (
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
                  <span>{d.title}</span>
                  {d.kind ? (
                    <span className="badge badge--muted"> {d.kind}</span>
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
            </div>
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
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(true);
              }}
            />
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canSave}
              onClick={handleSave}
            >
              Save note
            </button>
          </div>
        ) : docs.length > 0 ? null : (
          <div className="empty-state pane__editor">
            <div className="empty-state__title">Nothing selected</div>
            <p className="empty-state__body">
              Memory notes appear after the agent saves one, or when the host
              lists existing files under the workspace memory folder.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
