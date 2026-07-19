import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadTodos,
  saveTodos,
  type TodoItem,
} from "../../lib/todoStorage";

type Props = {
  storageKey: string;
};

export function TodoPane({ storageKey }: Props) {
  const [items, setItems] = useState<TodoItem[]>(() => loadTodos(storageKey));
  const [text, setText] = useState("");
  /** Skip one persist after key switch so we never write old items into the new key (#157). */
  const skipPersist = useRef(false);
  const keyRef = useRef(storageKey);

  // Reload when session storage key changes.
  useEffect(() => {
    if (keyRef.current === storageKey) return;
    keyRef.current = storageKey;
    skipPersist.current = true;
    setItems(loadTodos(storageKey));
    setText("");
  }, [storageKey]);

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    saveTodos(storageKey, items);
  }, [items, storageKey]);

  const openCount = useMemo(
    () => items.filter((it) => !it.done).length,
    [items],
  );
  const doneCount = items.length - openCount;

  const add = () => {
    if (!text.trim()) return;
    setItems((xs) => [
      ...xs,
      { id: crypto.randomUUID(), text: text.trim(), done: false },
    ]);
    setText("");
  };

  const clearDone = () => {
    setItems((xs) => xs.filter((x) => !x.done));
  };

  return (
    <div className="pane pane--fill">
      <header className="pane-chrome">
        <h2 className="pane-chrome__title">Todos</h2>
        <div className="pane-chrome__meta" aria-live="polite">
          <span className="chip chip--static">
            {openCount} open
          </span>
          {doneCount > 0 ? (
            <span className="chip chip--static">{doneCount} done</span>
          ) : null}
        </div>
        <div className="pane-chrome__actions">
          {doneCount > 0 ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={clearDone}
            >
              Clear done
            </button>
          ) : null}
        </div>
      </header>

      <div className="todo-toolbar">
        <input
          className="field__control"
          placeholder="Add a follow-up…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          aria-label="New todo"
        />
        <button type="button" className="btn btn--primary" onClick={add}>
          Add
        </button>
      </div>

      {items.length === 0 ? (
        <div className="pane-empty">
          <div className="pane-empty__glyph pane-empty__glyph--todo" aria-hidden />
          <h3 className="pane-empty__title">No todos in this chat</h3>
          <p className="pane-empty__lead">
            Track follow-ups for this session. Stored per chat in this browser —
            not synced across machines.
          </p>
        </div>
      ) : (
        <ul className="todo-list" aria-label="Todo list">
          {items.map((it) => (
            <li key={it.id} className="todo-row">
              <input
                type="checkbox"
                className="todo-row__check"
                checked={it.done}
                onChange={() =>
                  setItems((xs) =>
                    xs.map((x) =>
                      x.id === it.id ? { ...x, done: !x.done } : x,
                    ),
                  )
                }
                aria-label={it.done ? "Mark incomplete" : "Mark done"}
              />
              <span
                className="todo-row__text"
                data-done={it.done ? "true" : "false"}
              >
                {it.text}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm todo-row__remove"
                onClick={() =>
                  setItems((xs) => xs.filter((x) => x.id !== it.id))
                }
                aria-label="Remove todo"
                title="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
