/**
 * Log Explorer rail occupant for ContextDesk's own activity — the third
 * `investigationMode`, sharing the column-5 track and chrome contract of
 * `LinkedChatRail` / `EvidencePanel` (visible / compactLayout /
 * desktopGridColumn / shared mode control), so search, filters, timeline,
 * lanes, and chat are untouched.
 *
 * On narrow layouts it is the same drawer the other rail modes become; on
 * ultrawide it docks right in column 5, which is where the dual-group
 * timeline is genuinely useful.
 *
 * Client evidence stays in its own lanes and its own stores. This rail
 * renders ContextDesk activity only, and the shared axis appears only when
 * both sides carry calendar time — see `DualLaneTimeline`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ActivityLogState } from "../../lib/activity/activityLog";
import type {
  ActivityMode,
  ClientIncidentClock,
} from "../../lib/activity/types";
import { DualLaneTimeline } from "../activity/DualLaneTimeline";
import { ActivityEventList } from "../activity/ActivityEventList";
import { ActivityToggle } from "../activity/ActivityToggle";

function formatInvestigationElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function ActivityRail({
  visible,
  modeControl,
  compactLayout = false,
  desktopGridColumn,
  clientClock,
  openedAtMs,
  log,
  mode,
  onModeChange,
  collapsed = false,
  onToggleCollapsed,
  nowMs,
  onRequestClose,
}: {
  visible: boolean;
  modeControl: ReactNode;
  compactLayout?: boolean;
  desktopGridColumn?: number;
  clientClock: ClientIncidentClock;
  openedAtMs: number;
  log: ActivityLogState;
  /** The shared display preference — the same one ordinary chat uses. */
  mode: ActivityMode;
  onModeChange: (mode: ActivityMode) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Test seam for the ticking investigation clock. */
  nowMs?: number;
  onRequestClose?: () => void;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const collapseRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const live = nowMs == null;
  useEffect(() => {
    if (!live || !visible) return;
    const interval = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [live, visible]);

  useEffect(() => {
    if (!visible || compactLayout) return;
    queueMicrotask(() => {
      (collapsed ? reopenRef.current : collapseRef.current)?.focus();
    });
  }, [collapsed, compactLayout, visible]);

  const omittedNote =
    log.omitted > 0
      ? `${log.omitted} earlier ${log.omitted === 1 ? "entry" : "entries"} dropped by the ${log.cap}-entry retention bound.`
      : null;

  if (visible && collapsed && !compactLayout) {
    return (
      <aside
        className="log-explorer__chat log-explorer__chat--rail log-explorer__activity log-explorer__chat--collapsed"
        data-testid="log-explorer-activity"
        data-collapsed="true"
        aria-label="ContextDesk activity collapsed"
        style={
          desktopGridColumn == null ? undefined : { gridColumn: desktopGridColumn }
        }
      >
        <button
          ref={reopenRef}
          type="button"
          className="log-explorer__chat-reopen"
          data-testid="expand-activity-rail"
          aria-label={`Expand ContextDesk activity, ${log.entries.length} ${
            log.entries.length === 1 ? "entry" : "entries"
          }`}
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">Activity</span>
          {log.entries.length > 0 ? (
            <span className="log-explorer__chat-reopen-count" aria-hidden="true">
              {log.entries.length}
            </span>
          ) : null}
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={`log-explorer__chat log-explorer__chat--rail log-explorer__activity${
        compactLayout ? " log-explorer__chat--compact-layout" : ""
      }${visible ? "" : " log-explorer__chat--mode-hidden"}`}
      data-testid="log-explorer-activity"
      hidden={!visible}
      style={
        desktopGridColumn == null ? undefined : { gridColumn: desktopGridColumn }
      }
      role={compactLayout ? "dialog" : undefined}
      aria-label={compactLayout ? "Activity drawer" : "ContextDesk activity"}
    >
      <div
        className="log-explorer__investigation-mode-control"
        style={compactLayout ? undefined : { paddingLeft: "1.65rem" }}
      >
        {modeControl}
      </div>
      <header className="log-explorer__chat-header">
        <div>
          <div className="log-explorer__chat-header-title">
            ContextDesk activity
          </div>
          <div className="log-explorer__chat-header-meta">
            App actions only · separate from customer evidence
          </div>
        </div>
        <div className="log-explorer__chat-header-actions">
          {!compactLayout && onToggleCollapsed ? (
            <button
              ref={collapseRef}
              type="button"
              className="log-explorer__rail-collapse log-explorer__rail-collapse--chat"
              aria-label="Collapse ContextDesk activity rail"
              title="Collapse activity"
              data-testid="collapse-activity-rail"
              onClick={onToggleCollapsed}
            >
              <span aria-hidden="true">›</span>
            </button>
          ) : null}
          <ActivityToggle mode={mode} onChange={onModeChange} label="Show" />
          {compactLayout && onRequestClose ? (
            <button
              type="button"
              className="log-explorer__btn log-explorer__drawer-close"
              aria-label="Close Activity drawer"
              onClick={onRequestClose}
            >
              Close
            </button>
          ) : null}
        </div>
      </header>

      {mode === "off" ? (
        <p className="activity-empty" role="status" data-testid="activity-off-note">
          Activity display is off. Processing is unchanged — turn it back on
          above to see what the app did.
        </p>
      ) : (
        <div className="activity-dock__body" data-testid="activity-dock-body">
          <div
            className="log-explorer__activity-elapsed"
            data-testid="activity-clock-investigation"
          >
            <span>This investigation has been open</span>{" "}
            <strong>
              {formatInvestigationElapsed((nowMs ?? tick) - openedAtMs)}
            </strong>{" "}
            <span>(this machine, this view)</span>
          </div>

          {mode === "docked" ? (
            <DualLaneTimeline
              clientClock={clientClock}
              activityEvents={log.entries}
            />
          ) : null}

          <ActivityEventList
            events={log.entries}
            omittedNote={omittedNote}
            emptyLabel="No ContextDesk activity recorded in this view yet."
            maxHeightPx={compactLayout ? 260 : 420}
          />
        </div>
      )}
    </aside>
  );
}
