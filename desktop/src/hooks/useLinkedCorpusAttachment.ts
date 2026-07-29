import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { hostSetChatLinkedCorpus } from "../lib/host";
import {
  nowIso,
  sessionFromDto,
  sessionToDto,
  type ChatSession,
} from "../lib/session";

type Args = {
  ensureActiveSession: () => ChatSession;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
};

/**
 * Host-first governed corpus attachment (#695).
 *
 * The transcript never advertises a grant before the host validates and saves
 * it. One in-flight mutation is allowed per chat, and the host also compares
 * the durable session revision to reject stale-window writes.
 */
export function useLinkedCorpusAttachment({
  ensureActiveSession,
  setSessions,
}: Args) {
  const inFlightBySession = useRef(new Map<string, symbol>());
  const [pendingSessionIds, setPendingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );

  const setSessionLinkedCorpus = useCallback(
    async (corpusId: string | null) => {
      const target = ensureActiveSession();
      if (inFlightBySession.current.has(target.id)) {
        throw new Error("Log context is already being updated for this chat");
      }

      const operation = Symbol(target.id);
      inFlightBySession.current.set(target.id, operation);
      setPendingSessionIds((current) => {
        const next = new Set(current);
        next.add(target.id);
        return next;
      });

      try {
        const confirmed = await hostSetChatLinkedCorpus(
          target.id,
          corpusId,
          sessionToDto(target),
          target.updatedAt,
        );
        if (inFlightBySession.current.get(target.id) !== operation) return;

        const hostSession = confirmed ? sessionFromDto(confirmed) : null;
        const linkedCorpusId = hostSession?.linkedCorpusId ?? corpusId;
        const updatedAt = hostSession?.updatedAt ?? nowIso();
        setSessions((all) => {
          const current = all.find((session) => session.id === target.id);
          const next = {
            ...(current ?? target),
            linkedCorpusId,
            updatedAt,
          };
          return current
            ? all.map((session) => (session.id === target.id ? next : session))
            : [next, ...all];
        });
      } finally {
        if (inFlightBySession.current.get(target.id) === operation) {
          inFlightBySession.current.delete(target.id);
          setPendingSessionIds((current) => {
            const next = new Set(current);
            next.delete(target.id);
            return next;
          });
        }
      }
    },
    [ensureActiveSession, setSessions],
  );

  return { pendingSessionIds, setSessionLinkedCorpus };
}
