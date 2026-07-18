/**
 * Command palette (#154): fuzzy actions + sessions; arrows/Enter/Escape; focus trap.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { trapTabKey } from "../lib/a11y";
import {
  filterPaletteItems,
  type PaletteItem,
} from "../lib/commandPalette";

export type CommandPaletteProps = {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  onSelect: (id: string) => void;
};

export function CommandPalette({
  open,
  items,
  onClose,
  onSelect,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const listId = useId();

  const filtered = useMemo(
    () => filterPaletteItems(items, query),
    [items, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[active];
        if (item) onSelect(item.id);
        return;
      }
      if (panelRef.current) {
        trapTabKey(e, panelRef.current, document.activeElement);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose, onSelect, filtered, active]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="cmd-palette-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <div className="cmd-palette__head">
          <h2 id={titleId} className="cmd-palette__title">
            Command palette
          </h2>
          <input
            ref={inputRef}
            className="cmd-palette__input"
            type="search"
            placeholder="Type a command or chat…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
          />
        </div>
        <ul
          id={listId}
          className="cmd-palette__list"
          role="listbox"
          aria-label="Commands"
        >
          {filtered.length === 0 ? (
            <li className="cmd-palette__empty">No matches</li>
          ) : (
            filtered.map((item, i) => (
              <li key={item.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className="cmd-palette__item"
                  data-active={i === active ? "true" : "false"}
                  data-group={item.group}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="cmd-palette__label">{item.label}</span>
                  {item.detail ? (
                    <span className="cmd-palette__detail">{item.detail}</span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <footer className="cmd-palette__foot">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>
  );
}
