import type { ChatSession } from "../../lib/session";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  IconArchive,
  IconChat,
  IconChevronLeft,
  IconChevronRight,
  IconPin,
} from "../icons";

type Props = {
  sessionsReady: boolean;
  openChatSessions: ChatSession[];
  activeSessionId: string;
  sidebarW: number;
  collapsed: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, id: string) => void;
  onResizeStart: (e: React.MouseEvent) => void;
  onResizeKey: (e: React.KeyboardEvent) => void;
  onOpenArchive: () => void;
  onToggleCollapsed: () => void;
  archiveActive: boolean;
};

/** Left chat list + resize handle (#146). */
export function SessionSidebar({
  sessionsReady,
  openChatSessions,
  activeSessionId,
  sidebarW,
  collapsed,
  onCreate,
  onSelect,
  onContextMenu,
  onResizeStart,
  onResizeKey,
  onOpenArchive,
  onToggleCollapsed,
  archiveActive,
}: Props) {
  return (
    <aside
      className="sidebar"
      data-collapsed={collapsed ? "true" : undefined}
      aria-label="Chat navigation"
    >
      {!collapsed ? (
        <div
          className="sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat navigation"
          aria-valuenow={sidebarW}
          aria-valuemin={140}
          aria-valuemax={420}
          tabIndex={0}
          onMouseDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
      ) : null}
      <div className="sidebar__header">
        {!collapsed ? <div className="sidebar__label">Chats</div> : null}
        <button
          type="button"
          className="sidebar__collapse"
          title={collapsed ? "Expand chats" : "Collapse chats"}
          aria-label={collapsed ? "Expand chat navigation" : "Collapse chat navigation"}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
        </button>
      </div>
      {collapsed ? (
        <div className="sidebar__rail">
          <button
            type="button"
            className="sidebar__rail-action"
            aria-label="New chat"
            title="New chat"
            onClick={onCreate}
          >
            <span aria-hidden>+</span>
          </button>
          <button
            type="button"
            className="sidebar__rail-action"
            aria-label="Expand chats to switch conversation"
            title="Chats"
            onClick={onToggleCollapsed}
          >
            <IconChat />
          </button>
          <button
            type="button"
            className="sidebar__rail-action sidebar__rail-action--bottom"
            data-active={archiveActive ? "true" : undefined}
            aria-label="Archive and trash"
            title="Archive & trash"
            onClick={onOpenArchive}
          >
            <IconArchive />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="sidebar__new"
            onClick={onCreate}
          >
            <span aria-hidden>+</span>
            New chat
          </button>
          <ul className="session-list">
            {!sessionsReady ? (
              <li className="field__hint session-list__loading">Loading…</li>
            ) : openChatSessions.length === 0 ? (
              <li className="field__hint session-list__loading">
                No open chats — start a new conversation
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
                    <span className="session-list__title">{s.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <button
            type="button"
            className="session-list__item sidebar__archive"
            data-active={archiveActive ? "true" : undefined}
            onClick={onOpenArchive}
          >
            <IconArchive />
            <span>Archive & trash</span>
          </button>
        </>
      )}
    </aside>
  );
}
