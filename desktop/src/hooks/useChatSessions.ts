/**
 * Session store hook — load/persist/rename/trash/pin (#146).
 * Owns `sessions` / `activeSessionId` previously inline in App.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

export function shouldPersistUiSession(session: ChatSession): boolean {
  return (
    !session.trashed &&
    (session.messages.length > 0 || Boolean(session.linkedCorpusId))
  );
}

/** Where the last-read conversation is remembered between launches. */
export const ACTIVE_SESSION_KEY = "cd-active-session";

/**
 * A chat carrying nothing the user would miss. Only such a chat may be reused
 * by "New chat" — a blank chat that was renamed, pinned, given a model or a
 * skill, or that holds unsent composer text, is *not* interchangeable with a
 * fresh one, and reusing it would silently hand the user someone else's
 * settings or resurrect a draft they had abandoned.
 */
export function isPristineBlank(
  session: ChatSession,
  hasUnsentDraft: boolean,
): boolean {
  return (
    session.messages.length === 0 &&
    !session.linkedCorpusId &&
    !session.titleLocked &&
    !session.pinned &&
    !session.chatModel &&
    !session.providerProfileId &&
    !session.pinnedSkillId &&
    !hasUnsentDraft &&
    /^Chat \d+$/.test(session.title.trim())
  );
}

/**
 * Next default title. Counting sessions produced repeats — create "Chat 2",
 * trash "Chat 1", create again and you had two "Chat 2"s — so number past the
 * highest one already used instead.
 */
export function nextChatTitle(existing: readonly ChatSession[]): string {
  let highest = 0;
  for (const s of existing) {
    const m = /^Chat (\d+)$/.exec(s.title.trim());
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return `Chat ${Math.max(highest + 1, existing.length + 1)}`;
}

function readStoredActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Choose the conversation to open on launch: the one the user was last
 * reading, but only while it is still present and open. A stored id for a
 * chat that has since been archived, trashed, or deleted must not win —
 * falling through to the newest chat is the honest outcome.
 */
export function pickRestoredSession(
  loaded: readonly ChatSession[],
  storedId: string | null,
): string | null {
  if (loaded.length === 0) return null;
  const stored =
    storedId &&
    loaded.find((s) => s.id === storedId && !s.archived && !s.trashed);
  return stored ? stored.id : loaded[0]!.id;
}

/**
 * Publish open host sessions without erasing a conversation created locally
 * while hydration/sync was in flight. A local id known to the host but now
 * absent from `loaded` was archived/trashed and must not be resurrected.
 */
export function reconcileOpenSessions(
  local: readonly ChatSession[],
  loaded: readonly ChatSession[],
  knownHostIds: ReadonlySet<string>,
  hasDraft?: (sessionId: string) => boolean,
): ChatSession[] {
  const loadedIds = new Set(loaded.map((session) => session.id));
  const retainedLocal = local.filter(
    (session) =>
      !loadedIds.has(session.id) &&
      !knownHostIds.has(session.id) &&
      !isPristineBlank(session, hasDraft?.(session.id) ?? false),
  );
  return [...retainedLocal, ...loaded];
}

export type UseChatSessionsArgs = {
  /** Whether a conversation holds unsent composer text (drafts live in App). */
  hasDraft?: (sessionId: string) => boolean;
};

export function useChatSessions({ hasDraft }: UseChatSessionsArgs = {}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const persistGenerationRef = useRef(new Map<string, number>());
  const syncGenerationRef = useRef(0);
  const hasDraftRef = useRef(hasDraft);
  hasDraftRef.current = hasDraft;

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
    if (!shouldPersistUiSession(s)) {
      return s;
    }
    let next = { ...s, updatedAt: nowIso() };
    if (!next.titleLocked && isPlaceholderTitle(next.title)) {
      const firstUser = next.messages.find((m) => m.role === "user");
      if (firstUser) {
        const auto = titleFromPrompt(firstUser.content);
        if (auto) next = { ...next, title: auto };
      }
    }
    const generation = (persistGenerationRef.current.get(s.id) ?? 0) + 1;
    persistGenerationRef.current.set(s.id, generation);
    const isLatest = () => persistGenerationRef.current.get(s.id) === generation;
    let saved: ChatSessionDto | null;
    try {
      saved = await hostSaveChatSession(
        sessionToDto(next),
        s.hostRevision ?? null,
      );
      if (saved) {
        const materialized = sessionFromDto(saved);
        if (isLatest()) {
          setSessions((all) =>
            all.map((current) =>
              current.id === s.id && current.updatedAt === s.updatedAt
                ? materialized
                : current,
            ),
          );
        }
        return materialized;
      }
    } catch (error) {
      // Only the newest still-relevant local mutation may reconcile after a
      // compare-and-swap conflict. An older completion must not retry over a
      // later title, model, permission result, or turn.
      if (isLatest() && String(error).includes("chat_session_conflict")) {
        try {
          const currentDto = await hostLoadChatSession(s.id);
          if (currentDto && isLatest()) {
            const current = sessionFromDto(currentDto);
            const pendingById = new Map(next.messages.map((m) => [m.id, m]));
            const currentIds = new Set(current.messages.map((m) => m.id));
            const merged: ChatSession = {
              ...next,
              messages: [
                ...current.messages.map((m) => pendingById.get(m.id) ?? m),
                ...next.messages.filter((m) => !currentIds.has(m.id)),
              ],
              createdAt: current.createdAt,
              archived: current.archived,
              trashed: current.trashed,
              trashedAt: current.trashedAt,
              linkedCorpusId: current.linkedCorpusId,
              hostRevision: current.hostRevision,
            };
            saved = await hostSaveChatSession(
              sessionToDto(merged),
              current.hostRevision ?? null,
            );
            if (saved) {
              const materialized = sessionFromDto(saved);
              if (isLatest()) {
                setSessions((all) =>
                  all.map((local) =>
                    local.id === s.id && local.updatedAt === s.updatedAt
                      ? materialized
                      : local,
                  ),
                );
              }
              return materialized;
            }
          }
        } catch {
          /* a second winner remains authoritative; leave newer UI untouched */
        }
      }
      /* browser / host unavailable, or stale mutation superseded locally */
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
              void hostSaveChatSession(
                sessionToDto(updated),
                s.hostRevision ?? null,
              ).catch(() => {});
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
        const knownHostIds = new Set(metas.map((meta) => meta.id));
        const loaded: ChatSession[] = [];
        for (const meta of metas) {
          if (meta.archived || meta.trashed) continue;
          try {
            const full = await hostLoadChatSession(meta.id);
            if (full && !full.archived && !full.trashed) {
              loaded.push(sessionFromDto(full));
            }
          } catch {
            /* skip broken */
          }
        }
        if (cancelled) return;
        setSessions((local) => {
          let merged = reconcileOpenSessions(
            local,
            loaded,
            knownHostIds,
            hasDraftRef.current,
          );
          if (merged.length === 0) merged = [newSession("Chat 1", null)];
          setActiveSessionId((current) =>
            current && merged.some((session) => session.id === current)
              ? current
              : pickRestoredSession(merged, readStoredActiveSessionId()),
          );
          return merged;
        });
      } catch {
        if (!cancelled) {
          setSessions((local) => {
            if (local.length > 0) return local;
            const s = newSession("Chat 1", null);
            setActiveSessionId(s.id);
            return [s];
          });
        }
      } finally {
        if (!cancelled) setSessionsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Remember what the user was reading so the next launch reopens it.
  useEffect(() => {
    if (!sessionsReady || !resolvedSessionId) return;
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, resolvedSessionId);
    } catch {
      /* storage unavailable — restoration is a convenience, not a guarantee */
    }
  }, [sessionsReady, resolvedSessionId]);

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

  const createSession = useCallback((): ChatSession => {
    const open = sessions.filter((s) => !s.archived && !s.trashed);
    // "New chat" while a *pristine* blank chat is already open should take the
    // user there rather than stacking another indistinguishable "Chat N".
    // Blank chats are never persisted, so the extras only ever existed in the
    // sidebar until the next reload.
    const blank = open.find((s) => isPristineBlank(s, hasDraft?.(s.id) ?? false));
    if (blank) {
      setActiveSessionId(blank.id);
      return blank;
    }
    const s = newSession(nextChatTitle(sessions), null);
    setSessions((all) => [s, ...all]);
    setActiveSessionId(s.id);
    return s;
  }, [sessions, hasDraft]);

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

  const renameSessionById = useCallback(
    async (id: string) => {
      const cur = sessions.find((s) => s.id === id);
      if (!cur) return null;
      return cur;
    },
    [sessions],
  );

  const applyRename = useCallback(async (id: string, title: string) => {
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
  }, []);

  const togglePinById = useCallback(
    async (id: string) => {
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
    },
    [sessions],
  );

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
    const generation = (syncGenerationRef.current += 1);
    try {
      const metas = await hostListChatSessions();
      if (syncGenerationRef.current !== generation) return;
      const knownHostIds = new Set(metas.map((meta) => meta.id));
      const loaded: ChatSession[] = [];
      for (const meta of metas) {
        if (meta.archived || meta.trashed) continue;
        try {
          const full = await hostLoadChatSession(meta.id);
          if (syncGenerationRef.current !== generation) return;
          if (full && !full.archived && !full.trashed) {
            loaded.push(sessionFromDto(full));
          }
        } catch {
          /* skip */
        }
      }
      if (syncGenerationRef.current !== generation) return;
      setSessions((local) => {
        let merged = reconcileOpenSessions(
          local,
          loaded,
          knownHostIds,
          hasDraftRef.current,
        );
        if (merged.length === 0) merged = [newSession("Chat 1", null)];
        setActiveSessionId((current) =>
          current && merged.some((session) => session.id === current)
            ? current
            : merged[0]!.id,
        );
        return merged;
      });
    } catch {
      /* ignore */
    }
  }, []);

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
