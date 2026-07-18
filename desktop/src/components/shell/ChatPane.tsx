import { type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Composer } from "../Composer";
import { MarkdownBody } from "../MarkdownBody";
import { ThinkingIndicator } from "../ThinkingIndicator";
import { StreamLiveRegion } from "../StreamLiveRegion";
import { nextRovingIndex } from "../../lib/a11y";
import { ToolCallList } from "../ToolCallList";
import { SourceCitations } from "../SourceCitations";
import { formatMsgMetaFooter, shortSourceLabel, type ChatSession, type Msg } from "../../lib/session";
import { hostOpenExternalUrl, hostReadFile, type BrandingDto, type ModelOptionDto } from "../../lib/host";

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function openExternalUrl(url: string) {
  void hostOpenExternalUrl(url).catch((err) => {
    console.error("open external url failed", err);
  });
}

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
  setPane: (p: "archive" | "source" | "chat") => void;
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
  openSettings: (section?: "preflight") => void;
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
  } = props;

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
                        <span className="session-tab__pin" aria-hidden>
                          📌
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
                  <div className="empty-state">
                    <div className="empty-state__title">{branding.name}</div>
                    <p className="empty-state__body">{branding.tagline}</p>
                    <p className="empty-state__body">
                      Ask about your workspace, code, or notes. Choose a model
                      in the composer if you want to switch.
                    </p>
                    {preflightBlocking ? (
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => openSettings("preflight")}
                      >
                        Fix setup issues
                      </button>
                    ) : null}
                  </div>
                ) : (
                  visibleMessages.map((m) => (
                    <article
                      key={m.id}
                      className="msg"
                      data-role={m.role}
                      data-msg-id={m.id}
                    >
                      <div className="msg__role">{m.role}</div>
                      {m.tools ? <ToolCallList tools={m.tools} /> : null}
                      {m.trail?.length ? (
                        <div className="search-trail" aria-label="Search trail">
                          {m.trail.map((s) => (
                            <span key={s} className="search-trail__step">
                              {s}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {m.citations?.length ? (
                        <SourceCitations
                          citations={m.citations.map((c) => ({
                            id: c.id,
                            label: shortSourceLabel(c.label, c.id),
                            title: c.title,
                          }))}
                          onOpenFile={(path) => {
                            setSourcePath(path);
                            setPane("source");
                            setSourceContent("Loading…");
                            void hostReadFile(path)
                              .then((body) => setSourceContent(body))
                              .catch((err) =>
                                setSourceContent(
                                  `Could not read ${path}:\n${
                                    err instanceof Error
                                      ? err.message
                                      : String(err)
                                  }`,
                                ),
                              );
                          }}
                        />
                      ) : null}
                      <div className="msg__bubble">
                        {m.role === "assistant" ? (
                          <>
                            {m.streaming &&
                            !m.content.trim() &&
                            turnStartedAt ? (
                              <ThinkingIndicator
                                startedAt={turnStartedAt}
                                model={effectiveChatModel}
                                hasTokens={false}
                              />
                            ) : null}
                            {m.content ? (
                              <div
                                className="msg__content"
                                data-streaming={m.streaming ? "true" : "false"}
                                onClick={(e) => {
                                  const t = e.target as HTMLElement;
                                  // Markdown external links → system browser (not WKWebView).
                                  const a = t.closest(
                                    "a.md-ext-link, a[href^='http']",
                                  ) as HTMLAnchorElement | null;
                                  if (a?.href && isHttpUrl(a.href)) {
                                    e.preventDefault();
                                    openExternalUrl(a.href);
                                    return;
                                  }
                                  const citeEl = t.closest(
                                    "[data-cite]",
                                  ) as HTMLElement | null;
                                  const cite = citeEl?.getAttribute("data-cite");
                                  if (!cite) return;
                                  if (isHttpUrl(cite)) {
                                    openExternalUrl(cite);
                                    return;
                                  }
                                  setSourcePath(cite);
                                  setPane("source");
                                  setSourceContent("Loading…");
                                  void hostReadFile(cite)
                                    .then((body) => setSourceContent(body))
                                    .catch((err) =>
                                      setSourceContent(
                                        `Could not read ${cite}:\n${
                                          err instanceof Error
                                            ? err.message
                                            : String(err)
                                        }`,
                                      ),
                                    );
                                }}
                              >
                                <MarkdownBody
                                  text={m.content}
                                  streaming={m.streaming}
                                />
                                {(m.streaming || m.content) && (
                                  <StreamLiveRegion
                                    text={m.content}
                                    streaming={Boolean(m.streaming)}
                                  />
                                )}
                              </div>
                            ) : null}
                            {m.streaming &&
                            m.content.trim() &&
                            turnStartedAt ? (
                              <div className="thinking-ind-wrap">
                                <ThinkingIndicator
                                  startedAt={turnStartedAt}
                                  model={effectiveChatModel}
                                  hasTokens
                                />
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div
                            className="msg__content"
                            data-streaming={m.streaming ? "true" : "false"}
                          >
                            {m.content}
                          </div>
                        )}
                      </div>
                      {m.role === "assistant" &&
                      m.meta &&
                      !m.streaming &&
                      formatMsgMetaFooter(m.meta) ? (
                        <footer
                          className="msg__meta"
                          title={[
                            m.meta.model,
                            m.meta.provider_label,
                            m.meta.provider_id,
                            m.meta.base_url,
                          ]
                            .filter(Boolean)
                            .join("\n")}
                        >
                          {formatMsgMetaFooter(m.meta)}
                        </footer>
                      ) : null}
                    </article>
                  ))
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
                <Composer
                  onSubmit={onSubmit}
                  disabled={busy}
                  busy={busy}
                  models={modelOptions}
                  selectedModelKey={effectiveModelKey}
                  onModelChange={setSessionModel}
                  onSetDefaultModel={(key) => void setAppDefaultModel(key)}
                  onStop={onStop}
                />
              </div>
            </div>
  );
}
