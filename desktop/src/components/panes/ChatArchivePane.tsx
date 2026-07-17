import { useCallback, useEffect, useState } from "react";
import {
  hostArchiveChatSession,
  hostDeleteChatSession,
  hostPinChatSession,
  hostRestoreChatSession,
  hostSearchChatSessions,
  hostTrashChatSession,
  type SessionSearchHitDto,
} from "../../lib/host";

type Props = {
  /** Bump to force a refresh after external session changes. */
  refreshKey?: number;
  activeSessionId?: string;
  onOpenSession: (id: string) => void;
  onSessionsChanged?: () => void;
};

type Scope = "active" | "archived" | "trash";

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function ChatArchivePane({
  refreshKey = 0,
  activeSessionId,
  onOpenSession,
  onSessionsChanged,
}: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [hits, setHits] = useState<SessionSearchHitDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<Scope>("active");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await hostSearchChatSessions(debounced, {
        limit: 80,
        // Active: exclude archived+trashed. Archived: include archived (still exclude trash).
        includeArchived: scope === "archived",
        includeTrashed: false,
        onlyTrashed: scope === "trash",
      });
      const filtered =
        scope === "trash"
          ? next
          : scope === "archived"
            ? next.filter((h) => h.meta.archived && !h.meta.trashed)
            : next.filter((h) => !h.meta.archived && !h.meta.trashed);
      setHits(filtered);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, [debounced, scope]);

  useEffect(() => {
    void runSearch();
  }, [runSearch, refreshKey]);

  const mutate = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onSessionsChanged?.();
      await runSearch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="pane archive-pane">
      <div className="pane__header archive-pane__header">
        <div>
          <div>Chat archive</div>
          <p className="field__hint archive-pane__lead">
            Search saved conversations. Pin to the sidebar. Delete moves to
            Trash first — permanent remove only from Trash.
          </p>
        </div>
      </div>

      <div className="archive-scope" role="tablist" aria-label="Archive scope">
        {(
          [
            ["active", "Chats"],
            ["archived", "Archived"],
            ["trash", "Trash"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="archive-scope__tab"
            data-active={scope === id ? "true" : "false"}
            onClick={() => setScope(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="archive-search">
        <input
          className="field__control archive-search__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            scope === "trash"
              ? "Search trash…"
              : "Search titles and messages…"
          }
          aria-label="Search chat archive"
          autoFocus
        />
      </div>

      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="field__hint">Searching…</p>
      ) : hits.length === 0 ? (
        <div className="empty-state archive-pane__empty">
          <div className="empty-state__title">
            {debounced
              ? "No matches"
              : scope === "trash"
                ? "Trash is empty"
                : scope === "archived"
                  ? "No archived chats"
                  : "No chats yet"}
          </div>
          <p className="empty-state__body">
            {debounced
              ? "Try different keywords, or clear the search."
              : scope === "trash"
                ? "Chats you move to Trash show up here for recovery."
                : "Send a message in Chat — conversations auto-save here."}
          </p>
        </div>
      ) : (
        <ul className="archive-list">
          {hits.map((hit) => {
            const m = hit.meta;
            const active = m.id === activeSessionId;
            const trashed = Boolean(m.trashed);
            return (
              <li
                key={m.id}
                className="archive-row"
                data-active={active ? "true" : undefined}
                data-archived={m.archived ? "true" : undefined}
                data-trashed={trashed ? "true" : undefined}
              >
                <button
                  type="button"
                  className="archive-row__main"
                  onClick={() => {
                    if (trashed) {
                      setError(
                        "Restore this chat from Trash before opening it.",
                      );
                      return;
                    }
                    onOpenSession(m.id);
                  }}
                >
                  <span className="archive-row__title">
                    {m.pinned ? (
                      <span className="archive-row__pin" title="Pinned" aria-hidden>
                        📌
                      </span>
                    ) : null}
                    {m.title}
                    {m.archived && !trashed ? (
                      <span className="archive-row__badge">archived</span>
                    ) : null}
                    {trashed ? (
                      <span className="archive-row__badge archive-row__badge--trash">
                        trash
                      </span>
                    ) : null}
                  </span>
                  <span className="archive-row__snippet">
                    {hit.snippet || m.preview || "—"}
                  </span>
                  <span className="archive-row__meta">
                    {m.message_count} msg ·{" "}
                    {formatWhen(m.trashed_at || m.updated_at)}
                    {debounced && hit.score > 0
                      ? ` · score ${hit.score.toFixed(1)}`
                      : ""}
                  </span>
                </button>
                <div className="archive-row__actions">
                  {trashed ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          void mutate(() => hostRestoreChatSession(m.id))
                        }
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Permanently delete “${m.title}”?\n\nThis cannot be undone.`,
                            )
                          ) {
                            return;
                          }
                          void mutate(() => hostDeleteChatSession(m.id));
                        }}
                      >
                        Delete forever
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title={m.pinned ? "Unpin from sidebar" : "Pin to sidebar"}
                        onClick={() =>
                          void mutate(() => hostPinChatSession(m.id, !m.pinned))
                        }
                      >
                        {m.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() =>
                          void mutate(() =>
                            hostArchiveChatSession(m.id, !m.archived),
                          )
                        }
                      >
                        {m.archived ? "Unarchive" : "Archive"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Move “${m.title}” to Trash?\n\nYou can restore it later from the Trash tab.`,
                            )
                          ) {
                            return;
                          }
                          void mutate(() => hostTrashChatSession(m.id));
                        }}
                      >
                        Trash
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
