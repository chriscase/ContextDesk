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
import { parseHelpLocator } from "../lib/help";

type CompletedCitationRoute =
  | "help"
  | "log"
  | "file"
  | "deferred"
  | "invalid";

const GOVERNED_LOG_CITATION =
  /^(?:log_template|log_event):[a-z0-9][a-z0-9._-]*$/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;

/**
 * Classify a completed turn's first citation before any automatic I/O.
 * Governed/in-app identities are click-routed elsewhere and must never be
 * interpreted as workspace paths.
 */
export function classifyCompletedCitation(
  citationId: string,
): CompletedCitationRoute {
  const id = citationId.trim();
  if (!id || id.includes("\0")) return "invalid";
  if (parseHelpLocator(id)) return "help";
  if (GOVERNED_LOG_CITATION.test(id)) return "log";

  if (
    id.startsWith("help://") ||
    id.startsWith("log_template:") ||
    id.startsWith("log_event:")
  ) {
    return "invalid";
  }

  // These are handled only after an explicit citation click.
  if (/^https?:\/\//i.test(id) || /^memory:[a-z0-9._-]+$/i.test(id)) {
    return "deferred";
  }

  if (URI_SCHEME.test(id) && !WINDOWS_ABSOLUTE_PATH.test(id)) {
    return "invalid";
  }
  return "file";
}

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
  const stopRef = useRef(false);

  const startTurn = useCallback(
    async (text: string): Promise<boolean> => {
      if (preflightBlocking) {
        onNeedPreflight();
        return false;
      }
      // First send / empty list / post-trash: always have a real session id.
      const target = ensureActiveSession();
      const sid = target.id;
      stopRef.current = false;
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
            if (!shouldProcessEventWhileStopped(stopRef.current, ev.kind)) {
              return;
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
                void persistSession(updated).then((saved) => {
                  setSessions((prev) =>
                    prev.map((s) => (s.id === saved.id ? saved : s)),
                  );
                });
              }
              return all.map((s) => (s.id === sid ? updated : s));
            });
          },
          pinnedSkillId,
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
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
          void persistSession(updated).then((saved) => {
            setSessions((prev) =>
              prev.map((s) => (s.id === saved.id ? saved : s)),
            );
          });
          return all.map((s) => (s.id === sid ? updated : s));
        });
      } finally {
        setBusy(false);
        setTurnStartedAt(null);
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
      if (!permission) return;
      try {
        const events = await completePermission(
          permission.requestId,
          decision,
          permission.toolName,
          pendingToolArgs,
          typed,
          sessionId,
        );
        setPermission(null);
        setPendingToolArgs({});
        // Append tool results as assistant follow-up
        setSessions((all) => {
          const cur = all.find((s) => s.id === sessionId);
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
          void persistSession(updated).then((saved) => {
            setSessions((prev) =>
              prev.map((s) => (s.id === saved.id ? saved : s)),
            );
          });
          return all.map((s) => (s.id === sessionId ? updated : s));
        });
      } catch (e) {
        setAgentError(e instanceof Error ? e.message : String(e));
        setPermission(null);
      }
    },
    [permission, pendingToolArgs, sessionId, setSessions, persistSession],
  );

  const stopTurn = useCallback(() => {
    // True cancellation is host-owned (#90/#109). UI must still finalize so no
    // assistant bubble stays streaming:true (#249 / #105 AC#3).
    stopRef.current = true;
    if (sessionId) {
      void hostCancelTurn(sessionId);
      setSessions((all) => {
        const cur = all.find((s) => s.id === sessionId);
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
        void persistSession(updated).then((saved) => {
          setSessions((prev) =>
            prev.map((s) => (s.id === saved.id ? saved : s)),
          );
        });
        return all.map((s) => (s.id === sessionId ? updated : s));
      });
    }
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
