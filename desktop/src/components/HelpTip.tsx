/**
 * Contextual Help popover (#541).
 * Hierarchy: control → tip → rich click-open Help → full Help deep link.
 * Portal + measured flip/shift; Escape restores focus; one open at a time.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { DismissibleLayerContext } from "../hooks/useDismissibleLayer";
import { IconHelp } from "./icons";
import { parseHelpLocator, requestHelpAcrossWindows } from "../lib/help";

export type HelpTipContent = {
  title: string;
  definition?: string;
  currentState?: string;
  useWhen?: string;
  options?: { name: string; when: string }[];
  comparison?: {
    columns: [string, string];
    rows: { option: string; meaning: string }[];
  };
  consequence?: string;
  safety?: string;
  privacy?: string;
  example?: string;
  shortcut?: string;
  /** Canonical Help locator, e.g. help://log-explorer#find-vs-filter */
  helpLocator?: string;
};

export type HelpTipProps = {
  /** Short accessible name for the control, e.g. "X search setup". */
  label: string;
  /** Popover heading. */
  title: string;
  /** Body — steps, paragraphs, lists (legacy freeform). */
  children?: ReactNode;
  /** Structured content blocks (preferred when available). */
  content?: HelpTipContent;
  /** Optional class on the root wrapper. */
  className?: string;
  /** Open full Help at this locator when "Open full Help" is clicked. */
  onOpenHelp?: (pageId: string, anchor?: string) => void;
};

/** Module-level bus: only one HelpTip open at a time. */
const OPEN_EVENT = "contextdesk:help-tip-open";

function placementStyle(
  trigger: DOMRect,
  panel: DOMRect,
  gap = 8,
): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = trigger.bottom + gap;
  let left = trigger.left;

  // Flip above if not enough room below.
  if (top + panel.height > vh - 8 && trigger.top - gap - panel.height > 8) {
    top = trigger.top - gap - panel.height;
  }
  // Shift horizontally into viewport.
  if (left + panel.width > vw - 8) {
    left = Math.max(8, vw - 8 - panel.width);
  }
  if (left < 8) left = 8;
  // Clamp vertically if still overflowing.
  if (top + panel.height > vh - 8) {
    top = Math.max(8, vh - 8 - panel.height);
  }
  if (top < 8) top = 8;

  return {
    position: "fixed",
    top,
    left,
    zIndex: 10050,
  };
}

function StructuredBody({ content }: { content: HelpTipContent }) {
  return (
    <>
      {content.definition ? <p>{content.definition}</p> : null}
      {content.currentState ? (
        <p>
          <strong>Current state</strong> {content.currentState}
        </p>
      ) : null}
      {content.useWhen ? (
        <p>
          <strong>Use this when</strong> {content.useWhen}
        </p>
      ) : null}
      {content.options && content.options.length > 0 ? (
        <ul>
          {content.options.map((o) => (
            <li key={o.name}>
              <strong>{o.name}</strong> — {o.when}
            </li>
          ))}
        </ul>
      ) : null}
      {content.comparison && content.comparison.rows.length > 0 ? (
        <div className="help-tip__table-wrap">
          <table className="help-tip__table">
            <thead>
              <tr>
                {content.comparison.columns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.comparison.rows.map((row) => (
                <tr key={row.option}>
                  <th scope="row">{row.option}</th>
                  <td>{row.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {content.consequence ? (
        <p className="help-tip__callout">{content.consequence}</p>
      ) : null}
      {content.example ? (
        <p>
          <strong>Example</strong> <code>{content.example}</code>
        </p>
      ) : null}
      {content.shortcut ? (
        <p>
          <strong>Shortcut</strong> <kbd>{content.shortcut}</kbd>
        </p>
      ) : null}
      {content.safety ? (
        <p className="help-tip__callout help-tip__callout--safety">
          {content.safety}
        </p>
      ) : null}
      {content.privacy ? (
        <p className="help-tip__callout help-tip__callout--privacy">
          {content.privacy}
        </p>
      ) : null}
    </>
  );
}

/**
 * Compact help icon that opens a setup popover (click to toggle).
 * Closes on outside click, Escape, or second click. Renders in a portal so
 * it is not clipped by overflow containers.
 */
export function HelpTip({
  label,
  title,
  children,
  content,
  className,
  onOpenHelp,
}: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 640,
  );
  const [pos, setPos] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const instanceId = useId();
  const parentDismissibleLayer = useContext(DismissibleLayerContext);

  const close = useCallback(() => setOpen(false), []);

  // One-open-at-a-time: close when another tip opens.
  useEffect(() => {
    const onOther = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail !== instanceId) setOpen(false);
    };
    window.addEventListener(OPEN_EVENT, onOther);
    return () => window.removeEventListener(OPEN_EVENT, onOther);
  }, [instanceId]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: instanceId }));
  }, [open, instanceId]);

  useEffect(() => {
    const measureViewport = () => setNarrow(window.innerWidth <= 640);
    measureViewport();
    window.addEventListener("resize", measureViewport);
    return () => window.removeEventListener("resize", measureViewport);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      if (narrow) {
        setPos({});
        return;
      }
      const trigger = btnRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) return;
      setPos(placementStyle(trigger, panel));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, title, children, content, narrow]);

  useEffect(() => {
    if (!open || !narrow) return;
    queueMicrotask(() => closeRef.current?.focus());
  }, [narrow, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        close();
        btnRef.current?.focus();
        return;
      }
      if (e.key === "Tab" && narrow) {
        const focusable = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const onPointer = (e: MouseEvent | PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (rootRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      close();
      if (narrow) {
        queueMicrotask(() => btnRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, close, narrow]);

  const heading = content?.title ?? title;
  const locator = content?.helpLocator;
  const parsed = locator ? parseHelpLocator(locator) : null;

  const panel =
    open && typeof document !== "undefined"
      ? createPortal(
          <>
            {narrow ? (
              <div
                className="help-tip__backdrop"
                data-testid="help-tip-backdrop"
                data-dismissible-layer-branch={
                  parentDismissibleLayer ?? undefined
                }
                aria-hidden="true"
              />
            ) : null}
            <div
              ref={panelRef}
              id={panelId}
              className={[
                "help-tip__popover",
                "help-tip__popover--portal",
                narrow ? "help-tip__popover--sheet" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              role="dialog"
              aria-modal={narrow ? "true" : "false"}
              aria-label={heading}
              data-testid="help-tip-popover"
              data-dismissible-layer-branch={
                parentDismissibleLayer ?? undefined
              }
              data-presentation={narrow ? "sheet" : "popover"}
              style={pos}
            >
              <div className="help-tip__head">
                <strong className="help-tip__title">{heading}</strong>
                <button
                  ref={closeRef}
                  type="button"
                  className="help-tip__close"
                  aria-label="Close help"
                  onClick={() => {
                    close();
                    btnRef.current?.focus();
                  }}
                >
                  ×
                </button>
              </div>
              <div className="help-tip__body">
                {content ? <StructuredBody content={content} /> : children}
              </div>
              {parsed ? (
                <div className="help-tip__footer">
                  <button
                    type="button"
                    className="help-tip__full-link"
                    data-testid="help-tip-full-link"
                    onClick={() => {
                      if (onOpenHelp) {
                        onOpenHelp(parsed.pageId, parsed.anchor);
                      } else {
                        requestHelpAcrossWindows(parsed);
                      }
                      close();
                    }}
                  >
                    Open full Help
                  </button>
                </div>
              ) : null}
            </div>
          </>,
          document.body,
        )
      : null;

  return (
    <span
      className={["help-tip", className].filter(Boolean).join(" ")}
      ref={rootRef}
      data-testid="help-tip"
    >
      <button
        ref={btnRef}
        type="button"
        className="help-tip__btn"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        title={`Help: ${label}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <IconHelp />
      </button>
      {panel}
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
