import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { MarkdownBody } from "./components/MarkdownBody";
import {
  PermissionModal,
  type PermissionPrompt,
} from "./components/PermissionModal";
import {
  SettingsModal,
  type SettingsSection,
} from "./components/SettingsModal";
import { ToolCallList, type ToolCallView } from "./components/ToolCallList";
import { MemoryPane, type MemoryDoc } from "./components/panes/MemoryPane";
import { SourcePreviewPane } from "./components/panes/SourcePreviewPane";
import { TodoPane } from "./components/panes/TodoPane";
import { IconMoon, IconSettings, IconSpark, IconSun } from "./components/icons";
import {
  agentTurn,
  completePermission,
  hostCheckOllama,
  hostDeleteChatSession,
  hostGetBranding,
  hostGetConfig,
  hostListChatSessions,
  hostListMemory,
  hostLoadChatSession,
  hostPreflight,
  hostReadFile,
  hostRenameChatSession,
  hostSaveChatSession,
  hostSetWorkspace,
  hostSuggestChatTitle,
  hostWriteMemory,
  type BrandingDto,
  type ChatSessionDto,
  type EventDto,
} from "./lib/host";
import {
  runClientPreflight,
  type AppSetupState,
  type PreflightReport,
} from "./lib/preflight";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolCallView[];
  citations?: { id: string; label: string }[];
  trail?: string[];
  streaming?: boolean;
};

type PaneId = "chat" | "memory" | "source" | "todos";

function loadTheme(): "dark" | "light" {
  const t = localStorage.getItem("cd-theme");
  return t === "light" ? "light" : "dark";
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
  };
}

function applyEventsToMessage(
  base: Msg,
  events: EventDto[],
): { msg: Msg; permission: PermissionPrompt | null } {
  let content = base.content;
  const tools: ToolCallView[] = [...(base.tools ?? [])];
  const citations: { id: string; label: string }[] = [
    ...(base.citations ?? []),
  ];
  const trail: string[] = [...(base.trail ?? [])];
  let permission: PermissionPrompt | null = null;

  for (const ev of events) {
    const p = ev.payload;
    switch (ev.kind) {
      case "text_delta":
        content += String(p.text ?? "");
        break;
      case "tool": {
        const id = String(p.id ?? crypto.randomUUID());
        const existing = tools.find((t) => t.id === id);
        if (existing) {
          existing.summary = String(p.summary ?? existing.summary);
          if (p.detail) existing.detail = String(p.detail);
          if (p.ok !== undefined && p.ok !== null) existing.ok = Boolean(p.ok);
        } else {
          tools.push({
            id,
            name: String(p.name ?? "tool"),
            summary: String(p.summary ?? ""),
            detail: p.detail ? String(p.detail) : undefined,
            ok: p.ok === undefined || p.ok === null ? undefined : Boolean(p.ok),
          });
        }
        break;
      }
      case "citation":
        citations.push({
          id: String(p.source_id ?? p.label ?? ""),
          label: String(p.label ?? p.source_id ?? "source"),
        });
        break;
      case "search_trail": {
        const steps = p.steps;
        if (Array.isArray(steps)) {
          for (const s of steps) {
            const step = String(s);
            if (step && !trail.includes(step)) trail.push(step);
          }
        }
        break;
      }
      case "permission_required":
        permission = {
          requestId: String(p.request_id ?? ""),
          toolName: String(p.tool_name ?? ""),
          target: String(p.target ?? ""),
          reason: String(p.reason ?? ""),
          preview: String(p.preview ?? ""),
          risk: String(p.risk ?? "local"),
          typeConfirmPhrase:
            p.risk === "remote" || p.risk === "destructive" ? "WRITE" : null,
        };
        break;
      case "error":
        content += `\n\n**Error:** ${String(p.message ?? "unknown")}\n`;
        break;
      default:
        break;
    }
  }

  // When retrieval produced citations, ensure content can reference them as chips.
  if (citations.length && content && !content.includes("#cite:")) {
    const refs = citations
      .map((c) => `[${c.label}](#cite:${c.id})`)
      .join(" ");
    if (!content.includes(citations[0].label)) {
      content = `${content.trim()}\n\nSources: ${refs}`;
    }
  }

  return {
    msg: {
      ...base,
      content,
      tools: tools.length ? tools : undefined,
      citations: citations.length ? citations : undefined,
      trail: trail.length ? trail : undefined,
      streaming: false,
    },
    permission,
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
  };

  const nowIso = () => new Date().toISOString();

  const newSession = (title = "Chat"): ChatSession => {
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
        ? (m.citations as { id: string; label: string }[])
        : undefined,
      trail: m.trail ?? undefined,
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
    })),
    compact_keep_last: s.compactKeepLast,
    show_full_history: s.showFullHistory,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    archived: s.archived,
    title_locked: s.titleLocked,
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

  const setShowFullHistory = (show: boolean) => {
    setSessions((all) =>
      all.map((s) =>
        s.id === resolvedSessionId ? { ...s, showFullHistory: show } : s,
      ),
    );
  };

  const persistSession = useCallback(async (s: ChatSession) => {
    if (s.messages.length === 0) return s;
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
          const s = newSession("Chat 1");
          setSessions([s]);
          setActiveSessionId(s.id);
          setSessionsReady(true);
          return;
        }
        const loaded: ChatSession[] = [];
        for (const meta of metas) {
          if (meta.archived) continue;
          const dto = await hostLoadChatSession(meta.id);
          if (dto) loaded.push(sessionFromDto(dto));
        }
        if (cancelled) return;
        if (loaded.length === 0) {
          const s = newSession("Chat 1");
          setSessions([s]);
          setActiveSessionId(s.id);
        } else {
          setSessions(loaded);
          setActiveSessionId(loaded[0].id);
        }
      } catch {
        if (!cancelled) {
          const s = newSession("Chat 1");
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
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [pendingToolArgs, setPendingToolArgs] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [pane, setPane] = useState<PaneId>(() => {
    const p = localStorage.getItem("cd-pane");
    if (p === "memory" || p === "source" || p === "todos" || p === "chat") return p;
    return "chat";
  });
  useEffect(() => {
    localStorage.setItem("cd-pane", pane);
  }, [pane]);
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

  const openSettings = (section: SettingsSection = "preflight") => {
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
  }, [preflight.hasBlocking, dismissSetupPrompt]);

  const onSubmit = useCallback(
    async (text: string) => {
      if (preflight.hasBlocking) {
        openSettings("preflight");
        return;
      }
      setAgentError(null);
      setBusy(true);
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
            updatedAt: nowIso(),
          };
        }),
      );
      setPane("chat");
      if (wasFirstUser) {
        void upgradeTitleWithLlm(sessionId, text);
      }

      try {
        // Prefer local retrieval when Ollama unknown / offline; host upgrades if model up.
        const forceLocal =
          setup.providerKind === "ollama" && setup.ollamaReachable === false;
        const events = await agentTurn(sessionId, text, forceLocal);

        // Progressive append of real text_delta chunks from the agent host
        // (batch IPC; UI materializes tokens — not a hardcoded demo shell).
        const textEvents = events.filter((e) => e.kind === "text_delta");
        const prefersReduced =
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const delayMs = prefersReduced ? 0 : 18;

        for (const ev of textEvents) {
          const chunk = String(ev.payload?.text ?? "");
          if (!chunk) continue;
          setMessages((m) => {
            const idx = m.findIndex((x) => x.id === assistantId);
            if (idx < 0) return m;
            const next = [...m];
            next[idx] = {
              ...next[idx],
              content: next[idx].content + chunk,
              streaming: true,
            };
            return next;
          });
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }

        // Tools, citations, trail, permissions (once) + durable auto-save.
        setSessions((all) => {
          const cur = all.find((s) => s.id === sessionId);
          if (!cur) return all;
          const m = cur.messages;
          const idx = m.findIndex((x) => x.id === assistantId);
          if (idx < 0) return all;
          const streamedContent = m[idx].content;
          const { msg, permission: perm } = applyEventsToMessage(
            { ...m[idx], content: streamedContent },
            events.filter((e) => e.kind !== "text_delta"),
          );
          const merged: Msg = {
            ...msg,
            content: streamedContent || msg.content,
            streaming: false,
          };
          if (perm) {
            setPermission(perm);
            const prev = events.find((e) => e.kind === "permission_required");
            const args = prev?.payload?.arguments;
            if (args && typeof args === "object" && !Array.isArray(args)) {
              setPendingToolArgs(args as Record<string, unknown>);
            } else {
              setPendingToolArgs({});
            }
          }
          const cite = merged.citations?.[0];
          if (cite) {
            setSourcePath(cite.id);
            void hostReadFile(cite.id)
              .then((body) => {
                setSourceContent(body);
                setPane("source");
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
          const nextMsgs = [...m];
          nextMsgs[idx] = merged;
          const updated: ChatSession = {
            ...cur,
            messages: nextMsgs,
            updatedAt: nowIso(),
          };
          void persistSession(updated).then((saved) => {
            setSessions((prev) =>
              prev.map((s) => (s.id === saved.id ? saved : s)),
            );
          });
          return all.map((s) => (s.id === sessionId ? updated : s));
        });
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
      }
    },
    [
      preflight.hasBlocking,
      sessionId,
      resolvedSessionId,
      sessions,
      setup.ollamaReachable,
      setup.providerKind,
      refreshMemory,
      persistSession,
      upgradeTitleWithLlm,
    ],
  );

  const createSession = () => {
    const s = newSession(`Chat ${sessions.length + 1}`);
    setSessions((all) => [s, ...all]);
    setActiveSessionId(s.id);
  };

  const renameActiveSession = async () => {
    if (!activeSession) return;
    const next = window.prompt("Rename chat", activeSession.title);
    if (next === null) return;
    const title = next.trim();
    if (!title) return;
    try {
      const saved = await hostRenameChatSession(activeSession.id, title);
      if (saved) {
        setSessions((all) =>
          all.map((s) => (s.id === saved.id ? sessionFromDto(saved) : s)),
        );
        return;
      }
    } catch {
      /* local fallback */
    }
    setSessions((all) =>
      all.map((s) =>
        s.id === activeSession.id
          ? { ...s, title, titleLocked: true, updatedAt: nowIso() }
          : s,
      ),
    );
  };

  const deleteActiveSession = async () => {
    if (!activeSession) return;
    const ok = window.confirm(
      `Delete chat “${activeSession.title}”? This cannot be undone.`,
    );
    if (!ok) return;
    const id = activeSession.id;
    try {
      await hostDeleteChatSession(id);
    } catch {
      /* still drop local */
    }
    setSessions((all) => {
      const next = all.filter((s) => s.id !== id);
      if (next.length === 0) {
        const s = newSession("Chat 1");
        setActiveSessionId(s.id);
        return [s];
      }
      setActiveSessionId(next[0].id);
      return next;
    });
  };

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
      : setup.providerKind === "openai_compatible"
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
            ) : (
              sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="session-list__item"
                    data-active={s.id === resolvedSessionId ? "true" : undefined}
                    title={s.messages[0]?.content?.slice(0, 120) || s.title}
                    onClick={() => setActiveSessionId(s.id)}
                    onDoubleClick={() => {
                      if (s.id === resolvedSessionId) void renameActiveSession();
                    }}
                  >
                    <span className="session-list__title">{s.title}</span>
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
          {activeSession && activeSession.messages.length > 0 ? (
            <div className="session-list__actions">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void renameActiveSession()}
              >
                Rename
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void deleteActiveSession()}
              >
                Delete
              </button>
            </div>
          ) : null}
          <div className="sidebar__label">Setup</div>
          {preflight.hasBlocking ? (
            <button
              type="button"
              className="session-list__item"
              data-warn="true"
              onClick={() => openSettings("preflight")}
            >
              Preflight · issues
            </button>
          ) : null}
          <button
            type="button"
            className="session-list__item"
            onClick={() => openSettings("ai")}
          >
            AI / Models
          </button>
        </aside>
        <div className="workspace">
          <div className="pane-tabs" role="tablist">
            {(
              [
                ["chat", "Chat"],
                ["memory", "Memory"],
                ["source", "Source"],
                ["todos", "Todos"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                data-active={pane === id ? "true" : "false"}
                onClick={() => setPane(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {pane === "chat" ? (
            <>
              <div className="session-tabs" role="tablist" aria-label="Chat sessions">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    className="session-tab"
                    data-active={s.id === resolvedSessionId ? "true" : "false"}
                    onClick={() => setActiveSessionId(s.id)}
                  >
                    {s.title}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  title="New chat"
                  onClick={createSession}
                >
                  +
                </button>
              </div>
              <div className="chat-scroll">
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
                      Configure workspace + AI in Settings. Asks run through the
                      real agent/tool host (Tauri or cd-server), not a demo
                      shell.
                    </p>
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => openSettings("preflight")}
                    >
                      Open Preflight
                    </button>
                  </div>
                ) : (
                  visibleMessages.map((m) => (
                    <article key={m.id} className="msg" data-role={m.role}>
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
                        <div>
                          {m.citations.map((c) => (
                            <button
                              key={c.id + c.label}
                              type="button"
                              className="citation-chip"
                              onClick={() => {
                                setSourcePath(c.id);
                                setPane("source");
                                setSourceContent("Loading…");
                                void hostReadFile(c.id)
                                  .then((body) => setSourceContent(body))
                                  .catch((err) =>
                                    setSourceContent(
                                      `Could not read ${c.id}:\n${
                                        err instanceof Error ? err.message : String(err)
                                      }`,
                                    ),
                                  );
                              }}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <div className="msg__bubble">
                        {m.role === "assistant" ? (
                          <div
                            className="msg__content"
                            data-streaming={m.streaming ? "true" : "false"}
                            onClick={(e) => {
                              const t = e.target as HTMLElement;
                              const cite = t.getAttribute("data-cite");
                              if (!cite) return;
                              setSourcePath(cite);
                              setPane("source");
                              setSourceContent("Loading…");
                              void hostReadFile(cite)
                                .then((body) => setSourceContent(body))
                                .catch((err) =>
                                  setSourceContent(
                                    `Could not read ${cite}:\n${
                                      err instanceof Error ? err.message : String(err)
                                    }`,
                                  ),
                                );
                            }}
                          >
                            <MarkdownBody
                              text={m.content}
                              streaming={m.streaming}
                            />
                          </div>
                        ) : (
                          <div
                            className="msg__content"
                            data-streaming={m.streaming ? "true" : "false"}
                          >
                            {m.content}
                          </div>
                        )}
                      </div>
                    </article>
                  ))
                )}
              </div>
              <div className="composer-dock">
                <Composer
                  onSubmit={onSubmit}
                  disabled={busy}
                  busy={busy}
                  onStop={() => {
                    setBusy(false);
                    setAgentError("Turn stopped (cooperative cancel).");
                  }}
                />
              </div>
            </>
          ) : null}

          {pane === "memory" ? (
            <MemoryPane
              docs={memoryDocs}
              activePath={memoryPath}
              onSelect={setMemoryPath}
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
          ) : null}

          {pane === "source" ? (
            <SourcePreviewPane path={sourcePath} content={sourceContent} />
          ) : null}

          {pane === "todos" ? (
            <TodoPane storageKey={`cd-todos-${sessionId}`} />
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
          {setup.chatModel ? (
            <>
              <span aria-hidden>·</span>
              <span className="mono" title="Chat model">
                {setup.chatModel}
              </span>
            </>
          ) : null}
        </span>
      </footer>
      </div>

      <SettingsModal
        open={settingsOpen}
        initialSection={settingsSection}
        setup={setup}
        theme={theme}
        onThemeChange={setTheme}
        onClose={closeSettings}
        onSaveSetup={onSaveSetup}
        onRecheckHost={refreshHostPreflight}
        hostReport={hostPreflightReport}
      />

      <PermissionModal prompt={permission} onRespond={onPermissionRespond} />
    </div>
  );
}
