import { nextRovingIndex } from "../../lib/a11y";
import type { PaneId } from "../../lib/session";

const PANES: { id: PaneId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "archive", label: "Archive" },
  { id: "memory", label: "Memory" },
  { id: "compose", label: "Compose" },
  { id: "source", label: "Source" },
  { id: "todos", label: "Todos" },
  { id: "logs", label: "Logs" },
  { id: "harvest", label: "Harvest" },
];

type Props = {
  pane: PaneId;
  onChange: (p: PaneId) => void;
};

/** Main pane tablist (#146 / #149). */
export function PaneTabs({ pane, onChange }: Props) {
  return (
    <div
      className="pane-tabs"
      role="tablist"
      aria-label="Main panes"
      onKeyDown={(e) => {
        const order = PANES.map((p) => p.id);
        const idx = order.indexOf(pane);
        const next = nextRovingIndex(idx < 0 ? 0 : idx, order.length, e.key);
        if (next == null) return;
        e.preventDefault();
        onChange(order[next]);
        window.requestAnimationFrame(() => {
          document.getElementById(`pane-tab-${order[next]}`)?.focus();
        });
      }}
    >
      {PANES.map(({ id, label }) => (
        <button
          key={id}
          id={`pane-tab-${id}`}
          type="button"
          role="tab"
          aria-selected={pane === id}
          aria-controls={`pane-panel-${id}`}
          tabIndex={pane === id ? 0 : -1}
          data-active={pane === id ? "true" : "false"}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
