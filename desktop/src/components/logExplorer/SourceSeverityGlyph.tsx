import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { WireLogFacets } from "@contextdesk/contracts";
type SourceSeverityCountsDto = NonNullable<WireLogFacets["sourceSeverityCounts"]>[string];

const bands = [
  ["errorFatal", "Error / fatal"], ["warn", "Warn"], ["info", "Info"],
  ["debugTrace", "Debug / trace"], ["unknown", "Unknown / other"],
] as const;

export function SourceSeverityGlyph({ source, total, counts, unavailableReason }: {
  source: string; total: number; counts?: SourceSeverityCountsDto; unavailableReason?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelLeave = useCallback(() => { if (leaveTimer.current != null) clearTimeout(leaveTimer.current); leaveTimer.current = null; }, []);
  const leave = () => { cancelLeave(); leaveTimer.current = setTimeout(() => setPosition(null), 150); };
  useEffect(() => () => { if (leaveTimer.current != null) clearTimeout(leaveTimer.current); }, []);
  const [position, setPosition] = useState<{left: number; top: number; above: boolean; maxHeight: number} | null>(null);
  const valid = counts != null && Number.isSafeInteger(total) && total >= 0
    && bands.every(([key]) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && bands.reduce((sum, [key]) => sum + counts[key], 0) === total;
  const available = valid && !unavailableReason;
  const open = () => {
    cancelLeave();
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.min(288, Math.max(0, window.innerWidth - 16));
    const above = window.innerHeight - bounds.bottom < 240 && bounds.top > window.innerHeight - bounds.bottom;
    setPosition({ left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
      top: above ? Math.max(8, bounds.top - 4) : Math.min(window.innerHeight - 8, bounds.bottom + 4), above,
      maxHeight: Math.max(0, above ? bounds.top - 12 : window.innerHeight - bounds.bottom - 12) });
  };
  useEffect(() => {
    if (!position) return;
    const dismiss = () => { cancelLeave(); setPosition(null); };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) dismiss();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      dismiss();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [position, cancelLeave]);
  let offset = 0;
  return <span className="source-severity" onMouseEnter={open} onMouseLeave={leave}>
    <button ref={trigger} type="button" className="source-severity__trigger"
      aria-label={`Severity breakdown for ${source}${available ? "" : " (unavailable)"}`}
      aria-describedby={position ? id : undefined} onFocus={open} onBlur={() => setPosition(null)}
      onClick={(event) => { event.stopPropagation(); open(); }}>
      <span className="source-severity__mark" aria-hidden="true">≋</span>
      {available && total > 0 ? <svg viewBox="0 0 48 12" width="36" height="12" aria-hidden="true">
        {bands.map(([key]) => { const width = counts[key] / total * 48; const x = offset; offset += width;
          return <rect key={key} className={`source-severity__band--${key}`} x={x} y="1" width={width} height="10" />; })}
      </svg> : <span aria-hidden="true">{available ? "0" : "—"}</span>}
    </button>
    {position ? createPortal(<div ref={popup} id={id} role="tooltip" data-testid="source-severity-tooltip"
      className={`source-severity__popover${position.above ? " source-severity__popover--above" : ""}`}
      style={{ "--severity-left": `${position.left}px`, "--severity-top": `${position.top}px`, "--severity-height": `${position.maxHeight}px` } as CSSProperties}>
      <strong>{source}</strong>
      {available ? <><p>{total.toLocaleString()} events in current facet scope</p>
        <dl>{bands.map(([key, label]) => <div key={key}><dt><span className={`source-severity__swatch source-severity__band--${key}`} aria-hidden="true" />{label}</dt>
          <dd>{counts[key].toLocaleString()} · {total === 0 ? "—" : `${(counts[key] / total * 100).toFixed(1)}%`}</dd></div>)}</dl>
        {total === 0 ? <p>No events; percentages are not defined.</p> : null}</>
        : <p>{unavailableReason ?? "Severity breakdown unavailable from this adapter or query. No zero counts are implied."}</p>}
      <p>Facet filters apply; this is not a corpus-wide total. Find and lane-only restrictions are not included. Escape closes.</p>
    </div>, document.body) : null}
  </span>;
}
