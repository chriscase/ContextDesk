import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { Composer } from "../Composer";
import { SessionContextBar } from "../SessionContextBar";
import { useMessageWindow } from "../../hooks/useMessageWindow";
import type { ChatSession, Msg } from "../../lib/session";
import {
  hostOpenLogExplorer,
  hostOpenLogExplorerTarget,
  type BrandingDto,
  type ModelOptionDto,
} from "../../lib/host";
import { openPersistedLogCitation as openPersistedLogCitationCore } from "../../lib/citations";
import { IconPin } from "../icons";
import { MessageRow } from "./MessageRow";
import { useActivityInspector } from "../../hooks/useActivityInspector";
import { buildActivityTurn } from "../../lib/activity/adapter";
import { fetchTurnActivity } from "../../lib/engine/turnActivity";
import type { HostTurnActivityRecord } from "../../lib/activity/types";
import { ActivityToggle } from "../activity/ActivityToggle";
import { ActivityDrawer } from "../activity/ActivityDrawer";
import { ActivityDock } from "../activity/ActivityDock";

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

/** Open a host-authored log citation via exact-nav; never substitutes corpus (#698). */
export async function openPersistedLogCitation(
  sourceId: string,
  corpusId: string | undefined,
  showUnavailable: (sourceId: string, message: string) => void,
): Promise<boolean> {
  return openPersistedLogCitationCore(
    sourceId,
    corpusId,
    showUnavailable,
    hostOpenLogExplorer,
    (id, target) => hostOpenLogExplorerTarget(id, target),
  );
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
  /**
   * When true, the user is detached from the transcript bottom.
   * Label is neutral unless `hasNewResponseBelow` is also true (#696).
   */
  showJumpToLatest: boolean;
  /** True only when assistant content arrived while detached (#696). */
  hasNewResponseBelow: boolean;
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
  /**
   * A launch-critical provider probe is configured but has never run (#746).
   * Never blocks conversation — it only stops the home presenting readiness
   * that nothing has measured.
   */
  providerUnverified?: boolean;
  openSettings: (section?: "health" | "workspace" | "ai") => void;
  setSourcePath: (p: string | null) => void;
  setSourceContent: (c: string) => void;
  /** Session skill pin (#343). */
  pinnedSkillId?: string | null;
  onPinnedSkillChange?: (skillId: string | null) => void;
  /** One imported log corpus explicitly attached to this chat (#695). */
  linkedCorpusId?: string | null;
  /** Host validation/persistence of a corpus attachment is in flight. */
  contextMutationPending?: boolean;
  onLinkedCorpusChange?: (corpusId: string | null) => Promise<void> | void;
  /** Optional guided setup catalog (#447) — never required. */
  onOpenGuidedSetup?: () => void;
  /** Start a specific wizard by id (empty-state cards). */
  onStartWizard?: (wizardId: string) => void;
  /** Whether current configuration authorizes at least one workspace root. */
  hasAuthorizedWorkspaceContent?: boolean;
  /** External composer seed from wizard completion. */
  externalSeedRequest?: { id: number; text: string } | null;
  /** Draft for the active conversation, owned above the pane switch. */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** Retire a spent wizard seed so a remount cannot replay it. */
  onSeedConsumed?: (seedId: number) => void;
  /** Re-test native tool support for one exact provider/model pair (#650). */
  onRetryModelTools?: (model: ModelOptionDto) => Promise<void> | void;
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
    openChatCtxMenu,
    createSession,
    setPane,
    chatScrollRef,
    onChatScroll,
    showJumpToLatest,
    hasNewResponseBelow,
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
    linkedCorpusId = null,
    contextMutationPending = false,
    onLinkedCorpusChange,
    preflightBlocking,
    providerUnverified = false,
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
    draft,
    onDraftChange,
    onSeedConsumed,
    onRetryModelTools,
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
  const activeSession =
    openChatSessions.find((session) => session.id === resolvedSessionId) ??
    null;

  // Activity Inspector: a read-only observability layer over the turn the
  // host already ran. Nothing here participates in sending a message, and
  // with the mode Off no surface mounts at all.
  const activity = useActivityInspector();
  const [activityRecords, setActivityRecords] = useState<
    Record<string, HostTurnActivityRecord | null>
  >({});

  // Settled assistant messages whose host record we have not asked for yet.
  // Keyed by message id, which is exactly how the host filed the record.
  const pendingRecordIds = useMemo(() => {
    if (activity.mode === "off" || !resolvedSessionId) return [] as string[];
    return messages
      .filter((m) => m.role === "assistant" && !m.streaming)
      .map((m) => m.id)
      .filter((id) => !(id in activityRecords));
  }, [activity.mode, resolvedSessionId, messages, activityRecords]);

  useEffect(() => {
    if (pendingRecordIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      const loaded: Record<string, HostTurnActivityRecord | null> = {};
      for (const id of pendingRecordIds) {
        loaded[id] = await fetchTurnActivity(resolvedSessionId, id);
      }
      // A null result is cached deliberately: "the host has no record for
      // this turn" is an answer, and re-asking every render would hammer IPC.
      if (!cancelled) setActivityRecords((prev) => ({ ...loaded, ...prev }));
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingRecordIds, resolvedSessionId]);

  const buildTurnFor = useCallback(
    (msg: Msg) =>
      buildActivityTurn(msg, { record: activityRecords[msg.id] ?? null }),
    [activityRecords],
  );

  // Docked mode defaults to the latest settled assistant turn so the rail is
  // never blank the moment a user opts in.
  useEffect(() => {
    if (activity.mode !== "docked" || activity.selectedTurnId) return;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && !m.streaming);
    if (lastAssistant) activity.selectTurn(lastAssistant.id);
  }, [activity, messages]);

  const selectedActivityTurn = useMemo(() => {
    if (!activity.selectedTurnId) return null;
    const msg = messages.find((m) => m.id === activity.selectedTurnId);
    return msg ? buildTurnFor(msg) : null;
  }, [activity.selectedTurnId, messages, buildTurnFor]);

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
      <header className="chat-header">
        <div className="chat-header__identity">
          {activeSession?.pinned ? (
            <span className="chat-header__pin" aria-hidden title="Pinned">
              <IconPin />
            </span>
          ) : null}
          <div className="chat-header__title-wrap">
            <span className="chat-header__eyebrow">Conversation</span>
            <h2 className="chat-header__title">
              {activeSession?.title || "New chat"}
            </h2>
          </div>
        </div>
        <div className="chat-header__actions">
          <ActivityToggle mode={activity.mode} onChange={activity.setMode} />
          <div className="chat-new-split" title="New chat">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title="New blank chat"
              onClick={createSession}
            >
              New
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
          {activeSession ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm chat-header__more"
              aria-label={`Options for ${activeSession.title}`}
              title="Chat options"
              onClick={(event) => openChatCtxMenu(event, activeSession.id)}
            >
              •••
            </button>
          ) : null}
        </div>
      </header>
      <div className="chat-body-row">
      <div className="chat-main-column">
      {/*
        A region, not a tabpanel: this sits *inside* the chat tabpanel and has
        no tab of its own, so `role="tabpanel"` here described a relationship
        that does not exist.
      */}
      <div
        id="session-panel-chat"
        role="region"
        aria-label="Chat transcript"
        className="chat-scroll-wrap"
      >
        <div
          className="chat-scroll"
          ref={chatScrollRef}
          onScroll={onChatScroll}
          // The transcript scrolls, so it must be reachable and scrollable
          // without a pointer. Focus styling lives in base.css.
          tabIndex={0}
          aria-label={`Transcript for ${activeSession?.title || "this chat"}`}
        >
          {isFolded && hiddenCount > 0 ? (
            <div className="compact-banner" role="status">
              <div className="compact-banner__main">
                <strong>
                  {hiddenCount} earlier message
                  {hiddenCount === 1 ? "" : "s"} folded
                </strong>
                <span className="compact-banner__meta">
                  Auto-hiding older turns · showing last {compactKeep} · nothing
                  deleted
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
            <div
              className="compact-banner compact-banner--expanded"
              role="status"
            >
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
                hasAuthorizedWorkspaceContent ? "workspace" : "chat-only"
              }
              data-preflight={
                preflightBlocking
                  ? "blocked"
                  : providerUnverified
                    ? "unverified"
                    : "ready"
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
                    Starters fill the composer for review. Guided workflows
                    launch explicitly and remain cancellable.
                  </p>
                </div>
                <div>
                  <p className="empty-state__meta">
                    Command palette{" "}
                    <kbd className="empty-state__kbd">{kbdMod}K</kbd>
                    {preflightBlocking
                      ? " · setup incomplete"
                      : providerUnverified
                        ? " · provider not verified"
                        : null}
                  </p>
                  {preflightBlocking ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => openSettings("health")}
                    >
                      Fix setup issues
                    </button>
                  ) : providerUnverified ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      data-testid="first-chat-verify-provider"
                      onClick={() => openSettings("ai")}
                    >
                      Test connection
                    </button>
                  ) : null}
                </div>
              </header>
              {preflightBlocking ? (
                <p className="empty-state__blocked-note" role="status">
                  Conversation actions are paused until the setup checks above
                  are resolved.
                </p>
              ) : (
                <>
                  {providerUnverified ? (
                    <p
                      className="empty-state__unverified-note"
                      data-testid="first-chat-unverified-note"
                      role="status"
                    >
                      The selected provider is configured but has not answered a
                      live check yet. You can still start a conversation; the
                      first send is what will prove it works.
                    </p>
                  ) : null}
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
                          className="first-chat-workflow-grid"
                          role="group"
                          aria-label="Guided workflows"
                        >
                          {onStartWizard ? (
                            <>
                              <button
                                type="button"
                                className="chat-action-card first-chat-workflow-card"
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
                                  Import a log set, review its analysis, then
                                  continue in linked chat
                                </span>
                              </button>
                              <button
                                type="button"
                                className="chat-action-card first-chat-workflow-card"
                                data-testid="chat-guided-workflow"
                                data-action="launch-workflow"
                                disabled={busy}
                                aria-label="Memory primer; launches a guided workflow"
                                onClick={() => onStartWizard("memory-primer")}
                              >
                                <span className="chat-action-card__kind">
                                  Guided workflow
                                </span>
                                <strong>Organize memory</strong>
                                <span>
                                  Review candidate notes before anything becomes
                                  durable memory
                                </span>
                              </button>
                            </>
                          ) : null}
                          {onOpenGuidedSetup ? (
                            <button
                              type="button"
                              className="chat-action-card first-chat-workflow-card"
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
                </>
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
                    openCompositionFromMemoryId={openCompositionFromMemoryId}
                    onOpenHelpCitation={onOpenHelpCitation}
                    onOpenLogCitation={(sourceId, citationCorpusId) => {
                      void openPersistedLogCitation(
                        sourceId,
                        citationCorpusId,
                        (unavailableSourceId, message) => {
                          setSourcePath(unavailableSourceId);
                          setSourceContent(message);
                          setPane("source");
                        },
                      );
                    }}
                    onHeightChange={
                      windowed.virtualized ? windowed.onHeightChange : undefined
                    }
                    activityMode={activity.mode}
                    activityTurn={
                      activity.mode !== "off" && m.role === "assistant"
                        ? buildTurnFor(m)
                        : null
                    }
                    onOpenActivityDetails={activity.openDrawerFor}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {showJumpToLatest ? (
          <button
            type="button"
            className={
              hasNewResponseBelow
                ? "chat-jump-unread chat-jump-unread--new"
                : "chat-jump-unread"
            }
            data-testid="chat-jump-latest"
            onClick={() => scrollChatToBottom("smooth")}
            aria-label={
              hasNewResponseBelow
                ? "New response · Jump to latest"
                : "Jump to latest"
            }
          >
            <span>
              {hasNewResponseBelow
                ? "New response · Jump to latest"
                : "Jump to latest"}
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
          disabled={busy || contextMutationPending}
          updating={contextMutationPending}
          pinnedSkillId={pinnedSkillId}
          onPinnedSkillChange={onPinnedSkillChange}
          linkedCorpusId={linkedCorpusId}
          onLinkedCorpusChange={onLinkedCorpusChange}
        />
        <Composer
          onSubmit={onSubmit}
          disabled={busy || contextMutationPending}
          busy={busy}
          disabledReason={
            contextMutationPending
              ? "Updating this chat's context — sending resumes when it finishes"
              : preflightBlocking
                ? // Sending is not blocked here — it opens Settings instead —
                  // so this must show while the composer is still usable.
                  "Setup checks are unresolved — sending opens Settings instead"
                : undefined
          }
          models={modelOptions}
          selectedModelKey={effectiveModelKey}
          onModelChange={setSessionModel}
          onSetDefaultModel={(key) => void setAppDefaultModel(key)}
          onStop={onStop}
          seedRequest={effectiveSeed}
          onSeedConsumed={onSeedConsumed}
          draft={draft}
          onDraftChange={onDraftChange}
          onRetryModelTools={onRetryModelTools}
        />
      </div>
      </div>
      {activity.surface === "docked" ? (
        <ActivityDock
          turn={selectedActivityTurn}
          width={activity.dockWidth}
          onWidthChange={activity.setDockWidth}
          onCollapse={() => activity.selectTurn(null)}
        />
      ) : null}
      </div>
      {activity.surface === "drawer" ? (
        <ActivityDrawer
          turn={selectedActivityTurn}
          onClose={activity.closeDrawer}
        />
      ) : null}
    </div>
  );
}
