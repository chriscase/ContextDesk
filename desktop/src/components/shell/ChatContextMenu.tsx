import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
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

const VIEWPORT_GUTTER = 8;

export function clampChatContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    left: Math.max(
      VIEWPORT_GUTTER,
      Math.min(x, viewportWidth - menuWidth - VIEWPORT_GUTTER),
    ),
    top: Math.max(
      VIEWPORT_GUTTER,
      Math.min(y, viewportHeight - menuHeight - VIEWPORT_GUTTER),
    ),
  };
}

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
  const [position, setPosition] = useState({ left: x, top: y });

  const updatePosition = useCallback(() => {
    const menu = rootRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    // First paint can report 0×0 before flex/font layout; use CSS min-width floor
    // so edge opens still clamp (packaged #837 regression).
    const menuWidth = Math.max(rect.width, 168);
    const menuHeight = Math.max(rect.height, 120);
    const next = clampChatContextMenuPosition(
      x,
      y,
      menuWidth,
      menuHeight,
      window.innerWidth,
      window.innerHeight,
    );
    setPosition((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [x, y]);

  useLayoutEffect(() => {
    updatePosition();
    // Re-clamp when real dimensions settle (0×0 → laid out size)
    const menu = rootRef.current;
    let ro: ResizeObserver | null = null;
    if (menu && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => updatePosition());
      ro.observe(menu);
    }
    window.addEventListener("resize", updatePosition);
    // Second frame after paint — WebKit often finalizes metrics one tick late
    const raf = requestAnimationFrame(() => updatePosition());
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [updatePosition]);

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
      style={{ left: position.left, top: position.top }}
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
