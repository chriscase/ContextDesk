/**
 * Compact corpus-linked chat rail for Log Explorer (#529, #530, #543).
 * Owns follow-latest scroll, multi-chat switcher, tool visibility, and
 * privacy-safe agent-context disclosure — not raw debug dumps.
 *
 * Long-transcript policy (#543):
 * - Persistence retains every message (no deletion).
 * - The rail mounts a virtualized window via `useMessageWindow` once the
 *   thread exceeds VIRTUALIZE_THRESHOLD rows; streaming/pending turns stay
 *   force-mounted; per-chat draft/scroll/follow state survives switches.
 * - `openChat` uses a monotonic request generation so a slow load for chat A
 *   cannot overwrite chat B after the user switches.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  agentTurn,
  hostArchiveChatSession,
  hostCancelTurn,
  hostListChatModels,
  hostListChatSessionsForCorpus,
  hostLoadChatSession,
  hostPinChatSession,
  hostRenameChatSession,
  hostSaveChatSession,
  hostSetChatLinkedCorpus,
  hostSetModelToolsEnabled,
  modelSelectionKey,
  parseModelSelectionKey,
  type ChatSessionDto,
  type EventDto,
  type ModelOptionDto,
  type SessionMetaDto,
} from "../../lib/host";
import {
  applyEventsToMessage,
  newSession,
  nowIso,
  sessionFromDto,
  sessionToDto,
  type ChatMsg,
} from "../../lib/session";
import {
  extractAndCleanLogNav,
  extractLogNavFromText,
  LOG_NAV_UNREADABLE_MESSAGE,
  type LogNavAction,
} from "../../lib/logExplorer/logNav";
import {
  classifyCompletedCitation,
  openPersistedLogCitation,
  parseLogEventSeq,
  parseLogTemplateId,
} from "../../lib/citations";
import { hostOpenLogExplorer } from "../../lib/host";
import { useMessageWindow } from "../../hooks/useMessageWindow";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { HELP_LINKED_CHAT_CONTEXT } from "../../lib/helpContent";
import { HelpTip } from "../HelpTip";
import { IconChevronRight } from "../icons";
import { MarkdownBody } from "../MarkdownBody";
import { SourceCitations } from "../SourceCitations";
import { ToolCallList } from "../ToolCallList";

export function hasHostLinkedSynthesisRetry(
  events: EventDto[],
  sessionId: string,
  corpusId: string,
  providerProfileId: string,
  modelId: string,
): boolean {
  return events.some(
    (event) =>
      event.kind === "linked_synthesis_retry" &&
      event.payload.available === true &&
      event.payload.session_id === sessionId &&
      event.payload.corpus_id === corpusId &&
      event.payload.provider_profile_id === providerProfileId &&
      event.payload.model_id === modelId,
  );
}

/** Format elapsed ms for linked-turn phase display. */
export function formatLinkedElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function LinkedElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span
      className="log-explorer__chat-elapsed"
      data-testid="linked-chat-elapsed"
      aria-hidden="true"
    >
      {formatLinkedElapsed(Math.max(0, now - startedAt))}
    </span>
  );
}

/**
 * Visible assistant body: strip machine log_nav JSON; quiet unreadable note.
 * While streaming, incomplete nav-like JSON must not flash the unreadable
 * message — only strip what we can; gate unreadable on !streaming.
 */
export function LinkedAssistantBody({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  const cleaned = useMemo(() => extractAndCleanLogNav(content), [content]);
  const prose = cleaned.displayText;
  const showUnreadable = cleaned.unreadableProposal && !streaming;
  return (
    <>
      {prose ? <MarkdownBody text={prose} streaming={streaming} /> : null}
      {!prose && !showUnreadable && streaming ? (
        <MarkdownBody text="" streaming />
      ) : null}
      {showUnreadable ? (
        <p
          className="log-explorer__nav-unreadable"
          data-testid="linked-chat-nav-unreadable"
        >
          {LOG_NAV_UNREADABLE_MESSAGE}
        </p>
      ) : null}
    </>
  );
}

export type AgentContextSummary = {
  corpusId: string;
  timeQuality: string;
  linkMode: boolean;
  lanes: string[];
  levels: string[];
  sources: string[];
  keyword: string | null;
  selectedCount: number;
  bookmarkCount: number;
  /** Privacy-safe one-line brief for the host turn snapshot. */
  brief: string;
  /** Noise policy state for Context shared with agent (#817). */
  noisePolicyLabel?: string;
  noiseRuleCount?: number;
  noiseExcludedEventCount?: number | null;
  noisePolicyHiddenCount?: number | null;
  noiseExcludedNotAnalyzed?: boolean;
  noiseLensSuspended?: boolean;
  noiseDisclosure?: string;
};

type Props = {
  corpusId: string;
  corpusName: string;
  agentContext: AgentContextSummary;
  onApplyNav: (action: LogNavAction) => void;
  /** Narrow layout: keep rail usable without page overflow. */
  compactLayout?: boolean;
  /** Normal/wide layout: retain state while presenting only a reopen strip. */
  collapsed?: boolean;
  /** Keep chat state mounted while another Investigation mode is visible. */
  visible?: boolean;
  /** Explicit desktop grid track so optional splitters cannot shift the rail. */
  desktopGridColumn?: number;
  /** Shared Investigation mode control rendered above the chat header. */
  modeControl?: ReactNode;
  /** Prepare and focus a privacy-safe prompt from an Explorer action. */
  externalDraftRequest?: {
    id: number;
    text: string;
  } | null;
  /** When true, expose collapsed technical diagnostics (dev). */
  developerMode?: boolean;
  /** Compact parent indicator without duplicating chat/session state. */
  onRailSummary?: (summary: {
    chatCount: number;
    hasActiveChat: boolean;
    busy: boolean;
  }) => void;
  onRequestClose?: () => void;
  onToggleCollapsed?: () => void;
};

const NEAR_BOTTOM_PX = 64;
const SWITCHER_SEARCH_THRESHOLD = 8;
const GOVERNED_LOG_TOOL_NAMES = new Set([
  "search_logs",
  "cluster_problems",
  "timeline",
  "correlate_logs",
  "anomalies_logs",
  "trace_logs",
]);

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

function showsLinkedEvidenceTrustDisclosure(message: ChatMsg): boolean {
  if (
    message.role !== "assistant" ||
    message.streaming ||
    !message.content.trim() ||
    message.content.includes("**Error:**") ||
    message.content.includes("**Limited context:**")
  ) {
    return false;
  }
  return Boolean(
    message.tools?.some(
      (tool) => tool.ok === true && GOVERNED_LOG_TOOL_NAMES.has(tool.name),
    ),
  );
}

/** True when a completed load should still apply to the rail. */
export function shouldApplyChatLoad(
  requestGen: number,
  currentGen: number,
  loadedId: string,
  activeId: string | null,
): boolean {
  return requestGen === currentGen && activeId === loadedId;
}

function mapSessionMessages(session: {
  messages: {
    id: string;
    role: string;
    content: string;
    tools?: ChatMsg["tools"];
    citations?: ChatMsg["citations"];
    trail?: ChatMsg["trail"];
  }[];
}): ChatMsg[] {
  return session.messages.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    tools: m.tools,
    citations: m.citations,
    trail: m.trail,
  }));
}

function selectionForSession(
  session: {
    chatModel: string | null;
    providerProfileId: string | null;
  },
  options: ModelOptionDto[],
  fallback: string,
): string {
  if (session.chatModel && session.providerProfileId) {
    return modelSelectionKey(session.providerProfileId, session.chatModel);
  }
  if (session.chatModel) {
    return (
      options.find((option) => option.id === session.chatModel)
        ?.selection_key ?? session.chatModel
    );
  }
  return fallback;
}

function LinkedChatBubble({
  message,
  developerMode,
  onHeightChange,
  virtualized,
  top,
  onOpenCitation,
}: {
  message: ChatMsg;
  developerMode: boolean;
  onHeightChange?: (id: string, height: number) => void;
  virtualized: boolean;
  top: number;
  onOpenCitation?: (sourceId: string, corpusId?: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!onHeightChange || !ref.current) return;
    const el = ref.current;
    const report = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) onHeightChange(message.id, h);
    };
    report();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => report())
        : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [
    message.id,
    message.content,
    message.streaming,
    message.tools,
    message.citations,
    onHeightChange,
  ]);

  return (
    <div
      ref={ref}
      className={`log-explorer__chat-bubble log-explorer__chat-bubble--${message.role}`}
      data-testid={`linked-chat-msg-${message.role}`}
      data-msg-id={message.id}
      style={
        virtualized
          ? {
              position: "absolute",
              top,
              left: 0,
              right: 0,
            }
          : undefined
      }
    >
      <div className="log-explorer__chat-role">
        {message.role}
        {message.streaming ? " · streaming" : ""}
      </div>
      {message.tools && message.tools.length > 0 ? (
        <ToolCallList tools={message.tools} collapseAfter={4} />
      ) : null}
      {message.citations && message.citations.length > 0 ? (
        <SourceCitations
          citations={message.citations.map((c) => ({
            id: c.id,
            label: c.label,
            title: c.title,
          }))}
          onOpenFile={(path) => {
            const corpusId = message.citations?.find(
              (citation) => citation.id === path,
            )?.corpusId;
            onOpenCitation?.(path, corpusId);
          }}
        />
      ) : null}
      <LinkedAssistantBody
        content={message.content}
        streaming={message.streaming}
      />
      {showsLinkedEvidenceTrustDisclosure(message) ? (
        <div
          className="log-explorer__chat-preview"
          data-testid="linked-evidence-trust-disclosure"
        >
          Evidence references verified · model interpretation not verified
        </div>
      ) : null}
      {message.trail && message.trail.length > 0 && developerMode ? (
        <details className="log-explorer__chat-technical">
          <summary>Technical details</summary>
          <div className="log-explorer__chat-trail" aria-label="Search trail">
            {message.trail.join(" → ")}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function LinkedChatRail({
  corpusId,
  corpusName,
  agentContext,
  onApplyNav,
  compactLayout = false,
  collapsed = false,
  visible = true,
  desktopGridColumn,
  modeControl,
  externalDraftRequest,
  developerMode = false,
  onRailSummary,
  onRequestClose,
  onToggleCollapsed,
}: Props) {
  const [chats, setChats] = useState<SessionMetaDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOptionDto[]>([]);
  const [newChatSelection, setNewChatSelection] = useState("");
  const [selectionByChat, setSelectionByChat] = useState<
    Record<string, string>
  >({});
  const [modelLoadError, setModelLoadError] = useState<string | null>(null);
  const [modelRetrying, setModelRetrying] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const modelHelpId = useId();
  const composerHelpId = useId();
  const switcherLayerId = useId();
  const manageLayerId = useId();
  /**
   * Turn-owned UI state is keyed by chat. A pending/error/completed turn for
   * chat A must not leak into chat B when the user switches mid-turn (#543).
   */
  const [busyByChat, setBusyByChat] = useState<Record<string, boolean>>({});
  /** Epoch ms when the current turn became busy (per chat). */
  const [turnStartedAtByChat, setTurnStartedAtByChat] = useState<
    Record<string, number | null>
  >({});
  /** Host-authored phase label only (null = honestly indeterminate). */
  const [hostPhaseByChat, setHostPhaseByChat] = useState<
    Record<string, string | null>
  >({});
  const [cancellationRequestedByChat, setCancellationRequestedByChat] =
    useState<Record<string, boolean>>({});
  const [errorByChat, setErrorByChat] = useState<Record<string, string | null>>(
    {},
  );
  const [statusByChat, setStatusByChat] = useState<
    Record<string, string | null>
  >({});
  const [synthesisRetryByChat, setSynthesisRetryByChat] = useState<
    Record<string, boolean>
  >({});
  const [navChipsByChat, setNavChipsByChat] = useState<
    Record<string, LogNavAction[]>
  >({});
  /** Errors before a chat identity exists (list/create) remain rail-scoped. */
  const [railError, setRailError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageBusy, setManageBusy] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [devJson, setDevJson] = useState("");
  /** Per-chat follow mode; default true for new chats. */
  const [followByChat, setFollowByChat] = useState<Record<string, boolean>>({});
  const [detachedByChat, setDetachedByChat] = useState<Record<string, boolean>>(
    {},
  );
  const [newContentByChat, setNewContentByChat] = useState<
    Record<string, boolean>
  >({});
  /** Per-chat drafts so switching chats does not lose unsent text. */
  const draftsRef = useRef<Record<string, string>>({});
  /** Per-chat scroll offsets so returning to a chat restores position. */
  const scrollByChatRef = useRef<Record<string, number>>({});
  /** Monotonic generation for openChat loads (#543 race safety). */
  const openGenRef = useRef(0);
  const switcherToggleRef = useRef<HTMLButtonElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const manageToggleRef = useRef<HTMLButtonElement>(null);
  const manageRef = useRef<HTMLDivElement>(null);
  const collapseToggleRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const previousCollapsedRef = useRef(collapsed);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusComposerAfterTurnRef = useRef<string | null>(null);
  const appliedExternalDraftRequestRef = useRef<number | null>(null);
  const creatingTurnChatRef = useRef(false);
  const sendingChatsRef = useRef<Set<string>>(new Set());
  const cancellationRequestsRef = useRef<Set<string>>(new Set());
  const terminalChatsRef = useRef<Set<string>>(new Set());
  const detachedByChatRef = useRef(detachedByChat);
  detachedByChatRef.current = detachedByChat;

  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  const windowed = useMessageWindow(messages, threadRef);

  const rememberModels = useCallback((options: ModelOptionDto[]) => {
    setModelOptions(options);
    const preferred =
      options.find((option) => option.is_default) ?? options[0] ?? null;
    if (preferred) {
      setNewChatSelection((current) => current || preferred.selection_key);
    }
    return options;
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const options = await hostListChatModels();
      setModelLoadError(null);
      return rememberModels(options);
    } catch (error) {
      setModelLoadError(String(error));
      return [];
    }
  }, [rememberModels]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    const previous = previousCollapsedRef.current;
    previousCollapsedRef.current = collapsed;
    if (compactLayout || previous === collapsed) return;
    queueMicrotask(() => {
      if (collapsed) reopenRef.current?.focus();
      else collapseToggleRef.current?.focus();
    });
  }, [collapsed, compactLayout]);

  useLayoutEffect(() => {
    if (!visible || collapsed || compactLayout || !activeChatId) return;
    const savedScroll = scrollByChatRef.current[activeChatId];
    const thread = threadRef.current;
    if (savedScroll == null || !thread) return;
    thread.scrollTop = savedScroll;
  }, [activeChatId, collapsed, compactLayout, visible]);

  useLayoutEffect(() => {
    if (!visible || !activeChatId) return;
    return () => {
      if (threadRef.current) {
        scrollByChatRef.current[activeChatId] = threadRef.current.scrollTop;
      }
    };
  }, [activeChatId, visible]);

  const followActive = activeChatId
    ? (followByChat[activeChatId] ?? true)
    : true;
  const busy = activeChatId ? (busyByChat[activeChatId] ?? false) : false;
  const hostPhase = activeChatId
    ? (hostPhaseByChat[activeChatId] ?? null)
    : null;
  const turnStartedAt = activeChatId
    ? (turnStartedAtByChat[activeChatId] ?? null)
    : null;
  const anyBusy = Object.values(busyByChat).some(Boolean);
  const cancellationRequested = activeChatId
    ? (cancellationRequestedByChat[activeChatId] ?? false)
    : false;
  const error = activeChatId
    ? (errorByChat[activeChatId] ?? railError)
    : railError;
  const status = activeChatId ? (statusByChat[activeChatId] ?? null) : null;
  const navChips = activeChatId ? (navChipsByChat[activeChatId] ?? []) : [];
  const defaultSelection =
    modelOptions.find((option) => option.is_default)?.selection_key ??
    modelOptions[0]?.selection_key ??
    "";
  const selectedModelKey = activeChatId
    ? (selectionByChat[activeChatId] ?? defaultSelection)
    : newChatSelection || defaultSelection;
  const selectedModel =
    modelOptions.find((option) => option.selection_key === selectedModelKey) ??
    modelOptions.find(
      (option) =>
        option.id === parseModelSelectionKey(selectedModelKey).modelId,
    ) ??
    null;
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelOptionDto[]>();
    for (const option of modelOptions) {
      const group = option.group || option.provider_label || "Other";
      groups.set(group, [...(groups.get(group) ?? []), option]);
    }
    return [...groups.entries()];
  }, [modelOptions]);
  const showJump =
    Boolean(activeChatId) && (detachedByChat[activeChatId!] || !followActive);
  const hasNewContent = activeChatId
    ? (newContentByChat[activeChatId] ?? false)
    : false;

  useEffect(() => {
    const target = focusComposerAfterTurnRef.current;
    if (!target || busy || collapsed || !visible) return;
    if (activeChatId === target) {
      composerRef.current?.focus();
    }
    focusComposerAfterTurnRef.current = null;
  }, [activeChatId, busy, collapsed, visible]);

  useEffect(() => {
    if (
      !visible ||
      !externalDraftRequest ||
      appliedExternalDraftRequestRef.current === externalDraftRequest.id
    ) {
      return;
    }
    appliedExternalDraftRequestRef.current = externalDraftRequest.id;
    setDraft((current) => {
      const next = current.trim()
        ? `${current.trimEnd()}\n\nSelected evidence:\n${externalDraftRequest.text}`
        : externalDraftRequest.text;
      if (activeChatId) {
        draftsRef.current[activeChatId] = next;
      }
      return next;
    });
    queueMicrotask(() => composerRef.current?.focus());
  }, [activeChatId, externalDraftRequest, visible]);

  const refreshChats = useCallback(async () => {
    try {
      const list = await hostListChatSessionsForCorpus(corpusId);
      setChats(list ?? []);
    } catch (e) {
      setRailError(String(e));
    }
  }, [corpusId]);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    bottomRef.current?.scrollIntoView({ block: "end", behavior });
  }, []);

  /** Follow new content when this chat is in follow mode. */
  useEffect(() => {
    if (!visible || !activeChatId || !followActive) return;
    // Instant on first paint / chat switch; smooth for streaming appends.
    const behavior: ScrollBehavior = messages.length <= 2 ? "auto" : "smooth";
    requestAnimationFrame(() => scrollToLatest(behavior));
  }, [messages, activeChatId, followActive, scrollToLatest, busy, visible]);

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el || !activeChatId) return;
    const near = isNearBottom(el);
    setFollowByChat((m) => ({ ...m, [activeChatId]: near }));
    setDetachedByChat((m) => ({ ...m, [activeChatId]: !near }));
    if (near) {
      setNewContentByChat((current) => ({
        ...current,
        [activeChatId]: false,
      }));
    }
  };

  const jumpToLatest = () => {
    if (!activeChatId) return;
    setFollowByChat((m) => ({ ...m, [activeChatId]: true }));
    setDetachedByChat((m) => ({ ...m, [activeChatId]: false }));
    setNewContentByChat((current) => ({
      ...current,
      [activeChatId]: false,
    }));
    scrollToLatest("smooth");
  };

  const toggleCollapsed = () => {
    if (!collapsed && activeChatId && threadRef.current) {
      scrollByChatRef.current[activeChatId] = threadRef.current.scrollTop;
    }
    onToggleCollapsed?.();
  };

  const openChat = async (id: string) => {
    // Persist draft + scroll for the chat we leave.
    if (activeChatId) {
      draftsRef.current[activeChatId] = draft;
      if (threadRef.current) {
        scrollByChatRef.current[activeChatId] = threadRef.current.scrollTop;
      }
    }
    const gen = ++openGenRef.current;
    const restoreSwitcherFocus = switcherOpen;
    setActiveChatId(id);
    setSwitcherOpen(false);
    if (restoreSwitcherFocus) {
      queueMicrotask(() => switcherToggleRef.current?.focus());
    }
    setManageOpen(false);
    setRailError(null);
    setErrorByChat((m) => ({ ...m, [id]: null }));
    setDraft(draftsRef.current[id] ?? "");
    // Clear immediately so B never shows A's messages while loading.
    setMessages([]);
    // New selection defaults to follow unless we have a saved scroll position.
    const savedScroll = scrollByChatRef.current[id];
    if (savedScroll == null || savedScroll <= 0) {
      setFollowByChat((m) => ({ ...m, [id]: m[id] ?? true }));
    }
    try {
      const full = await hostLoadChatSession(id);
      if (
        !shouldApplyChatLoad(
          gen,
          openGenRef.current,
          id,
          activeChatIdRef.current,
        )
      ) {
        return;
      }
      if (full) {
        const s = sessionFromDto(full);
        const selection = selectionForSession(
          s,
          modelOptions,
          defaultSelection || newChatSelection,
        );
        if (selection) {
          setSelectionByChat((current) => ({ ...current, [id]: selection }));
        }
        setMessages(mapSessionMessages(s));
      } else {
        setMessages([]);
      }
      // Restore per-chat scroll after paint when we had a saved offset.
      if (savedScroll != null && savedScroll > 0) {
        requestAnimationFrame(() => {
          if (
            !shouldApplyChatLoad(
              gen,
              openGenRef.current,
              id,
              activeChatIdRef.current,
            )
          ) {
            return;
          }
          const el = threadRef.current;
          if (!el) return;
          el.scrollTop = savedScroll;
          setFollowByChat((m) => ({
            ...m,
            [id]: isNearBottom(el),
          }));
          setDetachedByChat((m) => ({
            ...m,
            [id]: !isNearBottom(el),
          }));
        });
      }
    } catch (e) {
      if (
        !shouldApplyChatLoad(
          gen,
          openGenRef.current,
          id,
          activeChatIdRef.current,
        )
      ) {
        return;
      }
      setErrorByChat((m) => ({ ...m, [id]: String(e) }));
      setMessages([]);
    }
  };

  /**
   * Open a host-authored log citation without workspace file I/O (#701/#698).
   * Same-corpus log_event:* reuses the Explorer highlight path; original-corpus
   * navigation for detach/replacement uses openPersistedLogCitation.
   */
  const openLinkedCitation = useCallback(
    (sourceId: string, citationCorpusId?: string) => {
      const route = classifyCompletedCitation(sourceId);
      if (route === "invalid") {
        setRailError(
          "This citation is unsupported or malformed and was not opened.",
        );
        return;
      }
      if (route !== "log") {
        // Linked rail is log-evidence first; Help/file are not auto-opened here.
        setRailError(
          "This citation is not a governed log evidence identity for this rail.",
        );
        return;
      }
      const original = citationCorpusId?.trim() || undefined;
      if (!original) {
        setRailError(
          "This older log citation does not record its original corpus. ContextDesk will not substitute the chat’s current corpus.",
        );
        return;
      }
      if (original !== corpusId) {
        void openPersistedLogCitation(
          sourceId,
          original,
          (_id, message) => {
            setRailError(message);
          },
          hostOpenLogExplorer,
        );
        return;
      }
      // Same Explorer corpus: reveal without mutating unrelated filters.
      const seq = parseLogEventSeq(sourceId);
      if (seq != null) {
        onApplyNav({
          type: "log_nav",
          corpusId,
          sources: [],
          levels: [],
          tsFrom: null,
          tsTo: null,
          highlightSeq: [seq],
          focusLane: null,
          label: sourceId,
        });
        if (activeChatId) {
          setStatusByChat((m) => ({
            ...m,
            [activeChatId]: `Revealed ${sourceId}`,
          }));
        }
        return;
      }
      const templateId = parseLogTemplateId(sourceId);
      if (templateId != null) {
        if (activeChatId) {
          setStatusByChat((m) => ({
            ...m,
            [activeChatId]: `Template ${templateId} — use Templates or search to inspect this pattern`,
          }));
        }
        return;
      }
      setRailError(`Could not interpret log citation ${sourceId}.`);
    },
    [activeChatId, corpusId, onApplyNav],
  );

  const createLinkedChat = async (): Promise<string | null> => {
    setRailError(null);
    try {
      const options =
        modelOptions.length > 0 ? modelOptions : await loadModels();
      const preferredKey =
        newChatSelection ||
        options.find((option) => option.is_default)?.selection_key ||
        options[0]?.selection_key ||
        "";
      const preferred =
        options.find((option) => option.selection_key === preferredKey) ?? null;
      const s = newSession(`Logs · ${corpusName || corpusId.slice(0, 8)}`);
      s.linkedCorpusId = corpusId;
      if (preferred) {
        s.chatModel = preferred.id;
        s.providerProfileId = preferred.provider_id;
      }
      // A linked corpus is a host-governed grant, so the generic renderer save
      // path intentionally cannot create it. Persist the empty first-turn
      // draft and its validated corpus link atomically through the governed
      // mutation instead.
      const saved = await hostSetChatLinkedCorpus(
        s.id,
        corpusId,
        sessionToDto(s),
        s.updatedAt,
      );
      if (saved) {
        if (preferred) {
          setSelectionByChat((current) => ({
            ...current,
            [saved.id]: preferred.selection_key,
          }));
        }
        await refreshChats();
        await openChat(saved.id);
        setStatusByChat((m) => ({
          ...m,
          [saved.id]: `Linked chat created: ${saved.title}`,
        }));
        setFollowByChat((m) => ({ ...m, [saved.id]: true }));
        setDetachedByChat((m) => ({ ...m, [saved.id]: false }));
        return saved.id;
      }
    } catch (e) {
      setRailError(String(e));
    }
    return null;
  };

  const changeModel = async (selectionKey: string) => {
    const option = modelOptions.find(
      (candidate) => candidate.selection_key === selectionKey,
    );
    if (!option || busy || modelSaving) return;
    setModelLoadError(null);
    if (!activeChatId) {
      setNewChatSelection(selectionKey);
      return;
    }
    const id = activeChatId;
    const previousSelection =
      selectionByChat[id] ?? selectedModelKey ?? defaultSelection;
    if (selectionKey === previousSelection) return;
    const previousRetryAvailable = synthesisRetryByChat[id] ?? false;
    setModelSaving(true);
    setSelectionByChat((current) => ({ ...current, [id]: selectionKey }));
    setSynthesisRetryByChat((current) => ({ ...current, [id]: false }));
    setErrorByChat((current) => ({ ...current, [id]: null }));
    setStatusByChat((current) => ({
      ...current,
      [id]: `Saving ${option.provider_label} · ${option.label}…`,
    }));
    try {
      const full = await hostLoadChatSession(id);
      if (!full) throw new Error("Linked chat could not be loaded");
      const session = sessionFromDto(full);
      session.chatModel = option.id;
      session.providerProfileId = option.provider_id;
      session.updatedAt = nowIso();
      const saved = await hostSaveChatSession(sessionToDto(session));
      if (!saved) throw new Error("Linked chat model was not persisted");
      setSelectionByChat((current) => ({
        ...current,
        [id]: modelSelectionKey(
          saved.provider_profile_id ?? option.provider_id,
          saved.chat_model ?? option.id,
        ),
      }));
      setStatusByChat((current) => ({
        ...current,
        [id]: `Model changed to ${option.provider_label} · ${option.label}`,
      }));
      await refreshChats();
    } catch (error) {
      setSelectionByChat((current) => ({
        ...current,
        [id]: previousSelection,
      }));
      setSynthesisRetryByChat((current) => ({
        ...current,
        [id]: previousRetryAvailable,
      }));
      setErrorByChat((current) => ({
        ...current,
        [id]: `Could not save linked-chat model: ${String(error)}`,
      }));
      setStatusByChat((current) => ({ ...current, [id]: null }));
    } finally {
      setModelSaving(false);
    }
  };

  const sendChat = async (options?: { retrySynthesisOnly?: boolean }) => {
    const retrySynthesisOnly = options?.retrySynthesisOnly ?? false;
    const text = retrySynthesisOnly ? "" : draft.trim();
    if ((!text && !retrySynthesisOnly) || busy) return;
    let turnModel = selectedModel;
    if (!turnModel) {
      const options = await loadModels();
      const key =
        selectedModelKey ||
        options.find((option) => option.is_default)?.selection_key ||
        options[0]?.selection_key ||
        "";
      turnModel =
        options.find((option) => option.selection_key === key) ?? null;
    }
    if (!turnModel) {
      setRailError(
        "No chat model is configured. Configure a tools-enabled provider in Settings → AI.",
      );
      return;
    }
    if (!retrySynthesisOnly && !turnModel.tools_enabled) {
      const message =
        turnModel.tools_disabled_reason === "model"
          ? `${turnModel.provider_label} · ${turnModel.label} previously rejected native tools. Retry tools for this model or choose another tools-enabled model.`
          : `${turnModel.provider_label} · ${turnModel.label} cannot investigate linked logs because its provider has tools disabled. Choose another tools-enabled model or configure one in Settings → AI.`;
      if (activeChatId) {
        setErrorByChat((current) => ({
          ...current,
          [activeChatId]: message,
        }));
      } else {
        setRailError(message);
      }
      return;
    }
    let sessionId = activeChatId;
    if (retrySynthesisOnly && !sessionId) return;
    if (!sessionId) {
      if (creatingTurnChatRef.current) return;
      creatingTurnChatRef.current = true;
      try {
        sessionId = await createLinkedChat();
      } finally {
        creatingTurnChatRef.current = false;
      }
      if (!sessionId) return;
    }
    if (busyByChat[sessionId] || sendingChatsRef.current.has(sessionId)) return;
    sendingChatsRef.current.add(sessionId);
    terminalChatsRef.current.delete(sessionId);
    setBusyByChat((m) => ({ ...m, [sessionId!]: true }));
    setTurnStartedAtByChat((m) => ({ ...m, [sessionId!]: Date.now() }));
    setHostPhaseByChat((m) => ({ ...m, [sessionId!]: null }));
    setCancellationRequestedByChat((m) => ({
      ...m,
      [sessionId!]: false,
    }));
    setErrorByChat((m) => ({ ...m, [sessionId!]: null }));
    setStatusByChat((m) => ({ ...m, [sessionId!]: null }));
    setSynthesisRetryByChat((current) => ({
      ...current,
      [sessionId!]: false,
    }));
    if (!retrySynthesisOnly) {
      setDraft("");
      draftsRef.current[sessionId] = "";
    }
    // Sending always re-engages follow for this chat (#529).
    setFollowByChat((m) => ({ ...m, [sessionId!]: true }));
    setDetachedByChat((m) => ({ ...m, [sessionId!]: false }));
    setNewContentByChat((current) => ({
      ...current,
      [sessionId!]: false,
    }));

    const userMsg: ChatMsg | null = retrySynthesisOnly
      ? null
      : {
          id: crypto.randomUUID(),
          role: "user",
          content: text,
        };
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      ...(userMsg ? [userMsg] : []),
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    // Snap to the new user message immediately.
    requestAnimationFrame(() => scrollToLatest("auto"));

    try {
      const events = await agentTurn(
        sessionId,
        text,
        false,
        turnModel.id,
        turnModel.provider_id,
        (ev) => {
          // Only update if still viewing this chat.
          if (activeChatIdRef.current !== sessionId) return;
          if (
            ev.kind === "text_delta" &&
            detachedByChatRef.current[sessionId!]
          ) {
            setNewContentByChat((current) => ({
              ...current,
              [sessionId!]: true,
            }));
          }
          if (ev.kind === "turn_phase") {
            const phase = String(ev.payload.phase ?? "");
            const label =
              phase === "choosing_evidence"
                ? "Choosing bounded evidence…"
                : phase === "retrieving_evidence"
                  ? "Retrieving bounded evidence…"
                  : phase === "synthesizing_answer"
                    ? retrySynthesisOnly
                      ? "Retrying answer synthesis from preserved evidence…"
                      : "Synthesizing an evidence-referenced answer…"
                    : null;
            if (label) {
              setHostPhaseByChat((current) => ({
                ...current,
                [sessionId!]: label,
              }));
              setStatusByChat((current) => ({
                ...current,
                [sessionId!]: label,
              }));
            }
          }
          if (
            ev.kind === "linked_synthesis_retry" &&
            ev.payload.session_id === sessionId &&
            ev.payload.corpus_id === corpusId &&
            ev.payload.provider_profile_id === turnModel.provider_id &&
            ev.payload.model_id === turnModel.id
          ) {
            setSynthesisRetryByChat((current) => ({
              ...current,
              [sessionId!]: ev.payload.available === true,
            }));
          }
          setMessages((msgs) => {
            const base =
              msgs.find((x) => x.id === assistantId) ??
              ({
                id: assistantId,
                role: "assistant" as const,
                content: "",
              } satisfies ChatMsg);
            const folded = applyEventsToMessage(base, [ev]).msg;
            return msgs.map((x) =>
              x.id === assistantId ? { ...folded, streaming: true } : x,
            );
          });
        },
        null,
        {
          corpus_id: corpusId,
          brief: agentContext.brief,
          noise_lens_suspended: agentContext.noiseLensSuspended === true,
        },
        retrySynthesisOnly,
        {
          userMessageId: userMsg?.id ?? null,
          assistantMessageId: assistantId,
        },
      );
      terminalChatsRef.current.add(sessionId);
      setErrorByChat((current) => ({ ...current, [sessionId!]: null }));

      const full = await hostLoadChatSession(sessionId);
      if (!full) {
        throw new Error("Linked chat could not be reloaded after the turn");
      }
      const session = sessionFromDto(full);
      const hostPersistedAssistant = session.messages.find(
        (message) =>
          message.id === assistantId && message.role === "assistant",
      );
      let assistant: ChatMsg;
      let saved: ChatSessionDto;
      if (hostPersistedAssistant) {
        assistant = { ...hostPersistedAssistant, streaming: false };
        saved = full;
      } else {
        const folded = applyEventsToMessage(
          { id: assistantId, role: "assistant", content: "", streaming: false },
          events,
        ).msg;
        assistant = {
          ...folded,
          streaming: false,
          content: folded.content,
        };
        const updated = {
          ...session,
          messages: [
            ...session.messages,
            ...(userMsg ? [userMsg] : []),
            assistant,
          ],
          chatModel: turnModel.id,
          providerProfileId: turnModel.provider_id,
          lastReadMessageId: assistantId,
          updatedAt: nowIso(),
        };
        const rendererSaved = await hostSaveChatSession(sessionToDto(updated));
        if (!rendererSaved) {
          throw new Error("Linked chat turn was not persisted");
        }
        saved = rendererSaved;
      }
      if (activeChatIdRef.current === sessionId) {
        const persisted = sessionFromDto(saved);
        setMessages(mapSessionMessages(persisted));
      }

      const extracted = extractAndCleanLogNav(assistant.content);
      if (extracted.actions.length) {
        setNavChipsByChat((byChat) => {
          const next = [...(byChat[sessionId!] ?? [])];
          for (const a of extracted.actions) {
            if (
              !next.some(
                (x) =>
                  x.corpusId === a.corpusId &&
                  JSON.stringify(x) === JSON.stringify(a),
              )
            ) {
              next.push(a);
            }
          }
          return { ...byChat, [sessionId!]: next };
        });
      }
      await refreshChats();
      const usedTools = (assistant.tools?.length ?? 0) > 0;
      const endedWithError = events.some((event) => event.kind === "error");
      const retryAvailable = hasHostLinkedSynthesisRetry(
        events,
        sessionId,
        corpusId,
        turnModel.provider_id,
        turnModel.id,
      );
      setSynthesisRetryByChat((current) => ({
        ...current,
        [sessionId!]: retryAvailable,
      }));
      setStatusByChat((m) => ({
        ...m,
        [sessionId!]: retryAvailable
          ? "Bounded evidence is preserved. Retry only the answer synthesis when ready."
          : endedWithError
            ? `Linked investigation stopped with ${turnModel.provider_label} · ${turnModel.label}. Retry, choose another tools-enabled model above, or configure one in Settings → AI.`
            : usedTools
              ? "Linked investigation completed with governed evidence retrieval"
              : "Linked chat response saved",
      }));
      if (endedWithError) {
        void loadModels();
      }
    } catch (e) {
      terminalChatsRef.current.add(sessionId);
      setErrorByChat((m) => ({ ...m, [sessionId!]: String(e) }));
      if (activeChatIdRef.current === sessionId) {
        setMessages((msgs) =>
          msgs.map((x) =>
            x.id === assistantId
              ? {
                  ...x,
                  streaming: false,
                  content: x.content || `(error: ${String(e)})`,
                }
              : x,
          ),
        );
      }
    } finally {
      sendingChatsRef.current.delete(sessionId);
      cancellationRequestsRef.current.delete(sessionId);
      if (activeChatIdRef.current === sessionId) {
        focusComposerAfterTurnRef.current = sessionId;
      }
      setBusyByChat((m) => ({ ...m, [sessionId!]: false }));
      setTurnStartedAtByChat((m) => ({ ...m, [sessionId!]: null }));
      setHostPhaseByChat((m) => ({ ...m, [sessionId!]: null }));
      setCancellationRequestedByChat((m) => ({
        ...m,
        [sessionId!]: false,
      }));
    }
  };

  const requestCancellation = async () => {
    const sessionId = activeChatId;
    if (
      !sessionId ||
      !busyByChat[sessionId] ||
      cancellationRequestedByChat[sessionId] ||
      cancellationRequestsRef.current.has(sessionId)
    ) {
      return;
    }

    cancellationRequestsRef.current.add(sessionId);
    setCancellationRequestedByChat((current) => ({
      ...current,
      [sessionId]: true,
    }));
    setErrorByChat((current) => ({ ...current, [sessionId]: null }));
    setStatusByChat((current) => ({
      ...current,
      [sessionId]:
        "Cancellation requested. Waiting for the current turn to stop…",
    }));

    try {
      await hostCancelTurn(sessionId);
    } catch (error) {
      // A terminal turn event remains authoritative if it won this race.
      if (
        sendingChatsRef.current.has(sessionId) &&
        !terminalChatsRef.current.has(sessionId)
      ) {
        setCancellationRequestedByChat((current) => ({
          ...current,
          [sessionId]: false,
        }));
        setStatusByChat((current) => ({ ...current, [sessionId]: null }));
        setErrorByChat((current) => ({
          ...current,
          [sessionId]: `Could not request cancellation: ${String(error)}`,
        }));
      }
    } finally {
      cancellationRequestsRef.current.delete(sessionId);
    }
  };

  const retrySelectedModelTools = async () => {
    if (
      !selectedModel ||
      selectedModel.tools_disabled_reason !== "model" ||
      modelRetrying
    ) {
      return;
    }
    setModelRetrying(true);
    setRailError(null);
    try {
      await hostSetModelToolsEnabled({
        providerId: selectedModel.provider_id,
        modelId: selectedModel.id,
        toolsEnabled: true,
      });
      await loadModels();
      const message = `Native tools will be retried for ${selectedModel.provider_label} · ${selectedModel.label}.`;
      if (activeChatId) {
        setStatusByChat((current) => ({
          ...current,
          [activeChatId]: message,
        }));
      } else {
        setRailError(null);
      }
    } catch (error) {
      setRailError(`Could not re-enable this model's tools: ${String(error)}`);
    } finally {
      setModelRetrying(false);
    }
  };

  const filteredChats = useMemo(() => {
    const q = switcherQuery.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.preview ?? "").toLowerCase().includes(q),
    );
  }, [chats, switcherQuery]);

  const dismissSwitcher = useCallback((restoreFocus: boolean) => {
    setSwitcherOpen(false);
    if (restoreFocus) {
      queueMicrotask(() => switcherToggleRef.current?.focus());
    }
  }, []);

  useDismissibleLayer({
    open: switcherOpen,
    layerId: switcherLayerId,
    peerGroup: "investigation-rail-menu",
    rootRef: switcherRef,
    triggerRef: switcherToggleRef,
    onDismiss: dismissSwitcher,
  });

  const dismissManage = useCallback((restoreFocus: boolean) => {
    setManageOpen(false);
    if (restoreFocus) {
      queueMicrotask(() => manageToggleRef.current?.focus());
    }
  }, []);

  useDismissibleLayer({
    open: manageOpen,
    layerId: manageLayerId,
    peerGroup: "investigation-rail-menu",
    rootRef: manageRef,
    triggerRef: manageToggleRef,
    onDismiss: dismissManage,
  });

  useEffect(() => {
    if (!switcherOpen) return;
    queueMicrotask(() => {
      const switcher = switcherRef.current;
      if (!switcher) return;
      const selected = switcher.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]',
      );
      const first = switcher.querySelector<HTMLButtonElement>('[role="option"]');
      (selected ?? first)?.focus();
    });
  }, [switcherOpen]);

  useEffect(() => {
    if (!manageOpen) return;
    queueMicrotask(() => {
      manageRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    });
  }, [manageOpen]);

  const activeMeta = chats.find((c) => c.id === activeChatId);
  const activeTitle =
    activeMeta?.title ?? (activeChatId ? "Linked chat" : "No chat selected");

  useEffect(() => {
    onRailSummary?.({
      chatCount: chats.length,
      hasActiveChat: activeChatId != null,
      busy,
    });
  }, [activeChatId, busy, chats.length, onRailSummary]);

  const openManage = () => {
    if (!activeMeta) return;
    if (manageOpen) {
      dismissManage(true);
      return;
    }
    setRenameDraft(activeMeta.title);
    setManageOpen(true);
  };

  const finishManageMutation = async (
    action: () => Promise<unknown>,
    success: string,
  ) => {
    if (!activeChatId || manageBusy) return;
    const id = activeChatId;
    setManageBusy(true);
    setErrorByChat((m) => ({ ...m, [id]: null }));
    try {
      const result = await action();
      if (!result) throw new Error("Chat update was not persisted");
      await refreshChats();
      setStatusByChat((m) => ({ ...m, [id]: success }));
    } catch (e) {
      setErrorByChat((m) => ({ ...m, [id]: String(e) }));
    } finally {
      setManageBusy(false);
    }
  };

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (!busy && draft.trim()) void sendChat();
  };

  const onSwitcherKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    );
    if (options.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const idx = options.findIndex((el) => el === current);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = options[(idx + 1 + options.length) % options.length]!;
      next.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = options[(idx - 1 + options.length) % options.length]!;
      next.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      options[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      options[options.length - 1]?.focus();
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      options[idx]?.click();
    }
  };

  const applyDevJson = () => {
    const found = extractLogNavFromText(devJson);
    if (found.length) {
      if (!activeChatId) {
        setRailError("Open a linked chat before adding navigation proposals");
        return;
      }
      setNavChipsByChat((m) => ({
        ...m,
        [activeChatId]: [...(m[activeChatId] ?? []), ...found],
      }));
      setDevJson("");
      setStatusByChat((m) => ({
        ...m,
        [activeChatId]: `Parsed ${found.length} navigation proposal(s)`,
      }));
    } else {
      if (activeChatId) {
        setErrorByChat((m) => ({
          ...m,
          [activeChatId]: "No valid log_nav JSON found",
        }));
      } else {
        setRailError("No valid log_nav JSON found");
      }
    }
  };

  if (visible && collapsed && !compactLayout) {
    const collapsedBusy = anyBusy;
    return (
      <aside
        id="log-explorer-investigation-panel"
        className="log-explorer__chat log-explorer__chat--rail log-explorer__chat--collapsed"
        data-testid="log-explorer-chat"
        data-collapsed="true"
        data-busy={collapsedBusy ? "true" : "false"}
        aria-busy={collapsedBusy ? true : undefined}
        aria-label={
          collapsedBusy
            ? "Linked corpus chat collapsed, turn in progress"
            : "Linked corpus chat collapsed"
        }
        style={
          desktopGridColumn == null
            ? undefined
            : { gridColumn: desktopGridColumn }
        }
      >
        <button
          ref={reopenRef}
          type="button"
          className="log-explorer__chat-reopen"
          data-testid="expand-linked-chat"
          aria-label={`Expand linked chat rail${chats.length > 0 ? `, ${chats.length} chat${chats.length === 1 ? "" : "s"}` : ""}${collapsedBusy ? ", turn in progress" : ""}`}
          onClick={toggleCollapsed}
        >
          <span aria-hidden="true">Chat</span>
          {collapsedBusy ? (
            <span
              className="log-explorer__chat-reopen-busy"
              data-testid="linked-chat-collapsed-busy"
              aria-hidden="true"
              title="Turn in progress"
            />
          ) : null}
          {chats.length > 0 ? (
            <span
              className="log-explorer__chat-reopen-count"
              aria-hidden="true"
            >
              {chats.length}
            </span>
          ) : null}
        </button>
      </aside>
    );
  }

  return (
    <aside
      id={visible ? "log-explorer-investigation-panel" : undefined}
      className={`log-explorer__chat log-explorer__chat--rail${
        compactLayout ? " log-explorer__chat--compact-layout" : ""
      }${visible ? "" : " log-explorer__chat--mode-hidden"}`}
      data-testid="log-explorer-chat"
      hidden={!visible}
      style={
        desktopGridColumn == null
          ? undefined
          : { gridColumn: desktopGridColumn }
      }
      role={compactLayout ? "dialog" : undefined}
      aria-label={compactLayout ? "Linked corpus chat drawer" : undefined}
    >
      {modeControl ? (
        <div
          className="log-explorer__investigation-mode-control"
          style={compactLayout ? undefined : { paddingLeft: "1.65rem" }}
        >
          {modeControl}
        </div>
      ) : null}
      <header
        className="log-explorer__chat-header"
        data-testid="linked-chat-header"
      >
        <div className="log-explorer__chat-header-main">
          <div className="log-explorer__chat-header-title" title={activeTitle}>
            {activeTitle}
          </div>
          <div className="log-explorer__chat-header-meta">
            Linked · {chats.length} chat{chats.length === 1 ? "" : "s"}
            <HelpTip
              label="How linked chat context works"
              title="Linked chat and agent context"
              content={HELP_LINKED_CHAT_CONTEXT}
            />
          </div>
        </div>
        <div className="log-explorer__chat-header-actions">
          {!compactLayout && onToggleCollapsed ? (
            <button
              ref={collapseToggleRef}
              type="button"
              className="log-explorer__rail-collapse log-explorer__rail-collapse--chat"
              aria-label="Collapse linked chat rail"
              title="Collapse chat"
              data-testid="collapse-linked-chat"
              onClick={toggleCollapsed}
            >
              <IconChevronRight />
            </button>
          ) : null}
          {compactLayout && onRequestClose ? (
            <button
              type="button"
              className="log-explorer__btn"
              aria-label="Close chat drawer"
              data-testid="close-chat-drawer"
              onClick={onRequestClose}
            >
              Close
            </button>
          ) : null}
          <button
            type="button"
            className="log-explorer__btn"
            ref={switcherToggleRef}
            data-testid="linked-chat-switcher-toggle"
            aria-expanded={switcherOpen}
            aria-controls="linked-chat-switcher"
            aria-haspopup="listbox"
            onClick={() => setSwitcherOpen((o) => !o)}
          >
            Chats
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            ref={manageToggleRef}
            data-testid="linked-chat-manage-toggle"
            disabled={!activeMeta}
            aria-expanded={manageOpen}
            aria-controls="linked-chat-manage"
            aria-haspopup="dialog"
            onClick={openManage}
          >
            Manage
          </button>
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="new-linked-chat"
            onClick={() => void createLinkedChat()}
          >
            New
          </button>
        </div>
      </header>

      <div
        className="log-explorer__chat-model"
        data-testid="linked-chat-model-control"
      >
        <label className="log-explorer__chat-model-field">
          <span>Model</span>
          <select
            className="log-explorer__chat-model-select"
            value={selectedModelKey}
            disabled={busy || modelSaving || modelOptions.length === 0}
            aria-label="Linked chat model"
            aria-describedby={modelHelpId}
            onChange={(event) => void changeModel(event.target.value)}
          >
            {modelGroups.length === 0 ? (
              <option value="">
                {modelLoadError
                  ? "Models unavailable"
                  : "Loading configured models…"}
              </option>
            ) : (
              modelGroups.map(([group, options]) => (
                <optgroup key={group} label={group}>
                  {options.map((option) => (
                    <option
                      key={option.selection_key}
                      value={option.selection_key}
                      disabled={
                        !option.tools_enabled &&
                        option.tools_disabled_reason === "profile"
                      }
                    >
                      {option.label}
                      {option.is_default ? " · default" : ""}
                      {!option.tools_enabled ? " · tools unavailable" : ""}
                    </option>
                  ))}
                </optgroup>
              ))
            )}
          </select>
        </label>
        <div
          id={modelHelpId}
          className={`log-explorer__chat-model-note${
            selectedModel && !selectedModel.tools_enabled
              ? " log-explorer__chat-model-note--error"
              : ""
          }`}
        >
          {modelLoadError
            ? "Could not list configured models. Check Settings → AI."
            : selectedModel
              ? `${selectedModel.provider_label} · ${
                  selectedModel.tools_enabled
                    ? "linked tools available"
                    : "linked tools unavailable"
                }`
              : "Configure a tools-enabled provider in Settings → AI."}
          {selectedModel?.tools_disabled_reason === "model" ? (
            <>
              {" · "}
              <button
                type="button"
                className="log-explorer__chat-model-retry"
                disabled={busy || modelRetrying}
                onClick={() => void retrySelectedModelTools()}
              >
                {modelRetrying ? "Retrying…" : "Retry tools"}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div
        className="log-explorer__chat-scroll-region"
        data-testid="linked-chat-scroll-region"
      >
      {switcherOpen && (
        <div
          ref={switcherRef}
          className="log-explorer__chat-switcher"
          id="linked-chat-switcher"
          data-testid="linked-chat-switcher"
          role="listbox"
          aria-label="Linked chats for this corpus"
          aria-activedescendant={
            activeChatId ? `linked-chat-option-${activeChatId}` : undefined
          }
          onKeyDown={onSwitcherKeyDown}
        >
          {chats.length >= SWITCHER_SEARCH_THRESHOLD && (
            <input
              className="log-explorer__search"
              type="search"
              placeholder="Filter chats…"
              value={switcherQuery}
              onChange={(e) => setSwitcherQuery(e.target.value)}
              aria-label="Filter linked chats"
              data-testid="linked-chat-switcher-search"
            />
          )}
          {chats.length === 0 ? (
            <div className="log-explorer__chat-preview">
              No linked chats yet. Create one to investigate this corpus.
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="log-explorer__chat-preview">No chats match.</div>
          ) : (
            <ul className="log-explorer__chat-switcher-list">
              {filteredChats.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    id={`linked-chat-option-${c.id}`}
                    role="option"
                    aria-selected={c.id === activeChatId}
                    tabIndex={c.id === activeChatId ? 0 : -1}
                    className={`log-explorer__chat-item${
                      c.id === activeChatId
                        ? " log-explorer__chat-item--active"
                        : ""
                    }`}
                    onClick={() => void openChat(c.id)}
                  >
                    <div className="log-explorer__chat-item-title">
                      {c.title}
                    </div>
                    <div className="log-explorer__chat-preview">
                      {cancellationRequestedByChat[c.id]
                        ? "Cancellation requested… · "
                        : busyByChat[c.id]
                          ? "Investigating… · "
                          : ""}
                      {c.preview}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {manageOpen && activeMeta && (
        <div
          ref={manageRef}
          className="log-explorer__chat-manage"
          id="linked-chat-manage"
          role="dialog"
          aria-label={`Manage ${activeMeta.title}`}
          data-testid="linked-chat-manage"
        >
          <label className="log-explorer__chat-manage-rename">
            <span>Chat title</span>
            <input
              className="log-explorer__search"
              value={renameDraft}
              disabled={manageBusy}
              maxLength={120}
              onChange={(event) => setRenameDraft(event.target.value)}
            />
          </label>
          <div className="log-explorer__chat-manage-actions">
            <button
              type="button"
              className="log-explorer__btn"
              disabled={
                manageBusy ||
                !renameDraft.trim() ||
                renameDraft.trim() === activeMeta.title
              }
              onClick={() =>
                void finishManageMutation(
                  () =>
                    hostRenameChatSession(activeMeta.id, renameDraft.trim()),
                  "Linked chat renamed",
                )
              }
            >
              Rename
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              disabled={manageBusy}
              aria-pressed={activeMeta.pinned}
              onClick={() =>
                void finishManageMutation(
                  () => hostPinChatSession(activeMeta.id, !activeMeta.pinned),
                  activeMeta.pinned
                    ? "Linked chat unpinned"
                    : "Linked chat pinned",
                )
              }
            >
              {activeMeta.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              disabled={manageBusy}
              aria-pressed={activeMeta.archived}
              onClick={() =>
                void finishManageMutation(
                  () =>
                    hostArchiveChatSession(activeMeta.id, !activeMeta.archived),
                  activeMeta.archived
                    ? "Linked chat reopened"
                    : "Linked chat archived",
                )
              }
            >
              {activeMeta.archived ? "Reopen" : "Archive"}
            </button>
          </div>
        </div>
      )}

      <div className="log-explorer__chat-thread-wrap">
        <div
          className="log-explorer__chat-thread"
          data-testid="log-explorer-chat-thread"
          ref={threadRef}
          onScroll={onThreadScroll}
          tabIndex={0}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Linked chat messages"
        >
          {messages.length === 0 ? (
            <div className="log-explorer__chat-preview">
              Open or create a linked chat, then ask about this corpus. The
              agent receives a privacy-safe viewport snapshot, must retrieve
              bounded log evidence, and can consult other configured read-only
              sources when relevant — never a full dump paste.
            </div>
          ) : (
            <div
              className="log-explorer__chat-transcript"
              data-testid="linked-chat-transcript"
              data-virtualized={windowed.virtualized ? "true" : "false"}
              data-message-count={messages.length}
              data-mounted-count={windowed.mounted.length}
              style={
                windowed.virtualized
                  ? {
                      position: "relative",
                      height: windowed.totalHeight,
                    }
                  : undefined
              }
            >
              {windowed.mounted.map(({ msg, top }) => (
                <LinkedChatBubble
                  key={msg.id}
                  message={msg}
                  developerMode={developerMode}
                  virtualized={windowed.virtualized}
                  top={top}
                  onHeightChange={
                    windowed.virtualized ? windowed.onHeightChange : undefined
                  }
                  onOpenCitation={openLinkedCitation}
                />
              ))}
            </div>
          )}
          <div ref={bottomRef} data-testid="linked-chat-thread-bottom" />
        </div>

        {showJump && (
          <button
            type="button"
            className="log-explorer__jump-latest"
            data-testid="linked-chat-jump-latest"
            onClick={jumpToLatest}
          >
            {hasNewContent ? "New response · Jump to latest" : "Jump to latest"}
          </button>
        )}
      </div>

      {navChips.length > 0 && (
        <div
          className="log-explorer__nav-chips"
          data-testid="linked-chat-nav-chips"
        >
          <div className="log-explorer__section-title">
            Suggested navigation
          </div>
          <div className="log-explorer__nav-chip-row">
            {navChips.map((chip, i) => {
              const wrong = chip.corpusId !== corpusId;
              const label =
                chip.label ||
                (chip.sources?.length
                  ? `Focus ${chip.sources.slice(0, 2).join(", ")}`
                  : "Apply filters");
              return (
                <button
                  key={`${chip.corpusId}-${i}`}
                  type="button"
                  className={`log-explorer__nav-chip${
                    wrong ? " log-explorer__nav-chip--blocked" : ""
                  }`}
                  disabled={wrong}
                  title={
                    wrong
                      ? "Wrong corpus — navigation rejected"
                      : "Apply this navigation proposal"
                  }
                  onClick={() => {
                    if (wrong) return;
                    onApplyNav(chip);
                  }}
                  data-testid="linked-chat-nav-chip"
                >
                  {wrong ? `Blocked: ${label}` : label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <details
        className="log-explorer__agent-context"
        open={contextOpen}
        onToggle={(e) => setContextOpen((e.target as HTMLDetailsElement).open)}
        data-testid="linked-chat-agent-context"
      >
        <summary>Context shared with agent</summary>
        <ul className="log-explorer__agent-context-list">
          <li>
            <strong>Corpus</strong> {agentContext.corpusId.slice(0, 12)}…
          </li>
          <li>
            <strong>Time quality</strong> {agentContext.timeQuality}
          </li>
          <li>
            <strong>Link mode</strong> {agentContext.linkMode ? "on" : "off"}
          </li>
          <li>
            <strong>Lanes</strong>{" "}
            {agentContext.lanes.length ? agentContext.lanes.join("; ") : "none"}
          </li>
          <li>
            <strong>Filters</strong>{" "}
            {[
              agentContext.levels.length
                ? `levels=${agentContext.levels.join(",")}`
                : null,
              agentContext.sources.length
                ? `sources=${agentContext.sources.slice(0, 4).join(",")}`
                : null,
              agentContext.keyword ? `keyword=${agentContext.keyword}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "none"}
          </li>
          <li data-testid="linked-chat-noise-context">
            <strong>Noise policy</strong>{" "}
            {agentContext.noiseDisclosure ??
              (agentContext.noiseRuleCount != null
                ? `${agentContext.noisePolicyLabel ?? "inactive"} · ${
                    agentContext.noiseRuleCount
                  } rules · ${
                    agentContext.noiseExcludedEventCount ?? 0
                  } excluded from view${
                    agentContext.noiseExcludedNotAnalyzed
                      ? " · excluded events not analyzed"
                      : ""
                  }`
                : "inactive · 0 rules · 0 excluded")}
          </li>
          <li>
            <strong>Selected</strong> {agentContext.selectedCount} ·{" "}
            <strong>Bookmarks</strong> {agentContext.bookmarkCount}
          </li>
          <li>
            <strong>Eligible evidence</strong> Bounded log tools are required.
            Configured workspace/Markdown, durable-memory, Help, and read-only
            connector tools may also be consulted when relevant.
          </li>
          <li>
            <strong>Retrieval and synthesis</strong> ContextDesk selects and
            enforces source eligibility, executes retrieval, and caps results;
            the host verifies bounded event/source references, while the model
            interprets and connects the returned evidence. Consulted tools and
            sources stay visible with the answer.
          </li>
          <li>
            <strong>Skills</strong> Process instructions only — not observed
            incident evidence and never a permission grant.
          </li>
          <li className="log-explorer__chat-preview">
            Full corpora, workspaces, memories, and databases are queried
            through bounded tools, not dumped into chat context.
          </li>
        </ul>
      </details>

      {developerMode && (
        <details
          className="log-explorer__dev-diagnostics"
          open={devOpen}
          onToggle={(e) => setDevOpen((e.target as HTMLDetailsElement).open)}
          data-testid="linked-chat-dev-diagnostics"
        >
          <summary>Developer diagnostics</summary>
          <pre
            className="log-explorer__chat-preview"
            data-testid="log-explorer-view-context"
          >
            {agentContext.brief}
          </pre>
          <label className="log-explorer__section-title" htmlFor="dev-log-nav">
            Paste log_nav JSON
          </label>
          <textarea
            id="dev-log-nav"
            className="log-explorer__search"
            rows={2}
            value={devJson}
            onChange={(e) => setDevJson(e.target.value)}
            placeholder='{"type":"log_nav","corpusId":"…","sources":["api.log"]}'
            aria-label="Paste log_nav JSON"
          />
          <button
            type="button"
            className="log-explorer__btn"
            onClick={applyDevJson}
          >
            Parse nav JSON
          </button>
        </details>
      )}
      </div>

      {(error ||
        status ||
        busy ||
        (activeChatId && synthesisRetryByChat[activeChatId])) && (
        <div
          className="log-explorer__chat-status"
          data-testid="linked-chat-status"
        >
          <div className="log-explorer__chat-status-row">
            {/*
              Single status node for phase/error copy (no duplicate sr-only twin).
              Elapsed sits outside the live region so ticks are never announced.
            */}
            <span role="status" aria-live="polite" aria-atomic="true">
              {error
                ? `Error: ${error}`
                : busy && cancellationRequested && status
                  ? status
                  : busy && hostPhase
                    ? hostPhase
                    : busy && !hostPhase
                      ? "Working…"
                      : status || ""}
            </span>
            {busy &&
            hostPhase &&
            !cancellationRequested &&
            turnStartedAt != null ? (
              <LinkedElapsed startedAt={turnStartedAt} />
            ) : null}
            {busy && !cancellationRequested ? (
              <span
                data-testid={
                  hostPhase
                    ? "linked-chat-phase"
                    : "linked-chat-phase-indeterminate"
                }
                // Visual/status copy lives in the live region above; this is a
                // stable test hook without a second text node.
                hidden
              />
            ) : null}
            {activeChatId && synthesisRetryByChat[activeChatId] ? (
              <button
                type="button"
                className="log-explorer__btn"
                data-testid="retry-linked-synthesis"
                disabled={busy}
                onClick={() => void sendChat({ retrySynthesisOnly: true })}
              >
                Retry synthesis
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div
        className="log-explorer__chat-composer"
        data-testid="log-explorer-chat-composer"
      >
        <textarea
          ref={composerRef}
          className="log-explorer__search"
          rows={compactLayout ? 2 : 3}
          placeholder="Ask about these logs…"
          value={draft}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value);
            if (activeChatId) {
              draftsRef.current[activeChatId] = e.target.value;
            }
          }}
          onKeyDown={onComposerKey}
          aria-label="Chat message"
          aria-describedby={composerHelpId}
          aria-keyshortcuts="Enter Shift+Enter"
          title="Return to send · Shift+Return for a newline"
        />
        <span id={composerHelpId} className="sr-only">
          Press Return to send. Press Shift and Return for a newline.
        </span>
        <button
          type="button"
          className={
            busy
              ? "log-explorer__btn log-explorer__btn--stop"
              : "log-explorer__btn log-explorer__btn--active"
          }
          data-testid="send-linked-chat"
          aria-disabled={busy && cancellationRequested}
          disabled={busy ? cancellationRequested : !draft.trim()}
          onClick={() => (busy ? void requestCancellation() : void sendChat())}
          aria-label={
            busy
              ? cancellationRequested
                ? "Stopping… — cancelling the current turn"
                : "Stop — cancel the current turn"
              : "Send"
          }
          title={
            busy
              ? cancellationRequested
                ? "Cancellation requested — cancelling the current turn"
                : "Cancel the current turn"
              : "Send message"
          }
        >
          {busy ? (cancellationRequested ? "Stopping…" : "Stop") : "Send"}
        </button>
      </div>
    </aside>
  );
}
