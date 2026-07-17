import { useState } from "react";

export type MemoryDoc = {
  path: string;
  title: string;
  body: string;
};

type Props = {
  docs: MemoryDoc[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onSave: (path: string, body: string) => void;
};

export function MemoryPane({ docs, activePath, onSelect, onSave }: Props) {
  const active = docs.find((d) => d.path === activePath) ?? docs[0];
  const [draft, setDraft] = useState(active?.body ?? "");

  return (
    <div className="pane">
      <div className="pane__header">Memory</div>
      <div className="pane__split">
        <ul className="session-list">
          {docs.length === 0 ? (
            <li className="field__hint">No memory notes yet.</li>
          ) : (
            docs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  className="session-list__item"
                  data-active={d.path === (active?.path ?? "") ? "true" : "false"}
                  onClick={() => {
                    onSelect(d.path);
                    setDraft(d.body);
                  }}
                >
                  {d.title}
                </button>
              </li>
            ))
          )}
        </ul>
        {active ? (
          <div className="pane__editor">
            <div className="field__label">{active.path}</div>
            <textarea
              className="field__control"
              rows={16}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onSave(active.path, draft)}
            >
              Save note
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
