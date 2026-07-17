import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconHelp } from "./icons";

export type HelpTipProps = {
  /** Short accessible name for the control, e.g. "X search setup". */
  label: string;
  /** Popover heading. */
  title: string;
  /** Body — steps, paragraphs, lists. */
  children: ReactNode;
  /** Optional class on the root wrapper. */
  className?: string;
};

/**
 * Compact help icon that opens a setup popover (click to toggle).
 * Closes on outside click, Escape, or second click.
 */
export function HelpTip({ label, title, children, className }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    };
    const onPointer = (e: MouseEvent | PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) {
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, close]);

  return (
    <span
      className={["help-tip", className].filter(Boolean).join(" ")}
      ref={rootRef}
    >
      <button
        ref={btnRef}
        type="button"
        className="help-tip__btn"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        title={`Help: ${label}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <IconHelp />
      </button>
      {open ? (
        <div
          id={panelId}
          className="help-tip__popover"
          role="dialog"
          aria-label={title}
        >
          <div className="help-tip__head">
            <strong className="help-tip__title">{title}</strong>
            <button
              type="button"
              className="help-tip__close"
              aria-label="Close help"
              onClick={close}
            >
              ×
            </button>
          </div>
          <div className="help-tip__body">{children}</div>
        </div>
      ) : null}
    </span>
  );
}

/** Title row with optional help — for connector block headings. */
export function HelpTitle({
  title,
  helpLabel,
  helpTitle,
  children,
}: {
  title: string;
  helpLabel: string;
  helpTitle: string;
  children: ReactNode;
}) {
  return (
    <div className="help-title-row">
      <h3 className="settings-connector-block__title">{title}</h3>
      <HelpTip label={helpLabel} title={helpTitle}>
        {children}
      </HelpTip>
    </div>
  );
}
