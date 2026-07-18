import type { ChatSession } from "../../lib/session";

type Props = {
  x: number;
  y: number;
  target: ChatSession;
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
  onOpen,
  onRename,
  onTogglePin,
  onArchive,
  onTrash,
}: Props) {
  return (
    <div
      className="chat-ctx-menu"
      role="menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" className="chat-ctx-menu__item" onClick={onOpen}>
        Open
      </button>
      <button type="button" role="menuitem" className="chat-ctx-menu__item" onClick={onRename}>
        Rename…
      </button>
      <button type="button" role="menuitem" className="chat-ctx-menu__item" onClick={onTogglePin}>
        {target.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
      </button>
      <button type="button" role="menuitem" className="chat-ctx-menu__item" onClick={onArchive}>
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
