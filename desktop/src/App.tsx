import { useCallback, useEffect, useState } from "react";
import { Composer } from "./components/Composer";
import { ToolCallList, type ToolCallView } from "./components/ToolCallList";
import { IconMoon, IconSpark, IconSun } from "./components/icons";

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

export function App() {
  const [theme, setTheme] = useState<"dark" | "light">(loadTheme);
  const [messages, setMessages] = useState<Msg[]>([]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cd-theme", theme);
  }, [theme]);

  const onSubmit = useCallback((text: string) => {
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
      {
        id: "t2",
        name: "read_file_slice",
        summary: "docs/ARCHITECTURE.md:1-40",
        detail: "(demo shell — agent loop not wired yet)",
        ok: true,
      },
    ];
    const assistant: Msg = {
      id: crypto.randomUUID(),
      role: "assistant",
      streaming: true,
      tools: demoTools,
      content:
        "This is the **desktop shell** scaffold.\n\n" +
        "The agent loop, providers, and real tools will stream here via `cd.v1` events.\n\n" +
        "- Compact tool rows expand for detail\n" +
        "- Composer supports Expand for longer prompts\n" +
        "- Theme: dark by default\n",
    };
    setMessages((m) => [...m, user, assistant]);
    window.setTimeout(() => {
      setMessages((m) =>
        m.map((x) =>
          x.id === assistant.id ? { ...x, streaming: false } : x,
        ),
      );
    }, 400);
  }, []);

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="titlebar__brand">
          <IconSpark title={PRODUCT_NAME} />
          <span>{PRODUCT_NAME}</span>
          <span className="titlebar__meta">preview shell</span>
        </div>
        <div className="titlebar__actions">
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
      <div className="main">
        <aside className="sidebar">
          <div className="sidebar__label">Sessions</div>
          <ul className="session-list">
            <li>
              <button type="button" className="session-list__item" data-active="true">
                Research
              </button>
            </li>
          </ul>
        </aside>
        <div className="workspace">
          <div className="chat-scroll">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__title">{PRODUCT_NAME}</div>
                <p className="empty-state__body">{TAGLINE}</p>
                <p className="empty-state__body">
                  Point at a workspace, connect a model, and ask how the system
                  works. Citations and tools will appear here.
                </p>
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
    </div>
  );
}
