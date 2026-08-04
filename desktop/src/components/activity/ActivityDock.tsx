/**
 * Docked surface: a resizable right rail for wide and ultrawide viewports.
 *
 * Width persists via `useActivityInspector`'s `setDockWidth`. The resize
 * handle supports pointer drag AND arrow-key resize, so a keyboard-only user
 * can size the rail too.
 */
import { useCallback, useRef } from "react";
import { MAX_DOCK_WIDTH, MIN_DOCK_WIDTH } from "../../lib/activity/prefs";
import { ActivityInspectorBody } from "./ActivityInspectorBody";
import type { ActivityTurn } from "../../lib/activity/types";

const RESIZE_STEP = 16;

export function ActivityDock({
  turn,
  width,
  onWidthChange,
  onCollapse,
}: {
  turn: ActivityTurn | null;
  width: number;
  onWidthChange: (px: number) => void;
  onCollapse?: () => void;
}) {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      // Rail is on the right edge; dragging left (negative dx) widens it.
      onWidthChange(startWidthRef.current - (e.clientX - startXRef.current));
    },
    [onWidthChange],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onWidthChange(width + RESIZE_STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onWidthChange(width - RESIZE_STEP);
      }
    },
    [onWidthChange, width],
  );

  if (!turn) return null;

  return (
    <aside
      className="activity-dock"
      aria-label="ContextDesk activity inspector"
      style={{ width }}
      data-testid="activity-dock"
    >
      <div
        className="activity-dock__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize activity inspector"
        aria-valuemin={MIN_DOCK_WIDTH}
        aria-valuemax={MAX_DOCK_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onHandleKeyDown}
      />
      <div className="activity-dock__content">
        <ActivityInspectorBody
          turn={turn}
          onClose={onCollapse}
          closeLabel="Collapse activity inspector"
        />
      </div>
    </aside>
  );
}
