import {
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { Composer } from "../Composer";
import { SessionContextBar } from "../SessionContextBar";
import { nextRovingIndex } from "../../lib/a11y";
import { useMessageWindow } from "../../hooks/useMessageWindow";
import type { ChatSession, Msg } from "../../lib/session";
import type { BrandingDto, ModelOptionDto } from "../../lib/host";
import { IconPin } from "../icons";
import { MessageRow } from "./MessageRow";

/** Empty-chat starter prompts — fill composer so the user can edit before send. */
const STARTERS: { label: string; prompt: string }[] = [
  {
    label: "How auth works",
    prompt: "How does authentication work in this workspace?",
  },
  {
    label: "Summarize files",
    prompt:
      "Summarize the main topics in my allowlisted workspace files and cite sources.",
  },
  {
    label: "Remember this project",
    prompt:
      "What durable facts should I remember about this project? Suggest notes I could save to memory.",
  },
];

export type ChatPaneProps = {
  branding: BrandingDto;
  openChatSessions: ChatSession[];
  resolvedSessionId: string;
  messages: Msg[];
  visibleMessages: Msg[];
  isFolded: boolean;
  hiddenCount: number;
  compactKeep: number;
  hiddenPreview: string;
  showFullHistory: boolean;
  setShowFullHistory: (v: boolean) => void;
  setActiveSessionId: (id: string) => void;
  openChatCtxMenu: (e: ReactMouseEvent, id: string) => void;
  createSession: () => void;
  setPane: (p: "archive" | "source" | "chat" | "memory" | "compose") => void;
  setMemoryPath?: (p: string | null) => void;
  openCompositionFromMemoryId?: (sourceId: string) => void;
  chatScrollRef: RefObject<HTMLDivElement | null>;
  onChatScroll: () => void;
  unreadBelow: number;
  scrollChatToBottom: (b?: ScrollBehavior) => void;
  busy: boolean;
  turnStartedAt: number | null;
  effectiveChatModel: string | null | undefined;
  effectiveModelKey: string;
  modelOptions: ModelOptionDto[];
  setSessionModel: (key: string) => void;
  setAppDefaultModel: (key: string) => void;
  onSubmit: (text: string) => Promise<boolean>;
  onStop: () => void;
  preflightBlocking: boolean;
  openSettings: (section?: "health" | "workspace" | "ai") => void;
  setSourcePath: (p: string | null) => void;
  setSourceContent: (c: string) => void;
};

/** Chat tabpanel: session tabs + transcript + composer (#146). */
export function ChatPane(props: ChatPaneProps) {
  const {
    branding,
    openChatSessions,
    resolvedSessionId,
    messages,
    visibleMessages,
    isFolded,
    hiddenCount,
    compactKeep,
    hiddenPreview,
    showFullHistory,
    setShowFullHistory,
    setActiveSessionId,
    openChatCtxMenu,
    createSession,
    setPane,
    chatScrollRef,
    onChatScroll,
    unreadBelow,
    scrollChatToBottom,
    busy,
    turnStartedAt,
    effectiveChatModel,
    effectiveModelKey,
    modelOptions,
    setSessionModel,
    setAppDefaultModel,
    onSubmit,
    onStop,
    preflightBlocking,
    openSettings,
    setSourcePath,
    setSourceContent,
    setMemoryPath,
    openCompositionFromMemoryId,
  } = props;

  const windowed = useMessageWindow(visibleMessages, chatScrollRef);
  const [seedRequest, setSeedRequest] = useState<{
    id: number;
    text: string;
  } | null>(null);

  const fillStarter = (prompt: string) => {
    setSeedRequest({ id: Date.now(), text: prompt });
  };

  const kbdMod =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
      ? "⌘"
      : "Ctrl+";

  return (
            <div
              role="tabpanel"
              id="pane-panel-chat"
              aria-labelledby="pane-tab-chat"
              className="pane-panel"
            >
              <div
                className="session-tabs"
                role="tablist"
                aria-label="Open chats"
                onKeyDown={(e) => {
                  const ids = openChatSessions.map((s) => s.id);
                  if (ids.length === 0) return;
                  const idx = Math.max(
                    0,
                    ids.indexOf(resolvedSessionId ?? ""),
                  );
                  const next = nextRovingIndex(idx, ids.length, e.key);
                  if (next == null) return;
                  e.preventDefault();
                  setActiveSessionId(ids[next]);
                  window.requestAnimationFrame(() => {
                    document
                      .getElementById(`session-tab-${ids[next]}`)
                      ?.focus();
                  });
                }}
              >
                <div className="session-tabs__list">
                  {openChatSessions.map((s) => (
                    <button
                      key={s.id}
                      id={`session-tab-${s.id}`}
                      type="button"
                      role="tab"
                      className="session-tab"
                      data-active={
                        s.id === resolvedSessionId ? "true" : "false"
                      }
                      aria-selected={s.id === resolvedSessionId}
                      aria-controls="session-panel-chat"
                      tabIndex={s.id === resolvedSessionId ? 0 : -1}
                      title={`${s.title} — right-click for options`}
                      onClick={() => setActiveSessionId(s.id)}
                      onContextMenu={(e) => openChatCtxMenu(e, s.id)}
                    >
                      {s.pinned ? (
                        <span className="session-tab__pin" aria-hidden title="Pinned">
                          <IconPin />
                        </span>
                      ) : null}
                      <span className="session-tab__title">{s.title}</span>
                    </button>
                  ))}
                </div>
                <div className="session-tabs__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    title="New chat"
                    onClick={createSession}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    title="Browse archive & trash"
                    onClick={() => setPane("archive")}
                  >
                    Archive
                  </button>
                </div>
              </div>
              <div
                id="session-panel-chat"
                role="tabpanel"
                aria-label="Chat transcript"
                className="chat-scroll-wrap"
              >
              <div
                className="chat-scroll"
                ref={chatScrollRef}
                onScroll={onChatScroll}
              >
                {isFolded && hiddenCount > 0 ? (
                  <div className="compact-banner" role="status">
                    <div className="compact-banner__main">
                      <strong>
                        {hiddenCount} earlier message
                        {hiddenCount === 1 ? "" : "s"} folded
                      </strong>
                      <span className="compact-banner__meta">
                        Auto-hiding older turns · showing last {compactKeep} ·
                        nothing deleted
                      </span>
                    </div>
                    <div className="compact-banner__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setShowFullHistory(true)}
                      >
                        Show all
                      </button>
                    </div>
                    <details className="compact-banner__details">
                      <summary>Preview folded turns</summary>
                      <pre className="tool-row__detail">{hiddenPreview}</pre>
                    </details>
                  </div>
                ) : null}
                {showFullHistory && messages.length > compactKeep ? (
                  <div className="compact-banner compact-banner--expanded" role="status">
                    <div className="compact-banner__main">
                      <strong>Full history shown</strong>
                      <span className="compact-banner__meta">
                        {messages.length} messages · fold to declutter (never deletes)
                      </span>
                    </div>
                    <div className="compact-banner__actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setShowFullHistory(false)}
                      >
                        Fold older
                      </button>
                    </div>
                  </div>
                ) : null}
                {messages.length === 0 ? (
                  <div className="empty-state empty-state--chat">
                    <div className="empty-state__title">{branding.name}</div>
                    <p className="empty-state__body">{branding.tagline}</p>
                    <p className="empty-state__body">
                      Ask about your workspace, code, or notes. Starters fill
                      the composer — edit, then send.
                    </p>
                    <div
                      className="chat-starters"
                      role="group"
                      aria-label="Starter prompts"
                    >
                      {STARTERS.map((s) => (
                        <button
                          key={s.label}
                          type="button"
                          className="chat-starter"
                          disabled={busy || preflightBlocking}
                          title={s.prompt}
                          onClick={() => fillStarter(s.prompt)}
                        >
                          <span className="chat-starter__label">{s.label}</span>
                          <span className="chat-starter__hint">{s.prompt}</span>
                        </button>
                      ))}
                    </div>
                    <p className="empty-state__meta">
                      Command palette{" "}
                      <kbd className="empty-state__kbd">{kbdMod}K</kbd>
                      {preflightBlocking ? " · setup incomplete" : null}
                    </p>
                    {preflightBlocking ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => openSettings("health")}
                      >
                        Fix setup issues
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div
                    className="chat-transcript"
                    data-virtualized={windowed.virtualized ? "true" : "false"}
                    style={
                      windowed.virtualized
                        ? {
                            position: "relative",
                            height: windowed.totalHeight,
                          }
                        : undefined
                    }
                  >
                    {windowed.mounted.map(({ msg: m, top }) => (
                      <div
                        key={m.id}
                        className="chat-transcript__row"
                        style={
                          windowed.virtualized
                            ? {
                                position: "absolute",
                                top,
                                left: 0,
                                right: 0,
                              }
                            : undefined
                        }
                      >
                        <MessageRow
                          msg={m}
                          turnStartedAt={turnStartedAt}
                          effectiveChatModel={effectiveChatModel}
                          setSourcePath={setSourcePath}
                          setSourceContent={setSourceContent}
                          setPane={setPane}
                          setMemoryPath={setMemoryPath}
                          openCompositionFromMemoryId={
                            openCompositionFromMemoryId
                          }
                          onHeightChange={
                            windowed.virtualized
                              ? windowed.onHeightChange
                              : undefined
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {unreadBelow > 0 ? (
                <button
                  type="button"
                  className="chat-jump-unread"
                  onClick={() => scrollChatToBottom("smooth")}
                >
                  <span className="chat-jump-unread__count">
                    {unreadBelow > 99 ? "99+" : unreadBelow}
                  </span>
                  <span>
                    new message{unreadBelow === 1 ? "" : "s"}
                  </span>
                  <span className="chat-jump-unread__arrow" aria-hidden>
                    ↓
                  </span>
                </button>
              ) : null}
              </div>
              <div className="composer-dock">
                <SessionContextBar
                  sessionId={resolvedSessionId || null}
                  disabled={busy}
                />
                <Composer
                  onSubmit={onSubmit}
                  disabled={busy}
                  busy={busy}
                  models={modelOptions}
                  selectedModelKey={effectiveModelKey}
                  onModelChange={setSessionModel}
                  onSetDefaultModel={(key) => void setAppDefaultModel(key)}
                  onStop={onStop}
                  seedRequest={seedRequest}
                />
              </div>
            </div>
  );
}
