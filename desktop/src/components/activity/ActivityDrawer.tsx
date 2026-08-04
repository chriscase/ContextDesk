/**
 * Drawer surface: an overlay panel for inspecting one turn in detail.
 *
 * Focus trap / Escape-to-close / focus-restore mirrors `PermissionModal` —
 * the same pattern, reused rather than reinvented.
 */
import { useEffect, useId, useRef } from "react";
import { trapTabKey } from "../../lib/a11y";
import { ActivityInspectorBody } from "./ActivityInspectorBody";
import type { ActivityTurn } from "../../lib/activity/types";

export function ActivityDrawer({
  turn,
  onClose,
}: {
  turn: ActivityTurn | null;
  onClose: () => void;
}) {
  if (!turn) return null;
  return <ActivityDrawerBody turn={turn} onClose={onClose} />;
}

function ActivityDrawerBody({
  turn,
  onClose,
}: {
  turn: ActivityTurn;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    restoreFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const t = window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(".activity-inspector__close")
        ?.focus();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (!panelRef.current) return;
      trapTabKey(e, panelRef.current, document.activeElement);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      restoreFocusRef.current?.focus?.();
    };
    // Re-run whenever the inspected turn changes so focus capture stays correct.
  }, [turn.turnId, onClose]);

  return (
    <div
      className="activity-drawer-overlay"
      data-testid="activity-drawer-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="activity-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
      >
        <ActivityInspectorBody turn={turn} titleId={titleId} onClose={onClose} />
      </div>
    </div>
  );
}
