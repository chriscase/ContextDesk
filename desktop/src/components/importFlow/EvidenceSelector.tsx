/**
 * Bounded, virtualized evidence selector.
 *
 * A treegrid over the trusted preview: tri-state containers, leaf-only
 * shift ranges over the flattened visible order, seven ledger-state chips
 * with plain-language reasons, and nested-archive identities rendered as
 * segmented breadcrumbs. Rows are windowed so a 5,000-item preview renders
 * a few dozen DOM rows.
 */
import { useId, useMemo, useRef, useState } from "react";
import type { WireImportPreviewItem, WireImportPreviewReport } from "@contextdesk/contracts";
import {
  REASON_EXPLANATIONS,
  STATUS_EXPLANATIONS,
  STATUS_LABELS,
  containerState,
  isSelectable,
  selectorRows,
  type ImportFlowEvent,
  type SelectorRow,
} from "./importFlowState";

const ROW_HEIGHT = 32;
const OVERSCAN = 12;
const VIEWPORT_ROWS = 14;

const ALL_STATUSES = [
  "ready",
  "review",
  "raw_fallback",
  "supporting",
  "ignored",
  "unsupported",
  "blocked",
] as const;

type Props = {
  report: WireImportPreviewReport;
  selected: ReadonlySet<string>;
  dispatch: (event: ImportFlowEvent) => void;
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** Segmented archive identity: outer.zip !/ inner.zip !/ member. */
function IdentityBreadcrumb({ identity }: { identity: string }) {
  const segments = identity.split("!/");
  if (segments.length === 1) return <span className="import-selector__name">{identity}</span>;
  return (
    <span className="import-selector__name import-selector__name--archive">
      {segments.map((segment, index) => (
        <span key={`${identity}:${index}`}>
          {index > 0 ? <span className="import-selector__bang" aria-hidden="true"> !/ </span> : null}
          <span>{segment}</span>
        </span>
      ))}
    </span>
  );
}

function reasonText(item: WireImportPreviewItem): string {
  return item.reasons
    .map((reason) => REASON_EXPLANATIONS[reason] ?? reason)
    .join(" · ");
}

export function EvidenceSelector({ report, selected, dispatch }: Props) {
  const labelId = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<string> | null>(null);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(
    () => selectorRows(report, { collapsed, statusFilter, query }),
    [report, collapsed, statusFilter, query],
  );
  const visibleLeaves = useMemo(
    () => rows.filter((row) => row.kind === "leaf").map((row) => (row as { item: WireImportPreviewItem }).item.identity),
    [rows],
  );

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, first + VIEWPORT_ROWS + OVERSCAN * 2);
  const windowRows = rows.slice(first, last);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of report.items) {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    }
    return counts;
  }, [report]);

  const moveFocus = (delta: number, extend: boolean) => {
    const next = Math.min(rows.length - 1, Math.max(0, focusIndex + delta));
    setFocusIndex(next);
    const row = rows[next];
    if (extend && row?.kind === "leaf") {
      dispatch({ type: "RANGE_TO_LEAF", identity: row.item.identity, visibleLeaves });
    }
    const viewport = viewportRef.current;
    if (viewport) {
      const rowTop = next * ROW_HEIGHT;
      if (rowTop < viewport.scrollTop) viewport.scrollTop = rowTop;
      const bottom = viewport.scrollTop + VIEWPORT_ROWS * ROW_HEIGHT;
      if (rowTop + ROW_HEIGHT > bottom) {
        viewport.scrollTop = rowTop + ROW_HEIGHT - VIEWPORT_ROWS * ROW_HEIGHT;
      }
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusIndex];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1, event.shiftKey);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1, event.shiftKey);
    } else if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      if (!row) return;
      if (row.kind === "leaf" && isSelectable(row.item)) {
        dispatch({ type: "TOGGLE_LEAF", identity: row.item.identity });
      } else if (row.kind === "container") {
        dispatch({ type: "TOGGLE_CONTAINER", prefix: row.prefix });
      }
    } else if ((event.key === "a" || event.key === "A") && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      dispatch({ type: "SET_ALL_VISIBLE", identities: visibleLeaves, selected: true });
    } else if (event.key === "ArrowRight" && row?.kind === "container") {
      event.preventDefault();
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(row.prefix);
        return next;
      });
    } else if (event.key === "ArrowLeft" && row?.kind === "container") {
      event.preventDefault();
      setCollapsed((current) => new Set(current).add(row.prefix));
    }
  };

  const renderRow = (row: SelectorRow, index: number) => {
    const absolute = first + index;
    const isFocused = absolute === focusIndex;
    if (row.kind === "container") {
      const state = containerState(row.leafIdentities, report, selected);
      const isCollapsed = collapsed.has(row.prefix);
      return (
        <div
          key={`c:${row.prefix}`}
          role="row"
          aria-level={row.depth + 1}
          aria-expanded={!isCollapsed}
          className={`import-selector__row import-selector__row--container${isFocused ? " import-selector__row--focused" : ""}`}
          style={{ top: absolute * ROW_HEIGHT }}
          onClick={() => setFocusIndex(absolute)}
        >
          <span role="gridcell" className="import-selector__cell import-selector__cell--check">
            {state !== "none" ? (
              <input
                type="checkbox"
                checked={state === "checked"}
                ref={(element) => {
                  if (element) element.indeterminate = state === "mixed";
                }}
                aria-label={`${row.label} — ${state === "mixed" ? "partially selected" : state}`}
                onChange={() => dispatch({ type: "TOGGLE_CONTAINER", prefix: row.prefix })}
              />
            ) : null}
          </span>
          <span role="gridcell" className="import-selector__cell import-selector__cell--name" style={{ paddingLeft: row.depth * 16 }}>
            <button
              type="button"
              className="import-selector__disclose"
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${row.label}`}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(row.prefix)) next.delete(row.prefix);
                  else next.add(row.prefix);
                  return next;
                })
              }
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
            <strong>{row.label}</strong>
            <span className="import-selector__hint">
              {row.leafIdentities.length} item{row.leafIdentities.length === 1 ? "" : "s"}
            </span>
          </span>
        </div>
      );
    }
    const item = row.item;
    const selectable = isSelectable(item);
    return (
      <div
        key={`l:${item.identity}`}
        role="row"
        aria-level={row.depth + 1}
        className={`import-selector__row${isFocused ? " import-selector__row--focused" : ""}`}
        style={{ top: absolute * ROW_HEIGHT }}
        onClick={(event) => {
          setFocusIndex(absolute);
          if (!selectable) return;
          if (event.shiftKey) {
            dispatch({ type: "RANGE_TO_LEAF", identity: item.identity, visibleLeaves });
          }
        }}
      >
        <span role="gridcell" className="import-selector__cell import-selector__cell--check">
          <input
            type="checkbox"
            checked={selected.has(item.identity)}
            disabled={!selectable}
            aria-label={`${item.identity} — ${STATUS_LABELS[item.status] ?? item.status}${selectable ? "" : " — not selectable"}`}
            onClick={(event) => {
              if (event.shiftKey) {
                event.preventDefault();
                dispatch({ type: "RANGE_TO_LEAF", identity: item.identity, visibleLeaves });
              }
            }}
            onChange={(event) => {
              const native = event.nativeEvent as MouseEvent | KeyboardEvent;
              if ("shiftKey" in native && native.shiftKey) return;
              dispatch({ type: "TOGGLE_LEAF", identity: item.identity });
            }}
          />
        </span>
        <span
          role="gridcell"
          className="import-selector__cell import-selector__cell--name"
          style={{ paddingLeft: row.depth * 16 }}
        >
          <IdentityBreadcrumb identity={item.identity} />
        </span>
        <span role="gridcell" className="import-selector__cell import-selector__cell--status">
          <span className={`import-selector__chip import-selector__chip--${item.status}`}>
            {STATUS_LABELS[item.status] ?? item.status}
          </span>
        </span>
        <span role="gridcell" className="import-selector__cell import-selector__cell--bytes">
          {formatBytes(item.bytes)}
        </span>
        <span role="gridcell" className="import-selector__cell import-selector__cell--why">
          {item.formatId ? `${item.formatId} v${item.formatVersion ?? 1} · ` : ""}
          {reasonText(item)}
        </span>
      </div>
    );
  };

  return (
    <section className="import-selector" aria-labelledby={labelId}>
      <header className="import-selector__head">
        <h3 id={labelId}>Review selection</h3>
        <span className="import-selector__summary" role="status">
          {report.counts.total} discovered · {selected.size} selected
          {report.truncated ? " · preview truncated — remaining items disclosed at import" : ""}
        </span>
      </header>
      <div className="import-selector__filters" role="group" aria-label="Filter by state">
        {ALL_STATUSES.map((status) => {
          const count = statusCounts.get(status) ?? 0;
          if (count === 0) return null;
          const active = statusFilter?.has(status) ?? false;
          return (
            <button
              key={status}
              type="button"
              className={`import-selector__filter${active ? " import-selector__filter--on" : ""}`}
              aria-pressed={active}
              title={STATUS_EXPLANATIONS[status]}
              onClick={() =>
                setStatusFilter((current) => {
                  if (current?.has(status)) {
                    const next = new Set(current);
                    next.delete(status);
                    return next.size === 0 ? null : next;
                  }
                  return new Set(current ?? []).add(status);
                })
              }
            >
              {STATUS_LABELS[status]} {count}
            </button>
          );
        })}
        <input
          className="import-selector__search"
          placeholder="Find by name or path"
          aria-label="Find by name or path"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div
        ref={viewportRef}
        role="treegrid"
        aria-label="Discovered items"
        aria-rowcount={rows.length}
        tabIndex={0}
        className="import-selector__viewport"
        style={{ height: VIEWPORT_ROWS * ROW_HEIGHT }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="import-selector__spacer" style={{ height: rows.length * ROW_HEIGHT }}>
          {windowRows.map((row, index) => renderRow(row, index))}
        </div>
      </div>
      <p className="import-selector__keys">
        Space selects · Shift+arrows extend a range over leaf rows · ⌘A selects visible rows
      </p>
    </section>
  );
}
