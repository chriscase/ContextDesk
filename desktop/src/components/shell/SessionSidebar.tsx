import type { ChatSession } from "../../lib/session";
import type { MouseEvent as ReactMouseEvent } from "react";
import { IconPin } from "../icons";

type Props = {
  sessionsReady: boolean;
  openChatSessions: ChatSession[];
  activeSessionId: string;
  sidebarW: number;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, id: string) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onResizeKey: (e: React.KeyboardEvent) => void;
  onOpenArchive: () => void;
  archiveActive: boolean;
};

/** Left chat list + resize handle (#146). */
export function SessionSidebar({
  sessionsReady,
  openChatSessions,
  activeSessionId,
  sidebarW,
  onCreate,
  onSelect,
  onContextMenu,
  onResizeStart,
  onResizeKey,
  onOpenArchive,
  archiveActive,
}: Props) {
  return (
    <aside className="sidebar">
      <div
        className="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={sidebarW}
        aria-valuemin={140}
        aria-valuemax={420}
        tabIndex={0}
        onMouseDown={onResizeStart}
        onKeyDown={onResizeKey}
      />
      <div className="row--between">
        <div className="sidebar__label">Chats</div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          title="New chat"
          onClick={onCreate}
        >
          +
        </button>
      </div>
      <ul className="session-list">
        {!sessionsReady ? (
          <li className="field__hint session-list__loading">Loading…</li>
        ) : openChatSessions.length === 0 ? (
          <li className="field__hint session-list__loading">
            No open chats — press + to start
          </li>
        ) : (
          openChatSessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="session-list__item"
                data-active={s.id === activeSessionId ? "true" : undefined}
                title={`${s.title} — right-click for options`}
                onClick={() => onSelect(s.id)}
                onContextMenu={(e) => onContextMenu(e, s.id)}
              >
                {s.pinned ? (
                  <span className="session-tab__pin" aria-hidden title="Pinned">
                    <IconPin />
                  </span>
                ) : null}
                {s.title}
              </button>
            </li>
          ))
        )}
      </ul>
      <button
        type="button"
        className="session-list__item"
        data-active={archiveActive ? "true" : undefined}
        onClick={onOpenArchive}
      >
        Archive & trash
      </button>
    </aside>
  );
}
