import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Composer } from "./components/Composer";
import { MarkdownBody } from "./components/MarkdownBody";
import { ThinkingIndicator } from "./components/ThinkingIndicator";
import { StreamLiveRegion } from "./components/StreamLiveRegion";
import { nextRovingIndex } from "./lib/a11y";
import {
  PermissionModal,
  type PermissionPrompt,
} from "./components/PermissionModal";
import { RenameChatModal } from "./components/RenameChatModal";
import {
  SettingsModal,
  type SettingsSection,
} from "./components/SettingsModal";
import { ToolCallList, type ToolCallView } from "./components/ToolCallList";
import { dialogConfirm } from "./lib/dialogs";
import { SourceCitations } from "./components/SourceCitations";
import { ChatArchivePane } from "./components/panes/ChatArchivePane";
import { MemoryPane, type MemoryDoc } from "./components/panes/MemoryPane";
import { SourcePreviewPane } from "./components/panes/SourcePreviewPane";
import { TodoPane } from "./components/panes/TodoPane";
import { IconMoon, IconSettings, IconSpark, IconSun } from "./components/icons";
import {
  agentTurn,
  completePermission,
  hostCancelTurn,
  hostCheckOllama,
  hostGetBranding,
  hostGetConfig,
  hostGetDefaultChatModel,
  hostListChatModels,
  hostListChatSessions,
  hostListMemory,
  hostLoadChatSession,
  hostPinChatSession,
  hostPreflight,
  hostReadFile,
  hostRenameChatSession,
  hostSaveChatSession,
  hostSetDefaultChatModel,
  hostSetWorkspace,
  hostSuggestChatTitle,
  hostTrashChatSession,
  hostWriteMemory,
  hostOpenExternalUrl,
  modelSelectionKey,
  parseModelSelectionKey,
  type BrandingDto,
  type ChatSessionDto,
  type MessageMetaDto,
  type ModelOptionDto,
} from "./lib/host";
import {
  runClientPreflight,
  type AppSetupState,
  type PreflightReport,
} from "./lib/preflight";
import {
  applyEventsToMessage,
  shortSourceLabel,
  type ChatMsg as Msg,
} from "./lib/turn";

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

type PaneId = "chat" | "archive" | "memory" | "source" | "todos";

function loadTheme(): "dark" | "light" {
  const t = localStorage.getItem("cd-theme");
  return t === "light" ? "light" : "dark";
}

/** UI type scale preference (#151): 90 | 100 | 110 percent of 16px root. */
export type UiScale = "90" | "100" | "110";

function loadUiScale(): UiScale {
  const s = localStorage.getItem("cd-ui-scale");
  if (s === "90" || s === "110" || s === "100") return s;
  return "100";
}

function loadSetup(): AppSetupState {
  try {
    const raw = localStorage.getItem("cd-setup");
    if (raw) {
      const parsed = JSON.parse(raw) as AppSetupState;
      if (!parsed.confluence) {
        parsed.confluence = {
          enabled: false,
          baseUrl: "",
          spaces: "",
          hasToken: false,
        };
      }
      if (parsed.webResearchEnabled === undefined) {
        parsed.webResearchEnabled = false;
      }
      if (!parsed.x) {
        parsed.x = { enabled: false, hasToken: false };
      }
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return {
    dataDirWritable: true,
    workspaceName: null,
    workspaceRoots: [],
    providerLabel: "Ollama (local)",
    providerKind: "ollama",
    chatModel: "mistral",
    baseUrl: "http://127.0.0.1:11434",
    hasApiKey: false,
    localOnly: true,
    ollamaReachable: null,
    remoteReachable: null,
    confluence: {
      enabled: false,
      baseUrl: "",
      spaces: "",
      hasToken: false,
    },
    x: { enabled: false, hasToken: false },
    webResearchEnabled: false,
  };
}

function openExternalUrl(url: string) {
  void hostOpenExternalUrl(url).catch((err) => {
    console.error("open external url failed", err);
  });
}

function formatMsgMetaFooter(meta: MessageMetaDto): string {
  const parts: string[] = [];
  const model = meta.host_confirmed
    ? meta.model
    : meta.requested_model || meta.model;
  if (model) {
    parts.push(meta.host_confirmed ? model : `requested: ${model}`);
  }
  if (meta.provider_label) parts.push(meta.provider_label);
  else if (meta.provider_kind) parts.push(meta.provider_kind);
  if (meta.base_url) {
    try {
      const u = new URL(meta.base_url);
      parts.push(u.host);
    } catch {
      parts.push(meta.base_url);
    }
  }
  return parts.join(" · ");
}

function snapshotMessageMeta(args: {
  sessionModel: string | null;
  sessionProvider: string | null;
  modelOptions: ModelOptionDto[];
  defaultModelKey: string;
  setup: AppSetupState;
}): MessageMetaDto {
  const { sessionModel, sessionProvider, modelOptions, defaultModelKey, setup } =
    args;
  let selectionKey = "";
  if (sessionModel && sessionProvider) {
    selectionKey = modelSelectionKey(sessionProvider, sessionModel);
  } else if (sessionModel) {
    selectionKey =
      modelOptions.find((m) => m.id === sessionModel)?.selection_key || "";
  }
  if (!selectionKey) {
    selectionKey =
      defaultModelKey ||
      modelOptions.find((m) => m.is_default)?.selection_key ||
      modelOptions[0]?.selection_key ||
      "";
  }
  const parsed = parseModelSelectionKey(selectionKey);
  const model = sessionModel || parsed.modelId || setup.chatModel || undefined;
  const match = modelOptions.find(
    (m) =>
      m.selection_key === selectionKey ||
      (sessionModel != null && m.id === sessionModel),
  );
  return {
    model: model || undefined,
    requested_model: model || undefined,
    host_confirmed: false,
    provider_label: match?.provider_label || setup.providerLabel || undefined,
    provider_id:
      sessionProvider || match?.provider_id || parsed.providerId || undefined,
    provider_kind: setup.providerKind || undefined,
    base_url: setup.baseUrl?.trim() || undefined,
  };
}

export function App() {
  const [branding, setBranding] = useState<BrandingDto>({
    name: "ContextDesk",
    slug: "contextdesk",
    tagline: "Developer knowledge workbench — find, synthesize, remember.",
    version: "0.1.0",
    protocol: "cd.v1",
  });
  type ChatSession = {
    id: string;
    title: string;
    messages: Msg[];
    /** How many recent messages stay visible while auto-folded. */
    compactKeepLast: number;
    /**
     * When false (default), long threads auto-fold older turns in the UI.
     * Full `messages` are never deleted — fold is view-only.
     */
    showFullHistory: boolean;
    titleLocked: boolean;
    createdAt: string;
    updatedAt: string;
    archived: boolean;
    /** Soft-deleted into trash. */
    trashed: boolean;
    trashedAt: string | null;
    pinned: boolean;
    /** Model for this chat; null uses app default. */
    chatModel: string | null;
    /** Provider profile when model is from a non-default source. */
    providerProfileId: string | null;
    /** Last message id scrolled into view / marked read. */
    lastReadMessageId: string | null;
  };

  const nowIso = () => new Date().toISOString();

  const newSession = (
    title = "Chat",
    chatModel: string | null = null,
  ): ChatSession => {
    const t = nowIso();
    return {
      id: crypto.randomUUID(),
      title,
      messages: [],
      compactKeepLast: 6,
      showFullHistory: false,
      titleLocked: false,
      createdAt: t,
      updatedAt: t,
      archived: false,
      trashed: false,
      trashedAt: null,
      pinned: false,
      chatModel,
      providerProfileId: null,
      lastReadMessageId: null,
    };
  };

  const isPlaceholderTitle = (title: string) => {
    const t = title.trim().toLowerCase();
    if (!t || t === "chat") return true;
    if (t.startsWith("chat ")) {
      return [...t.slice(5)].every((c) => c >= "0" && c <= "9");
    }
    return false;
  };

  /** Immediate short heuristic (never dump the full prompt into the tab). */
  const titleFromPrompt = (prompt: string, max = 40) => {
    const line =
      prompt
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (!collapsed) return "";
    const clause = collapsed.search(/[.?!;,](\s|$)/);
    const base =
      clause >= 12 && clause <= Math.max(max, 28)
        ? collapsed.slice(0, clause).replace(/[.?!;,]+$/, "").trim()
        : collapsed;
    if (base.length <= max) return base;
    const slice = base.slice(0, max);
    const sp = slice.lastIndexOf(" ");
    const cut = sp >= 8 ? slice.slice(0, sp) : slice;
    return `${cut.trimEnd()}…`;
  };

  /** Upgrade tab title with model when available; never overrides rename lock. */
  const upgradeTitleWithLlm = useCallback(
    async (sessionId: string, prompt: string) => {
      try {
        const suggested = await hostSuggestChatTitle(prompt);
        if (!suggested?.trim()) return;
        setSessions((all) =>
          all.map((s) => {
            if (s.id !== sessionId || s.titleLocked) return s;
            const updated = {
              ...s,
              title: suggested.trim(),
              updatedAt: nowIso(),
            };
            // Persist if we already have messages (after first turn / mid-flight).
            if (updated.messages.length > 0) {
              void hostSaveChatSession(sessionToDto(updated)).catch(() => {
                /* ignore */
              });
            }
            return updated;
          }),
        );
      } catch {
        /* keep heuristic title */
      }
    },
    [],
  );

  const msgFromStored = (m: ChatSessionDto["messages"][number]): Msg | null => {
    if (m.role !== "user" && m.role !== "assistant") return null;
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      tools: Array.isArray(m.tools) ? (m.tools as ToolCallView[]) : undefined,
      citations: Array.isArray(m.citations)
        ? (m.citations as { id: string; label: string; title?: string }[])
        : undefined,
      trail: m.trail ?? undefined,
      meta: m.meta ?? undefined,
    };
  };

  const sessionFromDto = (dto: ChatSessionDto): ChatSession => ({
    id: dto.id,
    title: dto.title,
    messages: dto.messages
      .map(msgFromStored)
      .filter((m): m is Msg => m !== null),
    compactKeepLast: dto.compact_keep_last || 6,
    showFullHistory: dto.show_full_history,
    titleLocked: dto.title_locked,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    archived: dto.archived,
    trashed: dto.trashed ?? false,
    trashedAt: dto.trashed_at ?? null,
    pinned: dto.pinned ?? false,
    chatModel: dto.chat_model ?? null,
    providerProfileId: dto.provider_profile_id ?? null,
    lastReadMessageId: dto.last_read_message_id ?? null,
  });

  const sessionToDto = (s: ChatSession): ChatSessionDto => ({
    id: s.id,
    title: s.title,
    messages: s.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      tools: m.tools,
      citations: m.citations,
      trail: m.trail,
      meta: m.meta ?? null,
    })),
    compact_keep_last: s.compactKeepLast,
    show_full_history: s.showFullHistory,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    archived: s.archived,
    trashed: s.trashed,
    trashed_at: s.trashedAt,
    pinned: s.pinned,
    title_locked: s.titleLocked,
    chat_model: s.chatModel,
    provider_profile_id: s.providerProfileId,
    last_read_message_id: s.lastReadMessageId,
  });

  const foldPreview = (msgs: Msg[], keep: number): string => {
    if (msgs.length <= keep) return "";
    return msgs
      .slice(0, -keep)
      .map((m) => {
        const snip = m.content.replace(/\s+/g, " ").trim().slice(0, 100);
        return `• ${m.role}: ${snip}${m.content.length > 100 ? "…" : ""}`;
      })
      .join("\n");
  };

  const [theme, setTheme] = useState<"dark" | "light">(loadTheme);
  const [uiScale, setUiScale] = useState<UiScale>(loadUiScale);
  const [sidebarW, setSidebarW] = useState(() => {
    const n = Number(localStorage.getItem("cd-sidebar-w"));
    if (Number.isFinite(n) && n >= 140 && n <= 420) return n;
    return 200;
  });
  const sidebarDragging = useRef(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const resolvedSessionId = activeSessionId ?? sessions[0]?.id ?? "";
  const activeSession =
    sessions.find((s) => s.id === resolvedSessionId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const setMessages = (
    updater: Msg[] | ((prev: Msg[]) => Msg[]),
  ) => {
    const sid = resolvedSessionId;
    setSessions((all) =>
      all.map((s) => {
        if (s.id !== sid) return s;
        const next =
          typeof updater === "function" ? updater(s.messages) : updater;
        return { ...s, messages: next, updatedAt: nowIso() };
      }),
    );
  };
  const sessionId = activeSession?.id ?? "";
  const compactKeep = activeSession?.compactKeepLast ?? 6;
  const showFullHistory = activeSession?.showFullHistory ?? false;
  /** Auto-fold when over keep and user has not expanded. Non-destructive. */
  const isFolded = !showFullHistory && messages.length > compactKeep;
  const hiddenCount = isFolded ? messages.length - compactKeep : 0;
  const visibleMessages = isFolded ? messages.slice(-compactKeep) : messages;
  const hiddenPreview = isFolded ? foldPreview(messages, compactKeep) : "";

  const chatScrollRef = useRef<HTMLDivElement>(null);
  /** When true, new content auto-scrolls to bottom. Cleared if user scrolls up. */
  const stickToBottomRef = useRef(true);
  /** Ignore scroll events we caused programmatically. */
  const ignoreScrollRef = useRef(false);
  const [unreadBelow, setUnreadBelow] = useState(0);

  const NEAR_BOTTOM_PX = 120;

  const isNearBottom = (el: HTMLElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;

  const markSessionRead = useCallback(
    (sid: string, messageId: string | null) => {
      if (!messageId) return;
      setSessions((all) => {
        const cur = all.find((s) => s.id === sid);
        if (!cur || cur.lastReadMessageId === messageId) return all;
        return all.map((s) =>
          s.id === sid ? { ...s, lastReadMessageId: messageId } : s,
        );
      });
    },
    [],
  );

  const countUnread = useCallback(
    (msgs: Msg[], lastReadId: string | null) => {
      if (msgs.length === 0) return 0;
      if (!lastReadId) return msgs.length;
      const idx = msgs.findIndex((m) => m.id === lastReadId);
      if (idx < 0) return msgs.length;
      return Math.max(0, msgs.length - idx - 1);
    },
    [],
  );

  /** Pin scroll to the end after layout (double rAF avoids empty-state height races). */
  const pinScrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const run = () => {
      const el = chatScrollRef.current;
      if (!el) return;
      ignoreScrollRef.current = true;
      const top = Math.max(0, el.scrollHeight - el.clientHeight);
      if (behavior === "smooth") {
        el.scrollTo({ top, behavior: "smooth" });
      } else {
        el.scrollTop = top;
      }
      window.setTimeout(() => {
        ignoreScrollRef.current = false;
      }, behavior === "smooth" ? 320 : 0);
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, []);

  const scrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      stickToBottomRef.current = true;
      setUnreadBelow(0);
      pinScrollToEnd(behavior);
      const last = messages[messages.length - 1];
      if (last && sessionId) markSessionRead(sessionId, last.id);
    },
    [messages, sessionId, markSessionRead, pinScrollToEnd],
  );

  const onChatScroll = useCallback(() => {
    if (ignoreScrollRef.current) return;
    const el = chatScrollRef.current;
    if (!el || !sessionId) return;
    if (isNearBottom(el)) {
      stickToBottomRef.current = true;
      setUnreadBelow(0);
      const last = messages[messages.length - 1];
      if (last) markSessionRead(sessionId, last.id);
    } else {
      stickToBottomRef.current = false;
    }
  }, [messages, sessionId, markSessionRead]);

  const setShowFullHistory = (show: boolean) => {
    setSessions((all) =>
      all.map((s) =>
        s.id === resolvedSessionId ? { ...s, showFullHistory: show } : s,
      ),
    );
  };

  const persistSession = useCallback(async (s: ChatSession) => {
    // Never re-save trashed chats (avoids resurrecting after soft-delete races).
    if (s.messages.length === 0 || s.trashed) return s;
    let next = { ...s, updatedAt: nowIso() };
    if (!next.titleLocked && isPlaceholderTitle(next.title)) {
      const firstUser = next.messages.find((m) => m.role === "user");
      if (firstUser) {
        const auto = titleFromPrompt(firstUser.content);
        if (auto) next = { ...next, title: auto };
      }
    }
    try {
      const saved = await hostSaveChatSession(sessionToDto(next));
      if (saved) return sessionFromDto(saved);
    } catch {
      /* browser / host unavailable — keep local state */
    }
    return next;
  }, []);

  // Hydrate sessions from host store on launch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const metas = await hostListChatSessions();
        if (cancelled) return;
        if (metas.length === 0) {
          const s = newSession("Chat 1", null);
          setSessions([s]);
          setActiveSessionId(s.id);
          setSessionsReady(true);
          return;
        }
        const loaded: ChatSession[] = [];
        for (const meta of metas) {
          if (meta.archived || meta.trashed) continue;
          const dto = await hostLoadChatSession(meta.id);
          if (dto && !dto.trashed) loaded.push(sessionFromDto(dto));
        }
        if (cancelled) return;
        if (loaded.length === 0) {
          const s = newSession("Chat 1", null);
          setSessions([s]);
          setActiveSessionId(s.id);
        } else {
          setSessions(loaded);
          setActiveSessionId(loaded[0].id);
        }
      } catch {
        if (!cancelled) {
          const s = newSession("Chat 1", null);
          setSessions([s]);
          setActiveSessionId(s.id);
        }
      } finally {
        if (!cancelled) setSessionsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [setup, setSetup] = useState<AppSetupState>(loadSetup);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("preflight");
  /** Session-only: hide setup banner after Continue / close settings while incomplete. */
  const [dismissedBanner, setDismissedBanner] = useState(
    () => sessionStorage.getItem("cd-setup-dismissed") === "1",
  );
  const autoOpenedPreflight = useRef(false);
  const [busy, setBusy] = useState(false);
  /** When the current turn started waiting for the model (for elapsed UI). */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  /** In-app rename (plugin-dialog has no text prompt). */
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  /** Halt client-side text materialization only — true host cancel is #90. */
  const stopRef = useRef(false);
  const [pendingToolArgs, setPendingToolArgs] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [pane, setPane] = useState<PaneId>(() => {
    const p = localStorage.getItem("cd-pane");
    if (
      p === "memory" ||
      p === "source" ||
      p === "todos" ||
      p === "chat" ||
      p === "archive"
    ) {
      return p;
    }
    return "chat";
  });
  const [archiveRefreshKey, setArchiveRefreshKey] = useState(0);
  const [modelOptions, setModelOptions] = useState<ModelOptionDto[]>([]);
  /** Default selection key `provider::model` for new chats. */
  const [defaultModelKey, setDefaultModelKey] = useState<string>("");

  const refreshModels = useCallback(async () => {
    try {
      const [listed, def] = await Promise.all([
        hostListChatModels(),
        hostGetDefaultChatModel(),
      ]);
      setModelOptions(listed);
      if (def?.trim()) {
        setDefaultModelKey(def.trim());
        const { modelId } = parseModelSelectionKey(def.trim());
        if (modelId) {
          setSetup((s) =>
            s.chatModel === modelId ? s : { ...s, chatModel: modelId },
          );
        }
      } else {
        const d = listed.find((m) => m.is_default) ?? listed[0];
        if (d) setDefaultModelKey(d.selection_key);
      }
    } catch {
      /* browser / host */
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels, setup.providerKind, setup.baseUrl]);

  useEffect(() => {
    localStorage.setItem("cd-pane", pane);
  }, [pane]);

  // Auto-scroll when content grows if user is following the bottom.
  // Do not mark-read on every token (that re-rendered and fought the viewport).
  const lastContentSig = `${messages.length}:${messages[messages.length - 1]?.content.length ?? 0}:${messages[messages.length - 1]?.streaming ? "1" : "0"}:${isFolded ? "f" : "u"}`;
  useEffect(() => {
    if (pane !== "chat") return;
    if (stickToBottomRef.current) {
      pinScrollToEnd("auto");
      setUnreadBelow(0);
    } else {
      setUnreadBelow(
        countUnread(messages, activeSession?.lastReadMessageId ?? null),
      );
    }
  }, [
    lastContentSig,
    pane,
    messages,
    activeSession?.lastReadMessageId,
    countUnread,
    pinScrollToEnd,
  ]);

  // Switching chats: restore unread badge; jump to bottom if fully read.
  useEffect(() => {
    if (pane !== "chat") return;
    const lastRead = activeSession?.lastReadMessageId ?? null;
    const n = countUnread(messages, lastRead);
    setUnreadBelow(n);
    if (n === 0) {
      stickToBottomRef.current = true;
      pinScrollToEnd("auto");
    } else {
      stickToBottomRef.current = false;
    }
    // only when session id / pane changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pane]);

  const [hostPreflightReport, setHostPreflightReport] =
    useState<PreflightReport | null>(null);
  const [memoryDocs, setMemoryDocs] = useState<MemoryDoc[]>([]);
  const [memoryPath, setMemoryPath] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState("");
  const [agentError, setAgentError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cd-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-ui-scale", uiScale);
    localStorage.setItem("cd-ui-scale", uiScale);
  }, [uiScale]);

  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${sidebarW}px`);
    localStorage.setItem("cd-sidebar-w", String(sidebarW));
  }, [sidebarW]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDragging.current) return;
      const next = Math.min(420, Math.max(140, e.clientX));
      setSidebarW(next);
    };
    const onUp = () => {
      if (!sidebarDragging.current) return;
      sidebarDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    void hostGetBranding().then((b) => {
      setBranding(b);
      document.title = b.name;
    });
    void hostGetConfig().then((cfg) => {
      if (!cfg?.workspace) return;
      const roots = (cfg.workspace.roots ?? []).map(String);
      setSetup((s) => ({
        ...s,
        workspaceName: cfg.workspace?.name ?? s.workspaceName,
        workspaceRoots: roots.length ? roots : s.workspaceRoots,
      }));
    });
  }, []);

  useEffect(() => {
    // Never persist secrets — setup type only holds booleans/refs metadata.
    localStorage.setItem("cd-setup", JSON.stringify(setup));
  }, [setup]);

  const clientPreflight = useMemo(() => runClientPreflight(setup), [setup]);
  const preflight = hostPreflightReport ?? clientPreflight;

  const refreshHostPreflight = useCallback(async () => {
    const report = await hostPreflight();
    if (!report) return;
    setHostPreflightReport({
      items: report.items.map((i) => ({
        id: i.id,
        title: i.title,
        level: i.level,
        detail: i.detail,
        fixAction:
          (i.fix_action as
            | "workspace"
            | "ai"
            | "connectors"
            | "general"
            | "appearance"
            | undefined) ?? undefined,
      })),
      hasBlocking: report.has_blocking,
    });
    if (setup.providerKind === "ollama") {
      const ok = await hostCheckOllama(setup.baseUrl);
      if (ok !== null) {
        setSetup((s) => ({ ...s, ollamaReachable: ok }));
      }
    }
  }, [setup.baseUrl, setup.providerKind]);

  const refreshMemory = useCallback(async () => {
    try {
      const files = await hostListMemory();
      setMemoryDocs(
        files.map((f) => ({
          path: f.path,
          title: f.title,
          body: f.body,
        })),
      );
      if (files.length && !memoryPath) {
        setMemoryPath(files[0].path);
      }
    } catch {
      /* browser without host */
    }
  }, [memoryPath]);

  useEffect(() => {
    void refreshHostPreflight();
  }, [setup.workspaceRoots, setup.providerKind, setup.chatModel]);

  useEffect(() => {
    if (setup.workspaceRoots.length > 0) {
      void refreshMemory();
    }
  }, [setup.workspaceRoots, refreshMemory]);

  // Auto-open Preflight each cold start while setup is incomplete (NexaDeck-style
  // readiness gate). Closing settings / Continue dismisses for this session only.
  useEffect(() => {
    if (!preflight.hasBlocking) {
      autoOpenedPreflight.current = false;
      if (sessionStorage.getItem("cd-setup-dismissed") === "1") {
        sessionStorage.removeItem("cd-setup-dismissed");
        setDismissedBanner(false);
      }
      return;
    }
    if (
      dismissedBanner ||
      settingsOpen ||
      autoOpenedPreflight.current ||
      sessionStorage.getItem("cd-setup-dismissed") === "1"
    ) {
      return;
    }
    autoOpenedPreflight.current = true;
    setSettingsSection("preflight");
    setSettingsOpen(true);
  }, [preflight.hasBlocking, dismissedBanner, settingsOpen]);

  const chatScrollSaveRef = useRef(0);

  const openSettings = (section: SettingsSection = "preflight") => {
    // Preserve transcript scroll across Settings overlay (#155).
    if (chatScrollRef.current) {
      chatScrollSaveRef.current = chatScrollRef.current.scrollTop;
    }
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const dismissSetupPrompt = useCallback(() => {
    sessionStorage.setItem("cd-setup-dismissed", "1");
    setDismissedBanner(true);
  }, []);

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    if (preflight.hasBlocking) {
      dismissSetupPrompt();
    }
    // Restore scroll after overlay unmount reflow (#155).
    const top = chatScrollSaveRef.current;
    window.requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (!el) return;
      el.scrollTop = top;
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    });
  }, [preflight.hasBlocking, dismissSetupPrompt]);

  const onSubmit = useCallback(
    async (text: string): Promise<boolean> => {
      if (preflight.hasBlocking) {
        openSettings("preflight");
        return false;
      }
      stopRef.current = false;
      setAgentError(null);
      setBusy(true);
      setTurnStartedAt(Date.now());
      stickToBottomRef.current = true;
      setUnreadBelow(0);
      const user: Msg = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      };
      const assistantId = crypto.randomUUID();
      const assistant: Msg = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
      };
      // Short heuristic title immediately; LLM upgrades shortly after (if unlocked).
      const wasFirstUser =
        (sessions.find((s) => s.id === resolvedSessionId)?.messages.filter(
          (m) => m.role === "user",
        ).length ?? 0) === 0;
      setSessions((all) =>
        all.map((s) => {
          if (s.id !== resolvedSessionId) return s;
          let title = s.title;
          if (!s.titleLocked && isPlaceholderTitle(s.title)) {
            const auto = titleFromPrompt(text);
            if (auto) title = auto;
          }
          return {
            ...s,
            title,
            messages: [...s.messages, user, assistant],
            lastReadMessageId: assistantId,
            updatedAt: nowIso(),
          };
        }),
      );
      setPane("chat");
      // After React commits the new bubbles (empty-state unmounts), pin to end.
      pinScrollToEnd("auto");
      if (wasFirstUser) {
        void upgradeTitleWithLlm(sessionId, text);
      }

      // Prefer local retrieval when Ollama unknown / offline; host upgrades if model up.
      const forceLocal =
        setup.providerKind === "ollama" && setup.ollamaReachable === false;
      const sess = sessions.find((s) => s.id === sessionId);
      const sessionModel = sess?.chatModel ?? null;
      const sessionProvider = sess?.providerProfileId ?? null;
      // Snapshot provenance at send time (footer survives model switches later).
      const metaAtSend = snapshotMessageMeta({
        sessionModel,
        sessionProvider,
        modelOptions,
        defaultModelKey,
        setup,
      });

      try {
        // #108: live Channel stream — each EventDto reduces into the assistant
        // bubble as it arrives. No post-hoc 28ms setTimeout replay.
        // prefers-reduced-motion is CSS-only on beam/materialize (MarkdownBody).
        await agentTurn(
          sessionId,
          text,
          forceLocal,
          sessionModel,
          sessionProvider,
          (ev) => {
            if (stopRef.current) return;

            // Surface permission modal immediately (mid-turn), not at turn end.
            if (ev.kind === "permission_required") {
              const { permission: perm } = applyEventsToMessage(
                {
                  id: assistantId,
                  role: "assistant",
                  content: "",
                },
                [ev],
              );
              if (perm) {
                setPermission(perm);
                const args = ev.payload?.arguments;
                if (args && typeof args === "object" && !Array.isArray(args)) {
                  setPendingToolArgs(args as Record<string, unknown>);
                } else {
                  setPendingToolArgs({});
                }
              }
            }

            setSessions((all) => {
              const cur = all.find((s) => s.id === sessionId);
              if (!cur) return all;
              const m = cur.messages;
              const idx = m.findIndex((x) => x.id === assistantId);
              if (idx < 0) return all;
              const base = m[idx];
              const done =
                ev.kind === "turn_completed" || ev.kind === "error";
              const { msg } = applyEventsToMessage(
                { ...base, streaming: !done },
                [ev],
              );
              // Host-fact model from turn_started wins; keep requested snapshot (#155).
              const merged: Msg = {
                ...msg,
                streaming: !done,
                meta: {
                  ...metaAtSend,
                  ...msg.meta,
                  requested_model:
                    metaAtSend.requested_model || metaAtSend.model,
                  host_confirmed: Boolean(msg.meta?.host_confirmed),
                  model: msg.meta?.host_confirmed
                    ? msg.meta.model
                    : metaAtSend.model,
                },
              };
              if (done) {
                const cite = merged.citations?.[0];
                if (cite) {
                  // Preload source content but stay on Chat — user opens Source on click (#155).
                  setSourcePath(cite.id);
                  void hostReadFile(cite.id)
                    .then((body) => {
                      setSourceContent(body);
                    })
                    .catch((err) => {
                      setSourceContent(
                        `Could not read file:\n${err instanceof Error ? err.message : String(err)}`,
                      );
                    });
                }
                if (merged.tools?.some((t) => t.name === "save_memory" && t.ok)) {
                  void refreshMemory();
                }
              }
              const nextMsgs = [...m];
              nextMsgs[idx] = merged;
              const updated: ChatSession = {
                ...cur,
                messages: nextMsgs,
                updatedAt: nowIso(),
              };
              // Durable auto-save once the turn completes; transcript = streamed content.
              if (done) {
                void persistSession(updated).then((saved) => {
                  setSessions((prev) =>
                    prev.map((s) => (s.id === saved.id ? saved : s)),
                  );
                });
              }
              return all.map((s) => (s.id === sessionId ? updated : s));
            });
          },
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        setAgentError(err);
        setSessions((all) => {
          const cur = all.find((s) => s.id === sessionId);
          if (!cur) return all;
          const updated: ChatSession = {
            ...cur,
            messages: cur.messages.map((x) =>
              x.id === assistantId
                ? {
                    ...x,
                    streaming: false,
                    content: `**Host error:** ${err}`,
                    meta: metaAtSend,
                  }
                : x,
            ),
            updatedAt: nowIso(),
          };
          void persistSession(updated).then((saved) => {
            setSessions((prev) =>
              prev.map((s) => (s.id === saved.id ? saved : s)),
            );
          });
          return all.map((s) => (s.id === sessionId ? updated : s));
        });
      } finally {
        setBusy(false);
        setTurnStartedAt(null);
      }
      return true;
    },
    [
      preflight.hasBlocking,
      sessionId,
      resolvedSessionId,
      sessions,
      setup.ollamaReachable,
      setup.providerKind,
      setup.providerLabel,
      setup.chatModel,
      setup.baseUrl,
      modelOptions,
      defaultModelKey,
      refreshMemory,
      persistSession,
      upgradeTitleWithLlm,
      pinScrollToEnd,
    ],
  );

  const effectiveModelKey = (() => {
    if (activeSession?.chatModel && activeSession.providerProfileId) {
      return modelSelectionKey(
        activeSession.providerProfileId,
        activeSession.chatModel,
      );
    }
    if (activeSession?.chatModel) {
      const match = modelOptions.find((m) => m.id === activeSession.chatModel);
      if (match) return match.selection_key;
    }
    return (
      defaultModelKey ||
      modelOptions.find((m) => m.is_default)?.selection_key ||
      modelOptions[0]?.selection_key ||
      ""
    );
  })();

  const effectiveChatModel =
    parseModelSelectionKey(effectiveModelKey).modelId ||
    activeSession?.chatModel ||
    setup.chatModel ||
    "mistral";

  const setSessionModel = (selectionKey: string) => {
    if (!activeSession) return;
    const { providerId, modelId } = parseModelSelectionKey(selectionKey);
    const updated = {
      ...activeSession,
      chatModel: modelId,
      providerProfileId: providerId,
      updatedAt: nowIso(),
    };
    setSessions((all) =>
      all.map((s) => (s.id === activeSession.id ? updated : s)),
    );
    if (updated.messages.length > 0) {
      void hostSaveChatSession(sessionToDto(updated)).catch(() => {
        /* ignore */
      });
    }
  };

  const setAppDefaultModel = async (selectionKey: string) => {
    try {
      const saved = await hostSetDefaultChatModel(selectionKey);
      const next = saved?.trim() || selectionKey;
      setDefaultModelKey(next);
      const { modelId } = parseModelSelectionKey(next);
      if (modelId) setSetup((s) => ({ ...s, chatModel: modelId }));
      setModelOptions((opts) =>
        opts.map((m) => ({
          ...m,
          is_default: m.selection_key === next,
        })),
      );
      void refreshModels();
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    }
  };

  const createSession = () => {
    const { providerId, modelId } = parseModelSelectionKey(defaultModelKey);
    const s = newSession(
      `Chat ${sessions.length + 1}`,
      modelId || null,
    );
    s.providerProfileId = providerId;
    setSessions((all) => [s, ...all]);
    setActiveSessionId(s.id);
    setPane("chat");
  };

  const openSessionById = async (id: string) => {
    const existing = sessions.find((s) => s.id === id);
    if (existing) {
      setActiveSessionId(id);
      setPane("chat");
      return;
    }
    try {
      const dto = await hostLoadChatSession(id);
      if (dto) {
        if (dto.trashed) {
          setAgentError(
            "That chat is in Trash. Restore it from Archive → Trash first.",
          );
          setPane("archive");
          return;
        }
        const s = sessionFromDto(dto);
        setSessions((all) => {
          if (all.some((x) => x.id === s.id)) return all;
          return [s, ...all];
        });
        setActiveSessionId(s.id);
        setPane("chat");
      }
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    }
  };

  type ChatCtxMenu = { sessionId: string; x: number; y: number };
  const [chatCtxMenu, setChatCtxMenu] = useState<ChatCtxMenu | null>(null);

  useEffect(() => {
    if (!chatCtxMenu) return;
    const close = () => setChatCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [chatCtxMenu]);

  const openChatCtxMenu = (
    e: ReactMouseEvent,
    sessionId: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    // Keep menu on-screen
    const pad = 8;
    const w = 180;
    const h = 160;
    const x = Math.min(e.clientX, window.innerWidth - w - pad);
    const y = Math.min(e.clientY, window.innerHeight - h - pad);
    setChatCtxMenu({ sessionId, x: Math.max(pad, x), y: Math.max(pad, y) });
  };

  const renameSessionById = async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    setRenameTarget({ id: target.id, title: target.title });
  };

  const applyRename = async (title: string) => {
    const target = renameTarget;
    setRenameTarget(null);
    if (!target) return;
    const next = title.trim();
    if (!next) return;
    try {
      const saved = await hostRenameChatSession(target.id, next);
      if (saved) {
        setSessions((all) =>
          all.map((s) => (s.id === saved.id ? sessionFromDto(saved) : s)),
        );
        setArchiveRefreshKey((n) => n + 1);
        return;
      }
    } catch {
      /* local fallback */
    }
    setSessions((all) =>
      all.map((s) =>
        s.id === target.id
          ? { ...s, title: next, titleLocked: true, updatedAt: nowIso() }
          : s,
      ),
    );
  };

  const togglePinById = async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const nextPinned = !target.pinned;
    try {
      if (target.messages.length > 0) {
        const saved = await hostPinChatSession(id, nextPinned);
        if (saved) {
          setSessions((all) =>
            all.map((s) => (s.id === saved.id ? sessionFromDto(saved) : s)),
          );
          setArchiveRefreshKey((n) => n + 1);
          return;
        }
      }
    } catch {
      /* local */
    }
    setSessions((all) =>
      all.map((s) =>
        s.id === id ? { ...s, pinned: nextPinned, updatedAt: nowIso() } : s,
      ),
    );
  };

  /** Drop a session from in-memory list (after trash/delete); keep a blank chat if empty. */
  const dropSessionLocally = (id: string) => {
    setSessions((all) => {
      const next = all.filter((s) => s.id !== id && !s.trashed);
      if (next.length === 0) {
        const { modelId, providerId } = parseModelSelectionKey(defaultModelKey);
        const s = newSession("Chat 1", modelId || null);
        s.providerProfileId = providerId;
        setActiveSessionId(s.id);
        return [s];
      }
      if (resolvedSessionId === id) {
        setActiveSessionId(next[0].id);
      }
      return next;
    });
  };

  /**
   * Soft-delete: move to trash. Fixes sidebar ghosts by removing local state
   * and never resurrecting missing disk sessions on archive refresh.
   */
  const trashSessionById = async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const ok = await dialogConfirm(
      `Move “${target.title}” to Trash?\n\nYou can restore it from Archive → Trash. Permanent delete is only from Trash.`,
      { title: "Move to Trash", kind: "warning" },
    );
    if (!ok) return;
    try {
      await hostTrashChatSession(id);
    } catch {
      /* still drop local so sidebar is honest */
    }
    setArchiveRefreshKey((n) => n + 1);
    dropSessionLocally(id);
  };

  /** Sync local session flags from disk; drop sessions that vanished or were trashed. */
  const syncSessionsFromHost = useCallback(async () => {
    try {
      const metas = await hostListChatSessions();
      const byId = new Map(metas.map((m) => [m.id, m]));
      setSessions((all) => {
        const next = all
          .filter((s) => {
            const m = byId.get(s.id);
            // Gone from disk (permanent delete) or in trash → leave local list
            if (!m) {
              // Keep never-saved empty drafts
              return s.messages.length === 0 && !s.trashed;
            }
            if (m.trashed) return false;
            return true;
          })
          .map((s) => {
            const m = byId.get(s.id);
            if (!m) return s;
            return {
              ...s,
              title: m.title,
              pinned: m.pinned,
              archived: m.archived,
              trashed: m.trashed ?? false,
              trashedAt: m.trashed_at ?? null,
              updatedAt: m.updated_at,
            };
          })
          .filter((s) => !s.archived && !s.trashed);
        if (next.length === 0) {
          const { modelId, providerId } =
            parseModelSelectionKey(defaultModelKey);
          const blank = newSession("Chat 1", modelId || null);
          blank.providerProfileId = providerId;
          setActiveSessionId(blank.id);
          return [blank];
        }
        if (!next.some((s) => s.id === resolvedSessionId)) {
          setActiveSessionId(next[0].id);
        }
        return next;
      });
    } catch {
      /* ignore */
    }
  }, [defaultModelKey, resolvedSessionId]);

  /**
   * All open chats (in-memory, not archived/trashed).
   * Used for the chat tab strip and sidebar — not pin-only.
   */
  const openChatSessions = (() => {
    return sessions
      .filter((s) => !s.archived && !s.trashed)
      .slice()
      .sort((a, b) => {
        // Pinned first, then most recently updated.
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  })();

  const onPermissionRespond = async (
    decision: "deny" | "allow_once" | "allow_session_path",
    typed?: string,
  ) => {
    if (!permission) return;
    try {
      const events = await completePermission(
        permission.requestId,
        decision,
        permission.toolName,
        pendingToolArgs ?? {},
        typed,
        sessionId,
      );
      setPermission(null);
      setPendingToolArgs(null);
      // Append tool results as a system-visible assistant follow-up
      setMessages((m) => {
        const { msg } = applyEventsToMessage(
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: decision === "deny" ? "Write denied." : "",
          },
          events,
        );
        return [...m, msg];
      });
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
      setPermission(null);
    }
  };

  const scopeLabel =
    setup.workspaceRoots.length > 0
      ? `${setup.workspaceRoots.length} root${setup.workspaceRoots.length === 1 ? "" : "s"}`
      : "No workspace";

  const localOnly =
    setup.localOnly ?? setup.providerKind === "ollama";
  const egressLabel = localOnly
    ? "Local-only"
    : setup.providerKind === "xai_grok_build"
      ? "Grok session"
      : setup.providerKind === "openai_compatible" ||
          setup.providerKind === "anthropic"
        ? "Remote AI"
        : "Local";

  const onSaveSetup = async (next: AppSetupState) => {
    setSetup(next);
    try {
      // Always sync host allowlist (including clearing roots).
      await hostSetWorkspace(
        next.workspaceName ?? "Workspace",
        next.workspaceRoots,
      );
    } catch {
      /* browser mode */
    }
    void refreshHostPreflight();
  };

  return (
    <div className="app-shell">
      {settingsOpen ? (
      <SettingsModal
        open={settingsOpen}
        initialSection={settingsSection}
        setup={setup}
        theme={theme}
        onThemeChange={setTheme}
        uiScale={uiScale}
        onUiScaleChange={setUiScale}
        onClose={closeSettings}
        onSaveSetup={onSaveSetup}
        onRecheckHost={refreshHostPreflight}
        hostReport={hostPreflightReport}
      />
      ) : (
      <div className="app-chrome">
      <header className="titlebar">
        <div className="titlebar__brand">
          <IconSpark title={branding.name} />
          <span>{branding.name}</span>
          <button
            type="button"
            className="chip"
            data-tone={setup.workspaceRoots.length ? "ok" : "warn"}
            onClick={() => openSettings("workspace")}
            title="Workspace scope"
          >
            {scopeLabel}
          </button>
          <button
            type="button"
            className="chip"
            data-tone={localOnly ? "ok" : "warn"}
            onClick={() => openSettings("ai")}
            title={
              localOnly
                ? "Local-only profile — remote bases refused"
                : "Remote provider may send prompts off-machine"
            }
          >
            {egressLabel}
          </button>
        </div>
        <div className="titlebar__actions">
          <button
            type="button"
            className="icon-btn"
            title="Settings & preflight"
            onClick={() => openSettings("preflight")}
          >
            <IconSettings />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      {preflight.hasBlocking && !dismissedBanner ? (
        <div className="banner" role="status">
          <span className="banner__msg">
            <strong>Setup incomplete</strong>
            Fix workspace or AI provider in Preflight
          </span>
          <span className="banner__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => openSettings("preflight")}
            >
              Open Preflight
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={dismissSetupPrompt}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      {agentError ? (
        <div className="banner" data-tone="danger" role="alert">
          <span className="banner__msg">
            <strong>Error</strong>
            {agentError}
          </span>
          <span className="banner__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setAgentError(null)}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      <div className="app-body">
      <div className="main">
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
            onMouseDown={(e) => {
              e.preventDefault();
              sidebarDragging.current = true;
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setSidebarW((w) => Math.max(140, w - 16));
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                setSidebarW((w) => Math.min(420, w + 16));
              }
            }}
          />
          <div className="row--between">
            <div className="sidebar__label">Chats</div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title="New chat"
              onClick={createSession}
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
                    data-active={s.id === resolvedSessionId ? "true" : undefined}
                    title={`${s.title} — right-click for options`}
                    onClick={() => {
                      setActiveSessionId(s.id);
                      setPane("chat");
                    }}
                    onContextMenu={(e) => openChatCtxMenu(e, s.id)}
                  >
                    <span className="session-list__title">
                      {s.pinned ? "📌 " : ""}
                      {s.title}
                    </span>
                    {s.messages.length > 0 ? (
                      <span className="session-list__meta">
                        {s.messages.length} msg
                      </span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
          <button
            type="button"
            className="session-list__item"
            data-active={pane === "archive" ? "true" : undefined}
            onClick={() => setPane("archive")}
          >
            Archive & trash
          </button>
        </aside>
        <div className="workspace">
          <div
            className="pane-tabs"
            role="tablist"
            aria-label="Main panes"
            onKeyDown={(e) => {
              const order: PaneId[] = [
                "chat",
                "archive",
                "memory",
                "source",
                "todos",
              ];
              const idx = order.indexOf(pane);
              const next = nextRovingIndex(idx < 0 ? 0 : idx, order.length, e.key);
              if (next == null) return;
              e.preventDefault();
              setPane(order[next]);
              window.requestAnimationFrame(() => {
                document.getElementById(`pane-tab-${order[next]}`)?.focus();
              });
            }}
          >
            {(
              [
                ["chat", "Chat"],
                ["archive", "Archive"],
                ["memory", "Memory"],
                ["source", "Source"],
                ["todos", "Todos"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                id={`pane-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={pane === id}
                aria-controls={`pane-panel-${id}`}
                tabIndex={pane === id ? 0 : -1}
                data-active={pane === id ? "true" : "false"}
                onClick={() => setPane(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {pane === "archive" ? (
            <div
              role="tabpanel"
              id="pane-panel-archive"
              aria-labelledby="pane-tab-archive"
              className="pane-panel"
            >
              <ChatArchivePane
                refreshKey={archiveRefreshKey}
                activeSessionId={resolvedSessionId}
                onOpenSession={(id) => void openSessionById(id)}
                onSessionsChanged={() => {
                  setArchiveRefreshKey((n) => n + 1);
                  void syncSessionsFromHost();
                }}
              />
            </div>
          ) : null}

          {pane === "chat" ? (
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
                    {preflight.hasBlocking ? (
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
                  onStop={() => {
                    // Client-side materialization halt (#105) + host cancel flag (#109).
                    stopRef.current = true;
                    if (sessionId) {
                      void hostCancelTurn(sessionId);
                    }
                    setBusy(false);
                    setAgentError(
                      "Stop requested — waiting for the host to end the turn (cancel).",
                    );
                  }}
                />
              </div>
            </div>
          ) : null}

          {pane === "memory" ? (
            <div
              role="tabpanel"
              id="pane-panel-memory"
              aria-labelledby="pane-tab-memory"
              className="pane-panel"
            >
              <MemoryPane
                docs={memoryDocs}
                activePath={memoryPath}
                onSelect={setMemoryPath}
                onCreateHint={() => void refreshMemory()}
                onSave={(path, body) => {
                  const title =
                    memoryDocs.find((d) => d.path === path)?.title ?? "Note";
                  const base =
                    path.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ?? "note";
                  void hostWriteMemory(base, title, body)
                    .then(() => refreshMemory())
                    .catch((err) =>
                      setAgentError(
                        err instanceof Error ? err.message : String(err),
                      ),
                    );
                }}
              />
            </div>
          ) : null}

          {pane === "source" ? (
            <div
              role="tabpanel"
              id="pane-panel-source"
              aria-labelledby="pane-tab-source"
              className="pane-panel"
            >
              <SourcePreviewPane path={sourcePath} content={sourceContent} />
            </div>
          ) : null}

          {pane === "todos" ? (
            <div
              role="tabpanel"
              id="pane-panel-todos"
              aria-labelledby="pane-tab-todos"
              className="pane-panel"
            >
              <TodoPane storageKey={`cd-todos-${sessionId}`} />
            </div>
          ) : null}
        </div>
      </div>
      </div>

      <footer className="status-bar">
        <span className="status-bar__left">
          <span
            className="status-bar__dot"
            data-live={busy ? "true" : undefined}
            data-warn={!busy && preflight.hasBlocking ? "true" : undefined}
            data-ok={!busy && !preflight.hasBlocking ? "true" : undefined}
            aria-hidden
          />
          <span>
            {busy
              ? "Live · agent turn"
              : preflight.hasBlocking
                ? "Setup incomplete"
                : "Ready"}
          </span>
          <span aria-hidden>·</span>
          <button type="button" onClick={() => openSettings("preflight")}>
            Preflight {preflight.hasBlocking ? "issues" : "ok"}
          </button>
        </span>
        <span className="status-bar__right">
          <button type="button" onClick={() => openSettings("workspace")}>
            {scopeLabel}
          </button>
          <span aria-hidden>·</span>
          <button type="button" onClick={() => openSettings("ai")}>
            {egressLabel}
          </button>
          {effectiveChatModel ? (
            <>
              <span aria-hidden>·</span>
              <span className="mono" title="Model for this chat">
                {effectiveChatModel}
              </span>
            </>
          ) : null}
        </span>
      </footer>
      </div>
      )}

      <PermissionModal prompt={permission} onRespond={onPermissionRespond} />

      <RenameChatModal
        open={Boolean(renameTarget)}
        initialTitle={renameTarget?.title ?? ""}
        onCancel={() => setRenameTarget(null)}
        onConfirm={(t) => void applyRename(t)}
      />

      {chatCtxMenu
        ? (() => {
            const target = sessions.find((s) => s.id === chatCtxMenu.sessionId);
            if (!target) return null;
            return (
              <div
                className="chat-ctx-menu"
                role="menu"
                style={{ left: chatCtxMenu.x, top: chatCtxMenu.y }}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="chat-ctx-menu__item"
                  onClick={() => {
                    setChatCtxMenu(null);
                    setActiveSessionId(target.id);
                    setPane("chat");
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="chat-ctx-menu__item"
                  onClick={() => {
                    setChatCtxMenu(null);
                    void renameSessionById(target.id);
                  }}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="chat-ctx-menu__item"
                  onClick={() => {
                    setChatCtxMenu(null);
                    void togglePinById(target.id);
                  }}
                >
                  {target.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="chat-ctx-menu__item"
                  onClick={() => {
                    setChatCtxMenu(null);
                    setPane("archive");
                  }}
                >
                  Open archive
                </button>
                <div className="chat-ctx-menu__sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="chat-ctx-menu__item chat-ctx-menu__item--danger"
                  onClick={() => {
                    setChatCtxMenu(null);
                    void trashSessionById(target.id);
                  }}
                >
                  Move to Trash…
                </button>
              </div>
            );
          })()
        : null}
    </div>
  );
}
