import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
} from "react";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import type { ChatSession } from "../../lib/session";

type Props = {
  x: number;
  y: number;
  target: ChatSession;
  origin: HTMLElement | null;
  onDismiss: () => void;
  onOpen: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onTrash: () => void;
};

export function ChatContextMenu({
  x,
  y,
  target,
  origin,
  onDismiss,
  onOpen,
  onRename,
  onTogglePin,
  onArchive,
  onTrash,
}: Props) {
  const layerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(
    (restoreFocus: boolean) => {
      onDismiss();
      if (restoreFocus) {
        queueMicrotask(() => {
          if (origin?.isConnected) origin.focus();
        });
      }
    },
    [onDismiss, origin],
  );

  useDismissibleLayer({
    open: true,
    layerId,
    rootRef,
    onDismiss: dismiss,
  });

  useEffect(() => {
    queueMicrotask(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
  }, []);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (Math.max(current, -1) + 1) % items.length
            : current <= 0
              ? items.length - 1
              : current - 1;
    items[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="chat-ctx-menu"
      role="menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={moveFocus}
    >
      <button
        type="button"
        role="menuitem"
        className="chat-ctx-menu__item"
        onClick={onOpen}
      >
        Open
      </button>
      <button
        type="button"
        role="menuitem"
        className="chat-ctx-menu__item"
        onClick={onRename}
      >
        Rename…
      </button>
      <button
        type="button"
        role="menuitem"
        className="chat-ctx-menu__item"
        onClick={onTogglePin}
      >
        {target.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
      </button>
      <button
        type="button"
        role="menuitem"
        className="chat-ctx-menu__item"
        onClick={onArchive}
      >
        Open archive
      </button>
      <div className="chat-ctx-menu__sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="chat-ctx-menu__item chat-ctx-menu__item--danger"
        onClick={onTrash}
      >
        Move to Trash…
      </button>
    </div>
  );
}
