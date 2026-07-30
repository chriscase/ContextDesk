import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type RefObject,
} from "react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";

export function InvestigationAddMenu({
  triggerRef,
  onChoose,
  onDismiss,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  onChoose: (type: "finding" | "note") => void;
  onDismiss: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const layerId = useId();
  const dismiss = useCallback(
    (restoreFocus: boolean) => {
      onDismiss();
      if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
    },
    [onDismiss, triggerRef],
  );

  useDismissibleLayer({
    open: true,
    layerId,
    peerGroup: "investigation-rail-menu",
    rootRef: menuRef,
    triggerRef,
    onDismiss: dismiss,
  });

  useEffect(() => {
    queueMicrotask(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
  }, []);

  return (
    <div
      ref={menuRef}
      className="log-explorer__selection-add-menu"
      data-placement="below"
      role="menu"
      aria-label="Add selected events to Investigation"
    >
      <button type="button" role="menuitem" onClick={() => onChoose("finding")}>
        <span>Create finding</span>
        <span>Record an observation, inference, or hypothesis.</span>
      </button>
      <button type="button" role="menuitem" onClick={() => onChoose("note")}>
        <span>Create cited note</span>
        <span>Write analysis linked to these exact events.</span>
      </button>
    </div>
  );
}
