/**
 * The one Activity control, shared by ordinary chat and the Log Explorer.
 *
 * Unobtrusive by construction: it renders as a single small trigger showing
 * the current mode, and the four choices appear only when asked for. On a
 * normal screen it is one more chip in the header; nothing about it grows
 * with the amount of activity behind it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ACTIVITY_MODES, type ActivityMode } from "../../lib/activity/types";

const LABEL: Record<ActivityMode, string> = {
  off: "Off",
  compact: "Compact",
  drawer: "Drawer",
  docked: "Docked",
};

const DESCRIPTION: Record<ActivityMode, string> = {
  off: "Hide ContextDesk activity entirely. Does not change what the app does.",
  compact: "One quiet summary line per turn, with details on request.",
  drawer: "Open activity in an overlay panel when you ask for it.",
  docked: "Keep activity in a side rail beside your work.",
};

export function ActivityToggle({
  mode,
  onChange,
  label = "Activity",
}: {
  mode: ActivityMode;
  onChange: (mode: ActivityMode) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() =>
      menuRef.current
        ?.querySelector<HTMLButtonElement>(
          '.activity-toggle__option[aria-checked="true"]',
        )
        ?.focus(),
    );
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const placeMenu = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const margin = 8;
      const width = menuRect.width || 272;
      const height = menuRect.height || 240;
      const left = Math.min(
        Math.max(margin, triggerRect.right - width),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const below = triggerRect.bottom + 5;
      const top =
        below + height <= window.innerHeight - margin
          ? below
          : Math.max(margin, triggerRect.top - height - 5);
      setMenuPosition({ left, top });
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="activity-toggle"
      data-testid="activity-toggle"
    >
      <button
        ref={triggerRef}
        type="button"
        className="activity-toggle__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="activity-toggle-trigger"
        data-mode={mode}
        onClick={() => setOpen((v) => !v)}
        title={DESCRIPTION[mode]}
      >
        <span className="activity-toggle__label">{label}</span>
        <span className="activity-toggle__value">{LABEL[mode]}</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="activity-toggle__menu"
              role="menu"
              aria-label="Activity display"
              data-testid="activity-toggle-menu"
              style={menuPosition}
            >
              {ACTIVITY_MODES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === option}
                  className="activity-toggle__option"
                  data-testid={`activity-toggle-${option}`}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span className="activity-toggle__option-label">
                    {LABEL[option]}
                  </span>
                  <span className="activity-toggle__option-desc">
                    {DESCRIPTION[option]}
                  </span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
