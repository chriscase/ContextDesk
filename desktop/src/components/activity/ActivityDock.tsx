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
  maxWidth = MAX_DOCK_WIDTH,
  onWidthChange,
  onCollapse,
}: {
  turn: ActivityTurn | null;
  width: number;
  /** Container-derived upper bound so the rail cannot consume the composer. */
  maxWidth?: number;
  onWidthChange: (px: number) => void;
  onCollapse?: () => void;
}) {
  const draggingRef = useRef(false);
  const effectiveMaxWidth = Math.max(
    MIN_DOCK_WIDTH,
    Math.min(MAX_DOCK_WIDTH, Math.round(maxWidth)),
  );
  const effectiveWidth = Math.min(width, effectiveMaxWidth);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = effectiveWidth;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [effectiveWidth],
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
        onWidthChange(
          Math.min(effectiveMaxWidth, effectiveWidth + RESIZE_STEP),
        );
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onWidthChange(effectiveWidth - RESIZE_STEP);
      }
    },
    [effectiveMaxWidth, effectiveWidth, onWidthChange],
  );

  if (!turn) return null;

  return (
    <aside
      className="activity-dock"
      aria-label="ContextDesk activity inspector"
      style={{ width: effectiveWidth }}
      data-testid="activity-dock"
    >
      <div
        className="activity-dock__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize activity inspector"
        aria-valuemin={MIN_DOCK_WIDTH}
        aria-valuemax={effectiveMaxWidth}
        aria-valuenow={effectiveWidth}
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
