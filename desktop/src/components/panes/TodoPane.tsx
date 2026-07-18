import { useEffect, useRef, useState } from "react";
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

  return (
    <div className="pane">
      <div className="pane__header">Todos</div>
      <div className="field-row">
        <input
          className="field__control"
          placeholder="Add todo…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim()) {
              setItems((xs) => [
                ...xs,
                { id: crypto.randomUUID(), text: text.trim(), done: false },
              ]);
              setText("");
            }
          }}
        />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            if (!text.trim()) return;
            setItems((xs) => [
              ...xs,
              { id: crypto.randomUUID(), text: text.trim(), done: false },
            ]);
            setText("");
          }}
        >
          Add
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__title">No todos in this chat</div>
          <p className="empty-state__body">
            Track follow-ups for this session. Todos are stored per chat in this
            browser and do not sync to other machines.
          </p>
          <p className="field__hint">Type above and press Enter or Add.</p>
        </div>
      ) : (
        <ul className="session-list">
          {items.map((it) => (
            <li key={it.id} className="session-list__item todo-item">
              <input
                type="checkbox"
                checked={it.done}
                onChange={() =>
                  setItems((xs) =>
                    xs.map((x) =>
                      x.id === it.id ? { ...x, done: !x.done } : x,
                    ),
                  )
                }
              />
              <span
                className="todo-item__text"
                data-done={it.done ? "true" : "false"}
              >
                {it.text}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() =>
                  setItems((xs) => xs.filter((x) => x.id !== it.id))
                }
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
