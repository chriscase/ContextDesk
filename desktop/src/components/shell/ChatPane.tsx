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

type Starter = {
  label: string;
  outcome: string;
  prompt: string;
};

/** Empty-chat starter prompts — fill composer so the user can edit before send. */
const WORKSPACE_STARTERS: Starter[] = [
  {
    label: "How auth works",
    outcome: "Trace an implementation with citations",
    prompt: "How does authentication work in this workspace?",
  },
  {
    label: "Summarize files",
    outcome: "Synthesize authorized workspace sources",
    prompt:
      "Summarize the main topics in my allowlisted workspace files and cite sources.",
  },
  {
    label: "Remember this project",
    outcome: "Propose durable notes for review",
    prompt:
      "What durable facts should I remember about this project? Suggest notes I could save to memory.",
  },
];

const CONTEXT_SAFE_STARTERS: Starter[] = [
  {
    label: "Plan a technical task",
    outcome: "Turn an outcome and constraints into next steps",
    prompt:
      "Help me plan a technical task. Start by asking what outcome and constraints matter.",
  },
  {
    label: "Review context I add",
    outcome: "Analyze only files or notes I explicitly attach",
    prompt:
      "Help me analyze the files or notes I choose to attach to this chat. Cite only context you can actually access.",
  },
  {
    label: "Draft a careful note",
    outcome: "Separate supplied facts from uncertainty",
    prompt:
      "Help me draft a concise project note from facts I provide. Clearly mark uncertain statements.",
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
  setPane: (
    p: "archive" | "source" | "chat" | "memory" | "compose" | "help",
  ) => void;
  setMemoryPath?: (p: string | null) => void;
  openCompositionFromMemoryId?: (sourceId: string) => void;
  /** Route a canonical help:// citation to the bundled Help pane. */
  onOpenHelpCitation?: (locator: string) => void;
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
  /** Session skill pin (#343). */
  pinnedSkillId?: string | null;
  onPinnedSkillChange?: (skillId: string | null) => void;
  /** Optional guided setup catalog (#447) — never required. */
  onOpenGuidedSetup?: () => void;
  /** Start a specific wizard by id (empty-state cards). */
  onStartWizard?: (wizardId: string) => void;
  /** Whether current configuration authorizes at least one workspace root. */
  hasAuthorizedWorkspaceContent?: boolean;
  /** External composer seed from wizard completion. */
  externalSeedRequest?: { id: number; text: string } | null;
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
    pinnedSkillId = null,
    onPinnedSkillChange,
    preflightBlocking,
    openSettings,
    setSourcePath,
    setSourceContent,
    setMemoryPath,
    openCompositionFromMemoryId,
    onOpenHelpCitation,
    onOpenGuidedSetup,
    onStartWizard,
    hasAuthorizedWorkspaceContent = false,
    externalSeedRequest = null,
  } = props;

  const windowed = useMessageWindow(visibleMessages, chatScrollRef);
  const [seedRequest, setSeedRequest] = useState<{
    id: number;
    text: string;
  } | null>(null);

  const fillStarter = (prompt: string) => {
    setSeedRequest({ id: Date.now(), text: prompt });
  };

  // Wizard / parent seed takes precedence when id changes.
  const effectiveSeed = externalSeedRequest ?? seedRequest;
  const starters = hasAuthorizedWorkspaceContent
    ? WORKSPACE_STARTERS
    : CONTEXT_SAFE_STARTERS;

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
                  <div className="chat-new-split" title="New chat">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      title="New blank chat"
                      onClick={createSession}
                    >
                      +
                    </button>
                    {onOpenGuidedSetup ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title="Guided setup (optional)"
                        onClick={onOpenGuidedSetup}
                      >
                        Guided…
                      </button>
                    ) : null}
                  </div>
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
                  <div
                    className="empty-state empty-state--chat"
                    data-testid="first-chat-home"
                    data-content-scope={
                      hasAuthorizedWorkspaceContent
                        ? "workspace"
                        : "chat-only"
                    }
                    data-preflight={
                      preflightBlocking ? "blocked" : "ready"
                    }
                    data-busy={busy ? "true" : "false"}
                  >
                    <header className="empty-state__hero">
                      <div>
                        <div className="empty-state__title">{branding.name}</div>
                        <p className="empty-state__body empty-state__lead">
                          {branding.tagline}
                        </p>
                        <p className="empty-state__body">
                          {hasAuthorizedWorkspaceContent
                            ? "Ask about authorized workspace sources, logs, or notes."
                            : "Ask a general question or add chat-only files and notes when you need grounded context."}{" "}
                          Starters fill the composer for review. Guided
                          workflows launch explicitly and remain cancellable.
                        </p>
                      </div>
                      <div>
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
                    </header>
                    {preflightBlocking ? (
                      <p className="empty-state__blocked-note" role="status">
                        Conversation actions are paused until the setup checks
                        above are resolved.
                      </p>
                    ) : (
                      <div className="empty-state__action-grid">
                        <section aria-labelledby="first-chat-starters-label">
                          <div
                            className="empty-state__section-label"
                            id="first-chat-starters-label"
                          >
                            Start a conversation
                          </div>
                          <div
                            className="chat-starters"
                            role="group"
                            aria-label="Starter prompts"
                          >
                            {starters.map((s) => (
                              <button
                                key={s.label}
                                type="button"
                                className="chat-action-card chat-starter"
                                data-testid="chat-starter"
                                data-action="fill-composer"
                                disabled={busy}
                                aria-label={`${s.label}; fills the composer for review`}
                                title={s.prompt}
                                onClick={() => fillStarter(s.prompt)}
                              >
                                <span className="chat-action-card__kind">
                                  Fills composer
                                </span>
                                <span className="chat-starter__label">
                                  {s.label}
                                </span>
                                <span className="chat-starter__hint">
                                  {s.outcome}
                                </span>
                              </button>
                            ))}
                          </div>
                        </section>
                        {onStartWizard || onOpenGuidedSetup ? (
                          <section aria-labelledby="first-chat-setup-label">
                            <div
                              className="empty-state__section-label"
                              id="first-chat-setup-label"
                            >
                              Guided workflows
                            </div>
                            <div
                              className="chat-wizard-cards"
                              role="group"
                              aria-label="Guided workflows"
                            >
                              {onStartWizard ? (
                                <>
                                  <button
                                    type="button"
                                    className="chat-action-card chat-wizard-card"
                                    data-testid="chat-guided-workflow"
                                    data-action="launch-workflow"
                                    disabled={busy}
                                    aria-label="Log troubleshooting; launches a guided workflow"
                                    onClick={() =>
                                      onStartWizard("log-troubleshooting")
                                    }
                                  >
                                    <span className="chat-action-card__kind">
                                      Guided workflow
                                    </span>
                                    <strong>Investigate logs</strong>
                                    <span>
                                      Import a log set, review its analysis,
                                      then continue in linked chat
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    className="chat-action-card chat-wizard-card"
                                    data-testid="chat-guided-workflow"
                                    data-action="launch-workflow"
                                    disabled={busy}
                                    aria-label="Memory primer; launches a guided workflow"
                                    onClick={() =>
                                      onStartWizard("memory-primer")
                                    }
                                  >
                                    <span className="chat-action-card__kind">
                                      Guided workflow
                                    </span>
                                    <strong>Organize memory</strong>
                                    <span>
                                      Review candidate notes before anything
                                      becomes durable memory
                                    </span>
                                  </button>
                                </>
                              ) : null}
                              {onOpenGuidedSetup ? (
                                <button
                                  type="button"
                                  className="chat-action-card chat-wizard-card"
                                  data-testid="chat-guided-workflow"
                                  data-action="launch-workflow"
                                  disabled={busy}
                                  aria-label="Browse all guided workflows"
                                  onClick={onOpenGuidedSetup}
                                >
                                  <span className="chat-action-card__kind">
                                    Browse
                                  </span>
                                  <strong>All guided workflows…</strong>
                                  <span>
                                    Choose another optional, cancellable setup
                                  </span>
                                </button>
                              ) : null}
                            </div>
                          </section>
                        ) : null}
                      </div>
                    )}
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
                          onOpenHelpCitation={onOpenHelpCitation}
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
                  pinnedSkillId={pinnedSkillId}
                  onPinnedSkillChange={onPinnedSkillChange}
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
                  seedRequest={effectiveSeed}
                />
              </div>
            </div>
  );
}
