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
  hostGetBranding,
  hostGetConfig,
  hostListMemory,
  hostPreflight,
  hostReadFile,
  hostSetWorkspace,
  hostWriteMemory,
  type BrandingDto,
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
    /** Compacted older turns (full messages retained in messages). */
    compactSummary: string | null;
    compactKeepLast: number;
  };

  const newSession = (title = "Chat"): ChatSession => ({
    id: crypto.randomUUID(),
    title,
    messages: [],
    compactSummary: null,
    compactKeepLast: 12,
  });

  const [theme, setTheme] = useState<"dark" | "light">(loadTheme);
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    return [newSession("Chat 1")];
  });
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
        return { ...s, messages: next };
      }),
    );
  };
  const sessionId = activeSession?.id ?? "";
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
      setMessages((m) => [...m, user, assistant]);
      setPane("chat");

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

        // Tools, citations, trail, permissions (once).
        setMessages((m) => {
          const idx = m.findIndex((x) => x.id === assistantId);
          if (idx < 0) return m;
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
            // Prefer structured arguments from host (not human preview text).
            const prev = events.find((e) => e.kind === "permission_required");
            const args = prev?.payload?.arguments;
            if (args && typeof args === "object" && !Array.isArray(args)) {
              setPendingToolArgs(args as Record<string, unknown>);
            } else {
              // Host re-executes with stored args when client sends {}.
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
          const next = [...m];
          next[idx] = merged;
          return next;
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        setAgentError(err);
        setMessages((m) =>
          m.map((x) =>
            x.id === assistantId
              ? {
                  ...x,
                  streaming: false,
                  content: `**Host error:** ${err}`,
                }
              : x,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [
      preflight.hasBlocking,
      sessionId,
      setup.ollamaReachable,
      setup.providerKind,
      refreshMemory,
    ],
  );

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
          <div className="sidebar__label">Sessions</div>
          <ul className="session-list">
            <li>
              <button
                type="button"
                className="session-list__item"
                data-active="true"
              >
                Research
              </button>
            </li>
          </ul>
          <div className="sidebar__label">Setup</div>
          <button
            type="button"
            className="session-list__item"
            data-warn={preflight.hasBlocking ? "true" : undefined}
            onClick={() => openSettings("preflight")}
          >
            Preflight {preflight.hasBlocking ? "· issues" : "· ok"}
          </button>
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
                  className="btn btn--ghost"
                  title="New chat session"
                  onClick={() => {
                    const s = newSession(`Chat ${sessions.length + 1}`);
                    setSessions((all) => [...all, s]);
                    setActiveSessionId(s.id);
                  }}
                >
                  +
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  title="Compact older turns (full history kept)"
                  disabled={messages.length < 4}
                  onClick={() => {
                    setSessions((all) =>
                      all.map((s) => {
                        if (s.id !== resolvedSessionId) return s;
                        const keep = s.compactKeepLast;
                        if (s.messages.length <= keep) {
                          return { ...s, compactSummary: null };
                        }
                        const older = s.messages.slice(0, -keep);
                        const lines = older.map((m) => {
                          const snip = m.content.slice(0, 120);
                          return `- ${m.role}: ${snip}`;
                        });
                        return {
                          ...s,
                          compactSummary: lines.join("\n"),
                        };
                      }),
                    );
                  }}
                >
                  Compact
                </button>
              </div>
              <div className="chat-scroll">
                {activeSession?.compactSummary ? (
                  <details className="compact-banner">
                    <summary>
                      Earlier conversation compacted (expand full retained
                      history)
                    </summary>
                    <pre className="tool-row__detail">
                      {activeSession.compactSummary}
                    </pre>
                    <p className="field__hint">
                      Full messages remain in the session; only the model
                      context summary is compact.
                    </p>
                  </details>
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
                  messages.map((m) => (
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
