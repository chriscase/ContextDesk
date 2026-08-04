/**
 * The one Activity control, shared by ordinary chat and the Log Explorer.
 *
 * Unobtrusive by construction: it renders as a single small trigger showing
 * the current mode, and the four choices appear only when asked for. On a
 * normal screen it is one more chip in the header; nothing about it grows
 * with the amount of activity behind it.
 */
import { useEffect, useId, useRef, useState } from "react";
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
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
      rootRef.current
        ?.querySelector<HTMLButtonElement>(
          '.activity-toggle__option[aria-checked="true"]',
        )
        ?.focus(),
    );
  }, [open]);

  return (
    <div ref={rootRef} className="activity-toggle" data-testid="activity-toggle">
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
      {open ? (
        <div
          id={menuId}
          className="activity-toggle__menu"
          role="menu"
          aria-label="Activity display"
          data-testid="activity-toggle-menu"
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
        </div>
      ) : null}
    </div>
  );
}
