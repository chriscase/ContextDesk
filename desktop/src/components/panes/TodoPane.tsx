import { useEffect, useState } from "react";

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
};

type Props = {
  storageKey: string;
};

export function TodoPane({ storageKey }: Props) {
  const [items, setItems] = useState<TodoItem[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as TodoItem[]) : [];
    } catch {
      return [];
    }
  });
  const [text, setText] = useState("");

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(items));
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
      <ul className="session-list">
        {items.map((it) => (
          <li key={it.id} className="session-list__item todo-item">
            <input
              type="checkbox"
              checked={it.done}
              onChange={() =>
                setItems((xs) =>
                  xs.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)),
                )
              }
            />
            <span className="todo-item__text" data-done={it.done ? "true" : "false"}>
              {it.text}
            </span>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
