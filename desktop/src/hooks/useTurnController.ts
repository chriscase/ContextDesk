/**
 * Turn/streaming controller (#146).
 * Owns busy, turnStartedAt, permission, pendingToolArgs, agentError, stopRef,
 * and the agentTurn event loop previously inline in App.tsx.
 */

import { useCallback, useRef, useState } from "react";
import type { PermissionPrompt } from "../components/PermissionModal";
import {
  agentTurn,
  completePermission,
  hostCancelTurn,
  hostReadFile,
  modelSelectionKey,
  type MessageMetaDto,
  type ModelOptionDto,
} from "../lib/host";
import type { AppSetupState } from "../lib/preflight";
import {
  applyEventsToMessage,
  isPlaceholderTitle,
  nowIso,
  snapshotMessageMeta,
  titleFromPrompt,
  type ChatSession,
  type Msg,
} from "../lib/session";
import {
  finalizeMessagesAfterStop,
  shouldProcessEventWhileStopped,
} from "../lib/turn";
import { classifyCompletedCitation } from "../lib/citations";
import { loadDeveloperActivityDetail } from "../lib/activity/prefs";

export { classifyCompletedCitation } from "../lib/citations";

type Args = {
  sessionId: string;
  resolvedSessionId: string;
  sessions: ChatSession[];
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  /** Create/activate a chat when none is open (first send, post-trash, pre-hydrate). */
  ensureActiveSession: () => ChatSession;
  setup: AppSetupState;
  modelOptions: ModelOptionDto[];
  defaultModelKey: string;
  preflightBlocking: boolean;
  onNeedPreflight: () => void;
  persistSession: (s: ChatSession) => Promise<ChatSession>;
  upgradeTitleWithLlm: (sessionId: string, prompt: string) => Promise<void>;
  pinScrollToEnd: (behavior?: ScrollBehavior) => void;
  refreshMemory: () => Promise<void>;
  refreshChatModels: (keepKeys?: readonly string[]) => Promise<void>;
  setSourcePath: (p: string | null) => void;
  setSourceContent: (c: string) => void;
  setPaneChat: () => void;
};

export function useTurnController(args: Args) {
  const {
    sessionId,
    sessions,
    setSessions,
    ensureActiveSession,
    setup,
    modelOptions,
    defaultModelKey,
    preflightBlocking,
    onNeedPreflight,
    persistSession,
    upgradeTitleWithLlm,
    pinScrollToEnd,
    refreshMemory,
    refreshChatModels,
    setSourcePath,
    setSourceContent,
    setPaneChat,
  } = args;

  const [busy, setBusy] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);
  const [pendingToolArgs, setPendingToolArgs] = useState<
    Record<string, unknown>
  >({});
  const [agentError, setAgentError] = useState<string | null>(null);
  /**
   * Monotonic id of the turn allowed to write to the transcript. Stopping, or
   * starting a replacement turn, bumps it — so a cancelled turn whose host
   * promise is still draining can never resume streaming into a later turn.
   */
  const turnTokenRef = useRef(0);
  /**
   * Session that owns the turn currently in flight. Stop, permission replies,
   * and failure reporting must target *this* chat, not whatever the user has
   * since switched to — otherwise a mid-turn chat switch cancels the wrong
   * session and leaves the real one streaming forever.
   */
  const activeTurnSessionRef = useRef<string | null>(null);
  /** Session that raised the pending permission prompt. */
  const permissionSessionRef = useRef<string | null>(null);
  /** A request id is consumable once; a second reply must not reach the host. */
  const permissionInFlightRef = useRef(false);
  /** Synchronous in-flight latch: two sends in one frame must not both start. */
  const turnInFlightRef = useRef(false);

  const startTurn = useCallback(
    async (text: string, userSelection?: string): Promise<boolean> => {
      if (preflightBlocking) {
        onNeedPreflight();
        return false;
      }
      // `busy` only reaches the composer on the next render, so a second send
      // dispatched in the same frame would otherwise start a parallel turn.
      // Reject it here and let the caller keep the draft.
      if (turnInFlightRef.current) {
        return false;
      }
      turnInFlightRef.current = true;
      turnTokenRef.current += 1;
      const myToken = turnTokenRef.current;
      /** This turn has been stopped, or superseded by a newer one. */
      const isRetired = () => turnTokenRef.current !== myToken;
      // First send / empty list / post-trash: always have a real session id.
      const target = ensureActiveSession();
      const sid = target.id;
      activeTurnSessionRef.current = sid;
      setAgentError(null);
      setBusy(true);
      setTurnStartedAt(Date.now());
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
      const wasFirstUser =
        (sessions.find((s) => s.id === sid)?.messages.filter(
          (m) => m.role === "user",
        ).length ?? 0) === 0;
      setSessions((all) => {
        const exists = all.some((s) => s.id === sid);
        const apply = (s: ChatSession): ChatSession => {
          let title = s.title;
          if (!s.titleLocked && isPlaceholderTitle(s.title)) {
            const auto = titleFromPrompt(text);
            if (auto) title = auto;
          }
          return {
            ...s,
            title,
            messages: [...s.messages, user, assistant],
            lastReadMessageId: assistantId,
            updatedAt: nowIso(),
          };
        };
        if (!exists) {
          // ensureActiveSession created it this tick — insert with first messages.
          return [apply(target), ...all.filter((s) => s.id !== sid)];
        }
        return all.map((s) => (s.id === sid ? apply(s) : s));
      });
      setPaneChat();
      pinScrollToEnd("auto");
      if (wasFirstUser) {
        void upgradeTitleWithLlm(sid, text);
      }

      const forceLocal =
        setup.providerKind === "ollama" && setup.ollamaReachable === false;
      const sess = sessions.find((s) => s.id === sid) ?? target;
      const sessionModel = sess?.chatModel ?? null;
      const sessionProvider = sess?.providerProfileId ?? null;
      const pinnedSkillId = sess?.pinnedSkillId ?? null;
      const metaAtSend: MessageMetaDto = snapshotMessageMeta({
        sessionModel,
        sessionProvider,
        modelOptions,
        defaultModelKey,
        setup,
      });

      try {
        await agentTurn(
          sid,
          text,
          forceLocal,
          sessionModel,
          sessionProvider,
          (ev) => {
            // #249: do not drop turn_completed/error after Stop — that left
            // streaming:true forever (original #105 AC#3). Host cancel: #90/#109.
            if (!shouldProcessEventWhileStopped(isRetired(), ev.kind)) {
              return;
            }

            if (
              ev.kind === "error" &&
              ev.payload?.code === "tools_unsupported"
            ) {
              // The host has just persisted learned capability truth for this
              // exact provider/model pair. Re-list immediately so the main
              // composer does not continue offering tools on stale data.
              const keepKey =
                sessionProvider && sessionModel
                  ? modelSelectionKey(sessionProvider, sessionModel)
                  : undefined;
              void refreshChatModels(keepKey ? [keepKey] : undefined);
            }

            if (ev.kind === "permission_required") {
              const { permission: perm } = applyEventsToMessage(
                {
                  id: assistantId,
                  role: "assistant",
                  content: "",
                },
                [ev],
              );
              if (perm) {
                permissionSessionRef.current = sid;
                setPermission(perm);
                const a = ev.payload?.arguments;
                if (a && typeof a === "object" && !Array.isArray(a)) {
                  setPendingToolArgs(a as Record<string, unknown>);
                } else {
                  setPendingToolArgs({});
                }
              }
            }

            setSessions((all) => {
              const cur = all.find((s) => s.id === sid);
              if (!cur) return all;
              const m = cur.messages;
              const idx = m.findIndex((x) => x.id === assistantId);
              if (idx < 0) return all;
              const base = m[idx];
              const done =
                ev.kind === "turn_completed" || ev.kind === "error";
              const { msg } = applyEventsToMessage(
                { ...base, streaming: !done },
                [ev],
              );
              const merged: Msg = {
                ...msg,
                streaming: !done,
                meta: {
                  ...metaAtSend,
                  ...msg.meta,
                  requested_model:
                    metaAtSend.requested_model || metaAtSend.model,
                  host_confirmed: Boolean(msg.meta?.host_confirmed),
                  model: msg.meta?.host_confirmed
                    ? msg.meta.model
                    : metaAtSend.model,
                },
              };
              if (done) {
                const cite = merged.citations?.[0];
                if (cite) {
                  const citationId = cite.id.trim();
                  switch (classifyCompletedCitation(citationId)) {
                    case "file":
                      setSourcePath(citationId);
                      void hostReadFile(citationId)
                        .then((body) => setSourceContent(body))
                        .catch((err) => {
                          setSourceContent(
                            `Could not read file:\n${err instanceof Error ? err.message : String(err)}`,
                          );
                        });
                      break;
                    case "invalid":
                      setAgentError(
                        "The response included an unsupported or malformed citation. It was not opened.",
                      );
                      break;
                    case "help":
                    case "log":
                    case "deferred":
                      break;
                  }
                }
                if (
                  merged.tools?.some(
                    (t) =>
                      t.ok &&
                      (t.name === "save_memory" ||
                        t.name === "supersede_memory" ||
                        t.name === "retract_memory"),
                  )
                ) {
                  void refreshMemory();
                }
              }
              const nextMsgs = [...m];
              nextMsgs[idx] = merged;
              const updated: ChatSession = {
                ...cur,
                messages: nextMsgs,
                updatedAt: nowIso(),
              };
              if (done) {
                void persistSession(updated);
              }
              return all.map((s) => (s.id === sid ? updated : s));
            });
          },
          pinnedSkillId,
          null,
          false,
          // Hand the host the ids this transcript already uses. When the host
          // persists a terminal turn itself (e.g. a chat pinned to a provider
          // profile that no longer exists) it de-duplicates against these
          // instead of writing a second copy of the same exchange.
          {
            userMessageId: user.id,
            assistantMessageId: assistantId,
            ...(loadDeveloperActivityDetail()
              ? { developerActivityDetail: true }
              : {}),
            ...(userSelection?.trim()
              ? { userSelection: userSelection.trim() }
              : {}),
          },
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        // A turn the user already stopped (or replaced) must not reach back and
        // overwrite the partial answer it left behind with a host error.
        // It still resolves `true`: `false` is the composer's "rejected, put
        // the draft back" signal, and this prompt was accepted and is already
        // in the transcript — returning false would re-inject it over whatever
        // the user has since typed.
        if (isRetired()) {
          return true;
        }
        setSessions((all) => {
          const cur = all.find((s) => s.id === sid);
          if (!cur) return all;
          const updated: ChatSession = {
            ...cur,
            messages: cur.messages.map((x) =>
              x.id === assistantId
                ? {
                    ...x,
                    streaming: false,
                    content: `**Host error:** ${err}`,
                    meta: metaAtSend,
                  }
                : x,
            ),
            updatedAt: nowIso(),
          };
          void persistSession(updated);
          return all.map((s) => (s.id === sid ? updated : s));
        });
      } finally {
        // A retired turn must not clear the latch or the busy flag belonging to
        // the turn that replaced it.
        if (!isRetired()) {
          turnInFlightRef.current = false;
          activeTurnSessionRef.current = null;
          setBusy(false);
          setTurnStartedAt(null);
        }
      }
      return true;
    },
    [
      preflightBlocking,
      onNeedPreflight,
      ensureActiveSession,
      sessions,
      setSessions,
      setup,
      modelOptions,
      defaultModelKey,
      refreshMemory,
      refreshChatModels,
      persistSession,
      upgradeTitleWithLlm,
      pinScrollToEnd,
      setSourcePath,
      setSourceContent,
      setPaneChat,
    ],
  );

  const respondPermission = useCallback(
    async (
      decision: "deny" | "allow_once" | "allow_session_path",
      typed?: string,
    ) => {
      if (!permission || permissionInFlightRef.current) return;
      // The host consumes a request id exactly once. A second click (or Escape)
      // while the first reply is still awaiting would be rejected by the host
      // and reported as a failed write — a false claim about an operation that
      // actually succeeded. Latch synchronously and drop the modal now.
      permissionInFlightRef.current = true;
      // The prompt belongs to the chat that raised it. Answering after a chat
      // switch must not file the tool result under the chat now on screen.
      const owner = permissionSessionRef.current ?? sessionId;
      const args = pendingToolArgs;
      const { requestId, toolName } = permission;
      setPermission(null);
      setPendingToolArgs({});
      permissionSessionRef.current = null;
      try {
        const events = await completePermission(
          requestId,
          decision,
          toolName,
          args,
          typed,
          owner,
        );
        // Append tool results as assistant follow-up
        setSessions((all) => {
          const cur = all.find((s) => s.id === owner);
          if (!cur) return all;
          const { msg } = applyEventsToMessage(
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: decision === "deny" ? "Write denied." : "",
            },
            events,
          );
          const updated: ChatSession = {
            ...cur,
            messages: [...cur.messages, msg],
            updatedAt: nowIso(),
          };
          void persistSession(updated);
          return all.map((s) => (s.id === owner ? updated : s));
        });
      } catch (e) {
        // A refused or malformed write is a turn-level outcome, not an app
        // failure. Record it in the conversation that asked for it so the
        // thread stays readable and nothing implies the write succeeded (#691).
        const detail = e instanceof Error ? e.message : String(e);
        const label = toolName.trim() || "The requested write";
        setSessions((all) => {
          const cur = all.find((s) => s.id === owner);
          if (!cur) {
            setAgentError(detail);
            return all;
          }
          // Only claim nothing was written when the request never reached the
          // tool. An already-consumed or expired request id means the host
          // decided this outcome elsewhere, and we cannot honestly say what it
          // did — so say only what we know.
          const outcomeUnknown = /expired|unknown|already|host missing/i.test(
            detail,
          );
          const failure: Msg = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: outcomeUnknown
              ? `**${label} did not return a result.** ${detail}\n\nContextDesk cannot confirm what happened — check memory or the audit log before retrying.`
              : `**${label} was not completed.** ${detail}\n\nNothing was written. You can ask again with the missing details, or continue without it.`,
          };
          const updated: ChatSession = {
            ...cur,
            messages: [...cur.messages, failure],
            updatedAt: nowIso(),
          };
          void persistSession(updated);
          return all.map((s) => (s.id === owner ? updated : s));
        });
      } finally {
        permissionInFlightRef.current = false;
      }
    },
    [permission, pendingToolArgs, sessionId, setSessions, persistSession],
  );

  const stopTurn = useCallback(() => {
    // True cancellation is host-owned (#90/#109). UI must still finalize so no
    // assistant bubble stays streaming:true (#249 / #105 AC#3). Retiring the
    // token also keeps late deltas from the cancelled turn out of the
    // transcript once a replacement turn has started.
    turnTokenRef.current += 1;
    // Cancel the chat that is actually streaming. Falling back to the on-screen
    // session would cancel the wrong turn after a mid-stream chat switch and
    // leave the real one pinned as streaming forever.
    const target = activeTurnSessionRef.current ?? sessionId;
    if (target) {
      void hostCancelTurn(target);
      setSessions((all) => {
        const cur = all.find((s) => s.id === target);
        if (!cur) return all;
        const messages = finalizeMessagesAfterStop(cur.messages);
        if (messages === cur.messages) return all;
        // Detect no-op when finalize returns equal content
        const same =
          messages.length === cur.messages.length &&
          messages.every(
            (m, i) =>
              m.id === cur.messages[i]?.id &&
              m.streaming === cur.messages[i]?.streaming,
          );
        if (same) return all;
        const updated: ChatSession = {
          ...cur,
          messages,
          updatedAt: nowIso(),
        };
        // Persist partial (or emptied) session so reload matches UI (#249 AC).
        void persistSession(updated);
        return all.map((s) => (s.id === target ? updated : s));
      });
    }
    turnInFlightRef.current = false;
    setBusy(false);
    setTurnStartedAt(null);
    // Cancellation is an expected chat action, not an application-wide error.
    // The partial assistant bubble remains in the originating conversation.
    setAgentError(null);
  }, [sessionId, setSessions, persistSession]);

  return {
    busy,
    turnStartedAt,
    permission,
    agentError,
    setAgentError,
    startTurn,
    respondPermission,
    stopTurn,
  };
}
