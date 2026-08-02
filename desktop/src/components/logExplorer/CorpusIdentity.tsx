/**
 * Corpus-first identity control for the Explorer header (#641).
 *
 * The corpus name is the working title of the surface: a real button that
 * shows the grapheme-safe middle-truncated name, describes itself with the
 * full name (role="tooltip" via aria-describedby), and opens a bounded
 * identity popover (full selectable name + Source / Engine / Created /
 * Events / Time basis) on activation. No model or provider details, no paths
 * beyond the summary's own sourceLabel.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import {
  formatCanonicalUtc,
  timeQualityLabel,
  type TimeQuality,
} from "../../lib/logExplorer/types";
import { middleTruncate, splitGraphemes } from "../../lib/logExplorer/middleTruncate";
import { IconChevronDown } from "../icons";

/** Hover intent delay before the tooltip opens (focus opens immediately). */
export const CORPUS_TOOLTIP_DELAY_MS = 300;

/** Width reserved inside the button for padding + the hover chevron (rem). */
const BUTTON_RESERVE_REM = 2.4;

let measureCanvas: HTMLCanvasElement | null = null;

/** Measure `text` in `font` via a cached canvas; null when unavailable. */
function measureTextWidth(text: string, font: string): number | null {
  try {
    if (!measureCanvas) measureCanvas = document.createElement("canvas");
    const ctx = measureCanvas.getContext("2d");
    if (!ctx) return null;
    ctx.font = font;
    const width = ctx.measureText(text).width;
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

function buttonFont(button: HTMLButtonElement | null): {
  font: string;
  sizePx: number;
} {
  const fallback = { font: "600 13px sans-serif", sizePx: 13 };
  if (!button) return fallback;
  try {
    const style = getComputedStyle(button);
    const sizePx = Number.parseFloat(style.fontSize) || 13;
    const family = style.fontFamily || "sans-serif";
    const weight = style.fontWeight || "600";
    return { font: `${weight} ${sizePx}px ${family}`, sizePx };
  } catch {
    return fallback;
  }
}

/**
 * Fit `name` into `availablePx` using real text measurement when the canvas
 * is available, an average-width estimate otherwise. Truncation only ever
 * happens on a positive measured width; unmeasured layouts show the full
 * name (CSS ellipsis remains the backstop).
 */
function fitName(
  name: string,
  availablePx: number,
  button: HTMLButtonElement | null,
): string {
  if (availablePx <= 0) return name;
  const { font, sizePx } = buttonFont(button);
  const fullWidth =
    measureTextWidth(name, font) ?? splitGraphemes(name).length * sizePx * 0.62;
  if (fullWidth <= availablePx) return name;
  const total = splitGraphemes(name).length;
  let budget = Math.max(4, Math.floor((total * availablePx) / fullWidth));
  let out = middleTruncate(name, budget);
  for (let i = 0; i < 40 && budget > 4; i += 1) {
    const width =
      measureTextWidth(out, font) ??
      splitGraphemes(out).length * sizePx * 0.62;
    if (width <= availablePx) break;
    budget -= 1;
    out = middleTruncate(name, budget);
  }
  return out;
}

/**
 * The bounded corpus facts the popover discloses. Structural subset of the
 * host's LogCorpusSummaryDto — declared locally so this component stays off
 * the `src/lib/host` surface (boundary ratchet, hostImportBaseline.ts).
 */
export type CorpusSummaryFacts = {
  engine: string;
  createdAt: number;
  sourceLabel: string | null;
};

type Props = {
  /** Display label — summary?.name ?? corpusId.slice(0, 8). */
  corpusLabel: string;
  summary: CorpusSummaryFacts | null;
  summaryLoadState: "loading" | "ready" | "error";
  summaryLoadError: string | null;
  timeQuality: TimeQuality;
  corpusTotal: number;
  /** Stable-width ancestor (the identity lockup) driving truncation. */
  measureRef: RefObject<HTMLElement | null>;
  /** Toolbar dismissible peer group so pickers and this popover are peers. */
  dismissPeerGroup?: string;
};

export function CorpusIdentity({
  corpusLabel,
  summary,
  summaryLoadState,
  summaryLoadError,
  timeQuality,
  corpusTotal,
  measureRef,
  dismissPeerGroup,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [availablePx, setAvailablePx] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const layerId = useId();
  const tooltipId = useId();

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    clearHoverTimer();
    setTooltipVisible(false);
  }, [clearHoverTimer]);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  // Truncation input: the lockup's laid-out width. The lockup is the row's
  // only flexible item, so its width is decided by the siblings and the
  // container — not by this button's own content — which keeps the observer
  // loop-free.
  useEffect(() => {
    const target = measureRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      const rootPx =
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
        16;
      const next = Math.floor(width - BUTTON_RESERVE_REM * rootPx);
      setAvailablePx((current) =>
        next > 0 ? (current === next ? current : next) : null,
      );
    };
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width != null) update(width);
    });
    observer.observe(target);
    update(target.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [measureRef]);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useDismissibleLayer({
    open,
    layerId,
    peerGroup: dismissPeerGroup,
    rootRef,
    triggerRef: buttonRef,
    onDismiss: close,
  });

  const display =
    availablePx == null
      ? corpusLabel
      : fitName(corpusLabel, availablePx, buttonRef.current);

  const scheduleTooltip = () => {
    if (open) return;
    clearHoverTimer();
    let reducedMotion: boolean;
    try {
      reducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reducedMotion = false;
    }
    if (reducedMotion) {
      setTooltipVisible(true);
      return;
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setTooltipVisible(true);
    }, CORPUS_TOOLTIP_DELAY_MS);
  };

  return (
    <div className="log-explorer__corpus-identity" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="log-explorer__corpus-button"
        data-testid="log-explorer-corpus-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={tooltipId}
        onClick={() => {
          hideTooltip();
          setOpen((current) => !current);
        }}
        onMouseEnter={scheduleTooltip}
        onMouseLeave={hideTooltip}
        onFocus={() => {
          if (!open) setTooltipVisible(true);
        }}
        onBlur={hideTooltip}
        onKeyDown={(event) => {
          if (event.key === "Escape" && tooltipVisible) {
            hideTooltip();
          }
        }}
      >
        <bdi dir="auto" className="log-explorer__corpus-name">
          {display}
        </bdi>
        <span className="log-explorer__corpus-chevron" aria-hidden="true">
          <IconChevronDown />
        </span>
      </button>
      <div
        id={tooltipId}
        role="tooltip"
        className="log-explorer__corpus-tooltip"
        data-state={tooltipVisible ? "open" : "closed"}
      >
        {corpusLabel}
      </div>
      {open ? (
        <div
          id={layerId}
          role="dialog"
          aria-label="Corpus identity"
          className="log-explorer__picker-menu log-explorer__corpus-popover"
          data-testid="log-explorer-corpus-popover"
        >
          <div className="log-explorer__corpus-popover-name">{corpusLabel}</div>
          {summary ? (
            <dl className="log-explorer__corpus-facts">
              {summary.sourceLabel ? (
                <div className="log-explorer__corpus-fact">
                  <dt>Source</dt>
                  <dd>{summary.sourceLabel}</dd>
                </div>
              ) : null}
              <div className="log-explorer__corpus-fact">
                <dt>Engine</dt>
                <dd>{summary.engine}</dd>
              </div>
              <div className="log-explorer__corpus-fact">
                <dt>Created</dt>
                <dd>{formatCanonicalUtc(summary.createdAt)}</dd>
              </div>
              <div className="log-explorer__corpus-fact">
                <dt>Events</dt>
                <dd>{corpusTotal.toLocaleString()}</dd>
              </div>
              <div className="log-explorer__corpus-fact">
                <dt>Time basis</dt>
                <dd>{timeQualityLabel(timeQuality)}</dd>
              </div>
            </dl>
          ) : (
            <p className="log-explorer__corpus-popover-state">
              {summaryLoadState === "error"
                ? `Corpus details unavailable${
                    summaryLoadError ? ` — ${summaryLoadError}` : ""
                  }`
                : "Loading corpus details…"}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
