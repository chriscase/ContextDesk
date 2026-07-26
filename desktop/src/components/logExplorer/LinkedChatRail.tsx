/**
 * Compact corpus-linked chat rail for Log Explorer (#529, #530, #543).
 * Owns follow-latest scroll, multi-chat switcher, tool visibility, and
 * privacy-safe agent-context disclosure — not raw debug dumps.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  agentTurn,
  hostListChatSessionsForCorpus,
  hostLoadChatSession,
  hostSaveChatSession,
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
  extractLogNavFromText,
  type LogNavAction,
} from "../../lib/logExplorer/logNav";
import { ToolCallList } from "../ToolCallList";

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
};

type Props = {
  corpusId: string;
  corpusName: string;
  agentContext: AgentContextSummary;
  onApplyNav: (action: LogNavAction) => void;
  /** Narrow layout: keep rail usable without page overflow. */
  compactLayout?: boolean;
  /** When true, expose collapsed technical diagnostics (dev). */
  developerMode?: boolean;
};

const NEAR_BOTTOM_PX = 64;
const SWITCHER_SEARCH_THRESHOLD = 8;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

export function LinkedChatRail({
  corpusId,
  corpusName,
  agentContext,
  onApplyNav,
  compactLayout = false,
  developerMode = false,
}: Props) {
  const [chats, setChats] = useState<SessionMetaDto[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [navChips, setNavChips] = useState<LogNavAction[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [devJson, setDevJson] = useState("");
  /** Per-chat follow mode; default true for new chats. */
  const [followByChat, setFollowByChat] = useState<Record<string, boolean>>(
    {},
  );
  const [detachedByChat, setDetachedByChat] = useState<Record<string, boolean>>(
    {},
  );
  /** Per-chat drafts so switching chats does not lose unsent text. */
  const draftsRef = useRef<Record<string, string>>({});

  const threadRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  const followActive = activeChatId
    ? (followByChat[activeChatId] ?? true)
    : true;
  const showJump =
    Boolean(activeChatId) &&
    (detachedByChat[activeChatId!] || !followActive);

  const refreshChats = useCallback(async () => {
    try {
      const list = await hostListChatSessionsForCorpus(corpusId);
      setChats(list ?? []);
    } catch (e) {
      setError(String(e));
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
    if (!activeChatId || !followActive) return;
    // Instant on first paint / chat switch; smooth for streaming appends.
    const behavior: ScrollBehavior =
      messages.length <= 2 ? "auto" : "smooth";
    requestAnimationFrame(() => scrollToLatest(behavior));
  }, [messages, activeChatId, followActive, scrollToLatest, busy]);

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el || !activeChatId) return;
    const near = isNearBottom(el);
    setFollowByChat((m) => ({ ...m, [activeChatId]: near }));
    setDetachedByChat((m) => ({ ...m, [activeChatId]: !near }));
  };

  const jumpToLatest = () => {
    if (!activeChatId) return;
    setFollowByChat((m) => ({ ...m, [activeChatId]: true }));
    setDetachedByChat((m) => ({ ...m, [activeChatId]: false }));
    scrollToLatest("smooth");
  };

  const openChat = async (id: string) => {
    // Persist draft for the chat we leave.
    if (activeChatId) {
      draftsRef.current[activeChatId] = draft;
    }
    setActiveChatId(id);
    setSwitcherOpen(false);
    setError(null);
    setDraft(draftsRef.current[id] ?? "");
    // New selection starts followed at bottom (intentional, not leaked state).
    setFollowByChat((m) => ({ ...m, [id]: m[id] ?? true }));
    try {
      const full = await hostLoadChatSession(id);
      if (full) {
        const s = sessionFromDto(full);
        setMessages(
          s.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            tools: m.tools,
            citations: m.citations,
            trail: m.trail,
          })),
        );
      } else {
        setMessages([]);
      }
    } catch (e) {
      setError(String(e));
      setMessages([]);
    }
  };

  const createLinkedChat = async (): Promise<string | null> => {
    setError(null);
    try {
      const s = newSession(`Logs · ${corpusName || corpusId.slice(0, 8)}`);
      s.linkedCorpusId = corpusId;
      const saved = await hostSaveChatSession(sessionToDto(s));
      if (saved) {
        await refreshChats();
        await openChat(saved.id);
        setStatus(`Linked chat created: ${saved.title}`);
        setFollowByChat((m) => ({ ...m, [saved.id]: true }));
        setDetachedByChat((m) => ({ ...m, [saved.id]: false }));
        return saved.id;
      }
    } catch (e) {
      setError(String(e));
    }
    return null;
  };

  const sendChat = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    let sessionId = activeChatId;
    if (!sessionId) {
      sessionId = await createLinkedChat();
      if (!sessionId) return;
    }
    setBusy(true);
    setError(null);
    setDraft("");
    draftsRef.current[sessionId] = "";
    // Sending always re-engages follow for this chat (#529).
    setFollowByChat((m) => ({ ...m, [sessionId!]: true }));
    setDetachedByChat((m) => ({ ...m, [sessionId!]: false }));

    const userMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      userMsg,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);
    // Snap to the new user message immediately.
    requestAnimationFrame(() => scrollToLatest("auto"));

    try {
      const events = await agentTurn(
        sessionId,
        text,
        false,
        null,
        null,
        (ev) => {
          // Only update if still viewing this chat.
          if (activeChatIdRef.current !== sessionId) return;
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
              x.id === assistantId
                ? { ...folded, streaming: true }
                : x,
            );
          });
        },
        null,
        {
          corpus_id: corpusId,
          brief: agentContext.brief,
        },
      );

      const full = await hostLoadChatSession(sessionId);
      if (!full) {
        throw new Error("Linked chat could not be reloaded after the turn");
      }
      const session = sessionFromDto(full);
      const folded = applyEventsToMessage(
        { id: assistantId, role: "assistant", content: "", streaming: false },
        events,
      ).msg;
      const assistant: ChatMsg = {
        ...folded,
        streaming: false,
        content: folded.content,
      };
      const updated = {
        ...session,
        messages: [...session.messages, userMsg, assistant],
        lastReadMessageId: assistantId,
        updatedAt: nowIso(),
      };
      const saved = await hostSaveChatSession(sessionToDto(updated));
      if (!saved) {
        throw new Error("Linked chat turn was not persisted");
      }
      if (activeChatIdRef.current === sessionId) {
        const persisted = sessionFromDto(saved);
        setMessages(
          persisted.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            tools: m.tools,
            citations: m.citations,
            trail: m.trail,
          })),
        );
      }

      const found = extractLogNavFromText(assistant.content);
      if (found.length) {
        setNavChips((prev) => {
          const next = [...prev];
          for (const a of found) {
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
          return next;
        });
      }
      await refreshChats();
      const usedTools = (assistant.tools?.length ?? 0) > 0;
      setStatus(
        usedTools
          ? "Linked investigation completed with log tools"
          : "Linked chat response saved",
      );
    } catch (e) {
      setError(String(e));
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
      setBusy(false);
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

  const activeMeta = chats.find((c) => c.id === activeChatId);
  const activeTitle =
    activeMeta?.title ??
    (activeChatId ? "Linked chat" : "No chat selected");

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendChat();
    }
  };

  const applyDevJson = () => {
    const found = extractLogNavFromText(devJson);
    if (found.length) {
      setNavChips((prev) => [...prev, ...found]);
      setDevJson("");
      setStatus(`Parsed ${found.length} navigation proposal(s)`);
    } else {
      setError("No valid log_nav JSON found");
    }
  };

  return (
    <aside
      className={`log-explorer__chat log-explorer__chat--rail${
        compactLayout ? " log-explorer__chat--compact-layout" : ""
      }`}
      data-testid="log-explorer-chat"
    >
      <header className="log-explorer__chat-header" data-testid="linked-chat-header">
        <div className="log-explorer__chat-header-main">
          <div className="log-explorer__chat-header-title" title={activeTitle}>
            {activeTitle}
          </div>
          <div className="log-explorer__chat-header-meta">
            Linked · {chats.length} chat{chats.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="log-explorer__chat-header-actions">
          <button
            type="button"
            className="log-explorer__btn"
            data-testid="linked-chat-switcher-toggle"
            aria-expanded={switcherOpen}
            aria-controls="linked-chat-switcher"
            onClick={() => setSwitcherOpen((o) => !o)}
          >
            Chats
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

      {switcherOpen && (
        <div
          className="log-explorer__chat-switcher"
          id="linked-chat-switcher"
          data-testid="linked-chat-switcher"
          role="listbox"
          aria-label="Linked chats for this corpus"
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
                    role="option"
                    aria-selected={c.id === activeChatId}
                    className={`log-explorer__chat-item${
                      c.id === activeChatId
                        ? " log-explorer__chat-item--active"
                        : ""
                    }`}
                    onClick={() => void openChat(c.id)}
                  >
                    <div className="log-explorer__chat-item-title">{c.title}</div>
                    <div className="log-explorer__chat-preview">{c.preview}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
              agent receives a privacy-safe viewport snapshot and can run
              bounded log tools — not a full dump paste.
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`log-explorer__chat-bubble log-explorer__chat-bubble--${m.role}`}
                data-testid={`linked-chat-msg-${m.role}`}
              >
                <div className="log-explorer__chat-role">
                  {m.role}
                  {m.streaming ? " · streaming" : ""}
                </div>
                {m.tools && m.tools.length > 0 ? (
                  <ToolCallList tools={m.tools} collapseAfter={4} />
                ) : null}
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                {m.trail && m.trail.length > 0 && developerMode ? (
                  <div className="log-explorer__chat-trail" aria-label="Search trail">
                    {m.trail.join(" → ")}
                  </div>
                ) : null}
              </div>
            ))
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
            New messages · Jump to latest
          </button>
        )}
      </div>

      <div
        className="log-explorer__chat-composer"
        data-testid="log-explorer-chat-composer"
      >
        <textarea
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
        />
        <button
          type="button"
          className="log-explorer__btn log-explorer__btn--active"
          data-testid="send-linked-chat"
          disabled={busy || !draft.trim()}
          onClick={() => void sendChat()}
        >
          {busy ? "Investigating…" : "Send"}
        </button>
      </div>

      {navChips.length > 0 && (
        <div
          className="log-explorer__nav-chips"
          data-testid="linked-chat-nav-chips"
        >
          <div className="log-explorer__section-title">Suggested navigation</div>
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
            {agentContext.lanes.length
              ? agentContext.lanes.join("; ")
              : "none"}
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
          <li>
            <strong>Selected</strong> {agentContext.selectedCount} ·{" "}
            <strong>Bookmarks</strong> {agentContext.bookmarkCount}
          </li>
          <li className="log-explorer__chat-preview">
            Full corpus contents are queried through bounded tools, not dumped
            into chat context.
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

      {(error || status) && (
        <div className="log-explorer__chat-status" role="status">
          {error ? `Error: ${error}` : status}
        </div>
      )}
    </aside>
  );
}
