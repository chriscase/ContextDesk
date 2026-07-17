import { useCallback, useEffect, useState } from "react";
import {
  hostArchiveChatSession,
  hostDeleteChatSession,
  hostPinChatSession,
  hostSearchChatSessions,
  type SessionSearchHitDto,
} from "../../lib/host";

type Props = {
  /** Bump to force a refresh after external session changes. */
  refreshKey?: number;
  activeSessionId?: string;
  onOpenSession: (id: string) => void;
  onSessionsChanged?: () => void;
};

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
  const [includeArchived, setIncludeArchived] = useState(false);
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
        includeArchived,
      });
      setHits(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHits([]);
    } finally {
      setLoading(false);
    }
  }, [debounced, includeArchived]);

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
            Search every saved conversation. Pin chats you want on the sidebar.
          </p>
        </div>
      </div>

      <div className="archive-search">
        <input
          className="field__control archive-search__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles and messages…"
          aria-label="Search chat archive"
          autoFocus
        />
        <label className="archive-search__toggle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Include archived
        </label>
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
            {debounced ? "No matches" : "No chats yet"}
          </div>
          <p className="empty-state__body">
            {debounced
              ? "Try different keywords, or clear the search."
              : "Send a message in Chat — conversations auto-save here."}
          </p>
        </div>
      ) : (
        <ul className="archive-list">
          {hits.map((hit) => {
            const m = hit.meta;
            const active = m.id === activeSessionId;
            return (
              <li
                key={m.id}
                className="archive-row"
                data-active={active ? "true" : undefined}
                data-archived={m.archived ? "true" : undefined}
              >
                <button
                  type="button"
                  className="archive-row__main"
                  onClick={() => onOpenSession(m.id)}
                >
                  <span className="archive-row__title">
                    {m.pinned ? (
                      <span className="archive-row__pin" title="Pinned" aria-hidden>
                        📌
                      </span>
                    ) : null}
                    {m.title}
                    {m.archived ? (
                      <span className="archive-row__badge">archived</span>
                    ) : null}
                  </span>
                  <span className="archive-row__snippet">
                    {hit.snippet || m.preview || "—"}
                  </span>
                  <span className="archive-row__meta">
                    {m.message_count} msg · {formatWhen(m.updated_at)}
                    {debounced && hit.score > 0
                      ? ` · score ${hit.score.toFixed(1)}`
                      : ""}
                  </span>
                </button>
                <div className="archive-row__actions">
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
                    {m.archived ? "Restore" : "Archive"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Delete “${m.title}” permanently? This cannot be undone.`,
                        )
                      ) {
                        return;
                      }
                      void mutate(() => hostDeleteChatSession(m.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
