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

type Args = {
  sessionId: string;
  resolvedSessionId: string;
  sessions: ChatSession[];
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
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
    resolvedSessionId,
    sessions,
    setSessions,
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
        (sessions.find((s) => s.id === resolvedSessionId)?.messages.filter(
          (m) => m.role === "user",
        ).length ?? 0) === 0;
      setSessions((all) =>
        all.map((s) => {
          if (s.id !== resolvedSessionId) return s;
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
        }),
      );
      setPaneChat();
      pinScrollToEnd("auto");
      if (wasFirstUser) {
        void upgradeTitleWithLlm(sessionId, text);
      }

      const forceLocal =
        setup.providerKind === "ollama" && setup.ollamaReachable === false;
      const sess = sessions.find((s) => s.id === sessionId);
      const sessionModel = sess?.chatModel ?? null;
      const sessionProvider = sess?.providerProfileId ?? null;
      const metaAtSend: MessageMetaDto = snapshotMessageMeta({
        sessionModel,
        sessionProvider,
        modelOptions,
        defaultModelKey,
        setup,
      });

      try {
        await agentTurn(
          sessionId,
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
              const cur = all.find((s) => s.id === sessionId);
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
                  setSourcePath(cite.id);
                  void hostReadFile(cite.id)
                    .then((body) => setSourceContent(body))
                    .catch((err) => {
                      setSourceContent(
                        `Could not read file:\n${err instanceof Error ? err.message : String(err)}`,
                      );
                    });
                }
                if (
                  merged.tools?.some((t) => t.name === "save_memory" && t.ok)
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
              return all.map((s) => (s.id === sessionId ? updated : s));
            });
          },
        );
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        setAgentError(err);
        setSessions((all) => {
          const cur = all.find((s) => s.id === sessionId);
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
          return all.map((s) => (s.id === sessionId ? updated : s));
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
      sessionId,
      resolvedSessionId,
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
    setAgentError(
      "Stop requested — turn cancelled; partial answer kept when present.",
    );
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
