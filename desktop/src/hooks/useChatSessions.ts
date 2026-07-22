/**
 * Session store hook — load/persist/rename/trash/pin (#146).
 * Owns `sessions` / `activeSessionId` previously inline in App.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { dialogConfirm } from "../lib/dialogs";
import {
  hostListChatSessions,
  hostLoadChatSession,
  hostPinChatSession,
  hostRenameChatSession,
  hostSaveChatSession,
  hostSuggestChatTitle,
  hostTrashChatSession,
  type ChatSessionDto,
} from "../lib/host";
import {
  isPlaceholderTitle,
  newSession,
  nowIso,
  sessionFromDto,
  sessionToDto,
  titleFromPrompt,
  type ChatSession,
  type Msg,
} from "../lib/session";

export function useChatSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const resolvedSessionId = activeSessionId ?? sessions[0]?.id ?? "";
  const activeSession =
    sessions.find((s) => s.id === resolvedSessionId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const sessionId = activeSession?.id ?? "";

  const setMessages = useCallback(
    (updater: Msg[] | ((prev: Msg[]) => Msg[])) => {
      const sid = resolvedSessionId;
      setSessions((all) =>
        all.map((s) => {
          if (s.id !== sid) return s;
          const next =
            typeof updater === "function" ? updater(s.messages) : updater;
          return { ...s, messages: next, updatedAt: nowIso() };
        }),
      );
    },
    [resolvedSessionId],
  );

  const persistSession = useCallback(async (s: ChatSession) => {
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
      /* browser / host unavailable */
    }
    return next;
  }, []);

  const upgradeTitleWithLlm = useCallback(
    async (sid: string, prompt: string) => {
      try {
        const suggested = await hostSuggestChatTitle(prompt);
        if (!suggested?.trim()) return;
        setSessions((all) =>
          all.map((s) => {
            if (s.id !== sid || s.titleLocked) return s;
            const updated = {
              ...s,
              title: suggested.trim(),
              updatedAt: nowIso(),
            };
            if (updated.messages.length > 0) {
              void hostSaveChatSession(sessionToDto(updated)).catch(() => {});
            }
            return updated;
          }),
        );
      } catch {
        /* keep heuristic */
      }
    },
    [],
  );

  // Hydrate on launch
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
          try {
            const full = await hostLoadChatSession(meta.id);
            if (full && !full.trashed) loaded.push(sessionFromDto(full));
          } catch {
            /* skip broken */
          }
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

  const openChatSessions = useMemo(
    () =>
      sessions
        .filter((s) => !s.archived && !s.trashed)
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.updatedAt.localeCompare(a.updatedAt);
        }),
    [sessions],
  );

  const createSession = useCallback(() => {
    const s = newSession(`Chat ${sessions.length + 1}`, null);
    setSessions((all) => [s, ...all]);
    setActiveSessionId(s.id);
    return s;
  }, [sessions.length]);

  /**
   * Guarantee a non-trashed active chat exists (first send / model pick before
   * hydrate, or after the last open chat was trashed). Returns the session to
   * use for the current action.
   */
  const ensureActiveSession = useCallback((): ChatSession => {
    const open = sessions.filter((s) => !s.archived && !s.trashed);
    const current =
      (activeSessionId
        ? open.find((s) => s.id === activeSessionId)
        : undefined) ?? open[0];
    if (current) {
      if (activeSessionId !== current.id) {
        setActiveSessionId(current.id);
      }
      return current;
    }
    const s = newSession(
      sessions.length === 0 ? "Chat 1" : `Chat ${sessions.length + 1}`,
      null,
    );
    setSessions((all) => [s, ...all.filter((x) => x.id !== s.id)]);
    setActiveSessionId(s.id);
    return s;
  }, [sessions, activeSessionId]);

  // After trash / host sync leaves zero open chats, seed one so the composer works.
  useEffect(() => {
    if (!sessionsReady) return;
    const open = sessions.filter((s) => !s.archived && !s.trashed);
    if (open.length > 0) return;
    const s = newSession("Chat 1", null);
    setSessions([s]);
    setActiveSessionId(s.id);
  }, [sessionsReady, sessions]);

  const renameSessionById = useCallback(async (id: string) => {
    const cur = sessions.find((s) => s.id === id);
    if (!cur) return null;
    return cur;
  }, [sessions]);

  const applyRename = useCallback(
    async (id: string, title: string) => {
      const t = title.trim();
      if (!t) return;
      try {
        await hostRenameChatSession(id, t);
      } catch {
        /* local */
      }
      setSessions((all) =>
        all.map((s) =>
          s.id === id
            ? { ...s, title: t, titleLocked: true, updatedAt: nowIso() }
            : s,
        ),
      );
    },
    [],
  );

  const togglePinById = useCallback(async (id: string) => {
    const cur = sessions.find((s) => s.id === id);
    if (!cur) return;
    const next = !cur.pinned;
    try {
      await hostPinChatSession(id, next);
    } catch {
      /* local */
    }
    setSessions((all) =>
      all.map((s) =>
        s.id === id ? { ...s, pinned: next, updatedAt: nowIso() } : s,
      ),
    );
  }, [sessions]);

  const trashSessionById = useCallback(
    async (id: string) => {
      const cur = sessions.find((s) => s.id === id);
      if (!cur) return;
      const ok = await dialogConfirm(
        `Move “${cur.title}” to Trash?\n\nYou can restore it later from Archive.`,
        { title: "Move to Trash", kind: "warning" },
      );
      if (!ok) return;
      try {
        await hostTrashChatSession(id);
      } catch {
        /* local */
      }
      setSessions((all) => {
        const next = all.filter((s) => s.id !== id);
        if (activeSessionId === id) {
          if (next.length === 0) {
            // Keep composer usable — open a fresh empty chat.
            const fresh = newSession("Chat 1", null);
            setActiveSessionId(fresh.id);
            return [fresh];
          }
          setActiveSessionId(next[0]!.id);
        }
        return next;
      });
    },
    [sessions, activeSessionId],
  );

  const openSessionById = useCallback(async (id: string) => {
    try {
      const full = await hostLoadChatSession(id);
      if (full) {
        const s = sessionFromDto(full);
        setSessions((all) => {
          const i = all.findIndex((x) => x.id === id);
          if (i >= 0) {
            const copy = [...all];
            copy[i] = s;
            return copy;
          }
          return [s, ...all];
        });
        setActiveSessionId(id);
        return;
      }
    } catch {
      /* fall through */
    }
    setActiveSessionId(id);
  }, []);

  const setShowFullHistory = useCallback(
    (show: boolean) => {
      setSessions((all) =>
        all.map((s) =>
          s.id === resolvedSessionId ? { ...s, showFullHistory: show } : s,
        ),
      );
    },
    [resolvedSessionId],
  );

  const setSessionModel = useCallback(
    (selectionKey: string, providerId: string | null, modelId: string) => {
      setSessions((all) =>
        all.map((s) =>
          s.id === resolvedSessionId
            ? {
                ...s,
                chatModel: modelId,
                providerProfileId: providerId,
                updatedAt: nowIso(),
              }
            : s,
        ),
      );
      void (async () => {
        const cur = sessions.find((s) => s.id === resolvedSessionId);
        if (!cur) return;
        const updated = {
          ...cur,
          chatModel: modelId,
          providerProfileId: providerId,
          updatedAt: nowIso(),
        };
        await persistSession(updated);
      })();
      void selectionKey;
    },
    [resolvedSessionId, sessions, persistSession],
  );

  const syncSessionsFromHost = useCallback(async () => {
    try {
      const metas = await hostListChatSessions();
      const loaded: ChatSession[] = [];
      for (const meta of metas) {
        if (meta.trashed) continue;
        try {
          const full = await hostLoadChatSession(meta.id);
          if (full) loaded.push(sessionFromDto(full));
        } catch {
          /* skip */
        }
      }
      if (loaded.length) {
        setSessions(loaded);
        if (!loaded.some((s) => s.id === activeSessionId)) {
          setActiveSessionId(loaded[0].id);
        }
      }
    } catch {
      /* ignore */
    }
  }, [activeSessionId]);

  /** Patch a session from a full DTO (e.g. after host save). */
  const replaceSession = useCallback((dto: ChatSessionDto) => {
    const s = sessionFromDto(dto);
    setSessions((all) => all.map((x) => (x.id === s.id ? s : x)));
  }, []);

  return {
    sessions,
    setSessions,
    sessionsReady,
    activeSessionId,
    setActiveSessionId,
    resolvedSessionId,
    activeSession,
    messages,
    setMessages,
    sessionId,
    openChatSessions,
    persistSession,
    upgradeTitleWithLlm,
    createSession,
    ensureActiveSession,
    renameSessionById,
    applyRename,
    togglePinById,
    trashSessionById,
    openSessionById,
    setShowFullHistory,
    setSessionModel,
    syncSessionsFromHost,
    replaceSession,
  };
}
