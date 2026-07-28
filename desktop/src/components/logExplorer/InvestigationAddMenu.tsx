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
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onDismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss();
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss, triggerRef]);

  return (
    <div
      ref={menuRef}
      className="log-explorer__selection-add-menu"
      role="menu"
      aria-label="Add selected events to Investigation"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onChoose("finding")}
      >
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
