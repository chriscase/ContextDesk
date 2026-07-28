import { useEffect, useRef, type RefObject } from "react";

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

  useEffect(() => {
    queueMicrotask(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
    );
    const onOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onDismiss();
        window.setTimeout(() => {
          const active = document.activeElement;
          const reachedOutsideDestination =
            active instanceof HTMLElement &&
            active !== document.body &&
            active !== document.documentElement &&
            active !== triggerRef.current &&
            !menuRef.current?.contains(active);
          if (!reachedOutsideDestination) triggerRef.current?.focus();
        }, 0);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
      queueMicrotask(() => triggerRef.current?.focus());
    };
    // Native WebKit applies the click target's default focus after mousedown.
    // Dismiss on click so blank-space focus restoration cannot be overwritten
    // later in the same pointer sequence.
    document.addEventListener("click", onOutsideClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onOutsideClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss, triggerRef]);

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
