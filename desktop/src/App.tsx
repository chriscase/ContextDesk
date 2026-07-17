import { useCallback, useEffect, useMemo, useState } from "react";
import { Composer } from "./components/Composer";
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
  hostListMemory,
  hostPreflight,
  hostReadFile,
  hostSetWorkspace,
  hostWriteMemory,
  type EventDto,
} from "./lib/host";
import {
  runClientPreflight,
  type AppSetupState,
  type PreflightReport,
} from "./lib/preflight";

const PRODUCT_NAME = "ContextDesk";
const TAGLINE =
  "Developer knowledge workbench — find, synthesize, remember.";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolCallView[];
  citations?: { id: string; label: string }[];
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

  return {
    msg: {
      ...base,
      content,
      tools: tools.length ? tools : undefined,
      citations: citations.length ? citations : undefined,
      streaming: false,
    },
    permission,
  };
}

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">(loadTheme);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [setup, setSetup] = useState<AppSetupState>(loadSetup);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("preflight");
  const [dismissedBanner, setDismissedBanner] = useState(false);
  const [sessionId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [pendingToolArgs, setPendingToolArgs] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [pane, setPane] = useState<PaneId>("chat");
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

  useEffect(() => {
    if (preflight.hasBlocking && !localStorage.getItem("cd-setup-seen")) {
      setSettingsOpen(true);
      setSettingsSection("preflight");
      localStorage.setItem("cd-setup-seen", "1");
    }
  }, [preflight.hasBlocking]);

  const openSettings = (section: SettingsSection = "preflight") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

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
        setMessages((m) => {
          const idx = m.findIndex((x) => x.id === assistantId);
          if (idx < 0) return m;
          const { msg, permission: perm } = applyEventsToMessage(m[idx], events);
          if (perm) {
            setPermission(perm);
            try {
              const prev = events.find((e) => e.kind === "permission_required");
              if (prev?.payload?.preview) {
                const raw = String(prev.payload.preview);
                setPendingToolArgs(JSON.parse(raw) as Record<string, unknown>);
              }
            } catch {
              setPendingToolArgs({});
            }
          }
          const cite = msg.citations?.[0];
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
          // Refresh memory if save_memory tool ran
          if (msg.tools?.some((t) => t.name === "save_memory" && t.ok)) {
            void refreshMemory();
          }
          const next = [...m];
          next[idx] = msg;
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

  const onSaveSetup = async (next: AppSetupState) => {
    setSetup(next);
    if (next.workspaceName && next.workspaceRoots.length) {
      try {
        await hostSetWorkspace(next.workspaceName, next.workspaceRoots);
      } catch {
        /* browser mode */
      }
    }
    void refreshHostPreflight();
  };

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar__brand">
          <IconSpark title={PRODUCT_NAME} />
          <span>{PRODUCT_NAME}</span>
          <button
            type="button"
            className="chip"
            data-tone={setup.workspaceRoots.length ? "ok" : "warn"}
            onClick={() => openSettings("workspace")}
            title="Workspace scope"
          >
            {scopeLabel}
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
          <span>
            Setup incomplete — open Preflight to fix workspace or AI provider
            issues (no config files required).
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => openSettings("preflight")}
            >
              Open Preflight
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setDismissedBanner(true)}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      {agentError ? (
        <div className="banner" role="alert">
          <span>{agentError}</span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setAgentError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

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
            onClick={() => openSettings("preflight")}
          >
            Preflight {preflight.hasBlocking ? "• issues" : "• ok"}
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
              <div className="chat-scroll">
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state__title">{PRODUCT_NAME}</div>
                    <p className="empty-state__body">{TAGLINE}</p>
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
                        <div
                          className="msg__content"
                          data-streaming={m.streaming ? "true" : "false"}
                        >
                          {m.content}
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
              <div className="composer-dock">
                <Composer onSubmit={onSubmit} disabled={busy} />
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

      <SettingsModal
        open={settingsOpen}
        initialSection={settingsSection}
        setup={setup}
        theme={theme}
        onThemeChange={setTheme}
        onClose={() => setSettingsOpen(false)}
        onSaveSetup={onSaveSetup}
        onRecheckHost={refreshHostPreflight}
        hostReport={hostPreflightReport}
      />

      <PermissionModal prompt={permission} onRespond={onPermissionRespond} />
    </div>
  );
}
