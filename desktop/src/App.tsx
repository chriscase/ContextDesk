import { useCallback, useEffect, useMemo, useState } from "react";
import { Composer } from "./components/Composer";
import {
  SettingsModal,
  type SettingsSection,
} from "./components/SettingsModal";
import { ToolCallList, type ToolCallView } from "./components/ToolCallList";
import { IconMoon, IconSettings, IconSpark, IconSun } from "./components/icons";
import {
  runClientPreflight,
  type AppSetupState,
} from "./lib/preflight";

const PRODUCT_NAME = "ContextDesk";
const TAGLINE =
  "Developer knowledge workbench — find, synthesize, remember.";

type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools?: ToolCallView[];
  streaming?: boolean;
};

function loadTheme(): "dark" | "light" {
  const t = localStorage.getItem("cd-theme");
  return t === "light" ? "light" : "dark";
}

function loadSetup(): AppSetupState {
  try {
    const raw = localStorage.getItem("cd-setup");
    if (raw) return JSON.parse(raw) as AppSetupState;
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

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cd-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("cd-setup", JSON.stringify(setup));
  }, [setup]);

  const preflight = useMemo(() => runClientPreflight(setup), [setup]);

  useEffect(() => {
    // First-run: open preflight when blocking issues exist.
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
    (text: string) => {
      if (preflight.hasBlocking) {
        openSettings("preflight");
        return;
      }
      const user: Msg = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      };
      const demoTools: ToolCallView[] = [
        {
          id: "t1",
          name: "search_kb",
          summary: `query: ${text.slice(0, 48)}…`,
          detail: JSON.stringify({ query: text, limit: 8 }, null, 2),
          ok: true,
        },
      ];
      const assistant: Msg = {
        id: crypto.randomUUID(),
        role: "assistant",
        streaming: true,
        tools: demoTools,
        content:
          "Shell demo reply. Wire the agent loop next — configuration already flows through **Settings** and **Preflight**, not hand-edited config files.\n",
      };
      setMessages((m) => [...m, user, assistant]);
      window.setTimeout(() => {
        setMessages((m) =>
          m.map((x) =>
            x.id === assistant.id ? { ...x, streaming: false } : x,
          ),
        );
      }, 400);
    },
    [preflight.hasBlocking],
  );

  const scopeLabel =
    setup.workspaceRoots.length > 0
      ? `${setup.workspaceRoots.length} root${setup.workspaceRoots.length === 1 ? "" : "s"}`
      : "No workspace";

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
          <div className="chat-scroll">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__title">{PRODUCT_NAME}</div>
                <p className="empty-state__body">{TAGLINE}</p>
                <p className="empty-state__body">
                  Use <strong>Settings</strong> for workspace folders and AI
                  providers. Preflight shows what is healthy before you chat.
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
            <Composer onSubmit={onSubmit} />
          </div>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        initialSection={settingsSection}
        setup={setup}
        theme={theme}
        onThemeChange={setTheme}
        onClose={() => setSettingsOpen(false)}
        onSaveSetup={setSetup}
      />
    </div>
  );
}
