/** Transcript scroll machinery (#146, #696) — follow vs detach vs new response. */

import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../lib/a11y";
import type { ChatSession, Msg } from "../lib/session";

const NEAR_BOTTOM_PX = 120;

function lastAssistantId(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      return messages[i]!.id;
    }
  }
  return null;
}

function lastMessageId(messages: Msg[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1]!.id : null;
}

export function useChatScroll(
  messages: Msg[],
  sessionId: string,
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>,
) {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  /** Stick/follow for the *active* session (also written by App when restoring scroll). */
  const stickToBottomRef = useRef(true);
  /**
   * Suppress only the scroll event emitted by our own pin. Cleared in the same
   * turn for instant pins so a later user scroll is never dropped (#696).
   */
  const ignoreScrollRef = useRef(false);

  /** Per-session follow, new-response, scrollTop, and last-seen assistant id. */
  const stickBySessionRef = useRef<Record<string, boolean>>({});
  const newResponseBySessionRef = useRef<Record<string, boolean>>({});
  const scrollTopBySessionRef = useRef<Record<string, number>>({});
  const lastAssistantIdBySessionRef = useRef<Record<string, string | null>>({});
  const activeSessionRef = useRef(sessionId);

  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [hasNewResponseBelow, setHasNewResponseBelow] = useState(false);

  const markSessionRead = useCallback(
    (sid: string, messageId: string | null) => {
      if (!messageId) return;
      setSessions((all) => {
        const cur = all.find((s) => s.id === sid);
        if (!cur || cur.lastReadMessageId === messageId) return all;
        return all.map((s) =>
          s.id === sid ? { ...s, lastReadMessageId: messageId } : s,
        );
      });
    },
    [setSessions],
  );

  const pinScrollToEnd = useCallback((requested: ScrollBehavior = "auto") => {
    // The global reduced-motion CSS override cannot reach a scripted scroll,
    // so honour the preference here (#767).
    const behavior: ScrollBehavior =
      requested === "smooth" && prefersReducedMotion() ? "auto" : requested;
    const run = () => {
      const el = chatScrollRef.current;
      if (!el) return;
      ignoreScrollRef.current = true;
      const top = Math.max(0, el.scrollHeight - el.clientHeight);
      if (behavior === "smooth") {
        el.scrollTo({ top, behavior: "smooth" });
        window.setTimeout(() => {
          ignoreScrollRef.current = false;
        }, 320);
      } else {
        el.scrollTop = top;
        // Instant pin: clear before returning so the next user scroll is handled.
        ignoreScrollRef.current = false;
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, []);

  const applyNearBottomUi = useCallback(
    (sid: string, msgs: Msg[]) => {
      stickToBottomRef.current = true;
      stickBySessionRef.current[sid] = true;
      newResponseBySessionRef.current[sid] = false;
      setShowJumpToLatest(false);
      setHasNewResponseBelow(false);
      const aid = lastAssistantId(msgs);
      if (aid !== null) {
        lastAssistantIdBySessionRef.current[sid] = aid;
      }
      markSessionRead(sid, lastMessageId(msgs));
    },
    [markSessionRead],
  );

  const scrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (sessionId) {
        applyNearBottomUi(sessionId, messages);
      } else {
        stickToBottomRef.current = true;
        setShowJumpToLatest(false);
        setHasNewResponseBelow(false);
      }
      pinScrollToEnd(behavior);
    },
    [messages, sessionId, applyNearBottomUi, pinScrollToEnd],
  );

  const onChatScroll = useCallback(() => {
    if (ignoreScrollRef.current) return;
    const el = chatScrollRef.current;
    if (!el || !sessionId) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_PX) {
      applyNearBottomUi(sessionId, messages);
    } else {
      stickToBottomRef.current = false;
      stickBySessionRef.current[sessionId] = false;
      scrollTopBySessionRef.current[sessionId] = el.scrollTop;
      setShowJumpToLatest(true);
      setHasNewResponseBelow(newResponseBySessionRef.current[sessionId] ?? false);
    }
  }, [messages, sessionId, applyNearBottomUi]);

  // Persist active session stick/scroll when switching chats; restore the next session.
  useEffect(() => {
    const prev = activeSessionRef.current;
    if (prev && prev !== sessionId) {
      stickBySessionRef.current[prev] = stickToBottomRef.current;
      const el = chatScrollRef.current;
      if (el && !stickToBottomRef.current) {
        scrollTopBySessionRef.current[prev] = el.scrollTop;
      }
    }
    activeSessionRef.current = sessionId;
    if (!sessionId) {
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
      setHasNewResponseBelow(false);
      return;
    }

    const stick = stickBySessionRef.current[sessionId] ?? true;
    stickToBottomRef.current = stick;
    const hasNew = newResponseBySessionRef.current[sessionId] ?? false;
    setShowJumpToLatest(!stick);
    setHasNewResponseBelow(hasNew);

    // Seed last-seen assistant so existing history is not treated as a new arrival.
    if (!(sessionId in lastAssistantIdBySessionRef.current)) {
      lastAssistantIdBySessionRef.current[sessionId] = lastAssistantId(messages);
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = chatScrollRef.current;
        if (!el || activeSessionRef.current !== sessionId) return;
        if (stickToBottomRef.current) {
          ignoreScrollRef.current = true;
          el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
          window.setTimeout(() => {
            ignoreScrollRef.current = false;
          }, 0);
        } else {
          const saved = scrollTopBySessionRef.current[sessionId];
          if (typeof saved === "number") {
            ignoreScrollRef.current = true;
            el.scrollTop = saved;
            window.setTimeout(() => {
              ignoreScrollRef.current = false;
            }, 0);
          }
        }
      });
    });
    // Only re-run on session identity change — message-driven pin is separate.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional session switch isolation
  }, [sessionId]);

  // Follow latest content when sticking; detect genuine new assistant responses when detached.
  useEffect(() => {
    if (!sessionId) return;

    const assistantId = lastAssistantId(messages);
    const prevAssistant = lastAssistantIdBySessionRef.current[sessionId];

    if (stickToBottomRef.current) {
      pinScrollToEnd("auto");
      if (assistantId !== null) {
        lastAssistantIdBySessionRef.current[sessionId] = assistantId;
      }
      newResponseBySessionRef.current[sessionId] = false;
      setShowJumpToLatest(false);
      setHasNewResponseBelow(false);
      markSessionRead(sessionId, lastMessageId(messages));
      return;
    }

    // Detached: always offer neutral jump; mark new response only when a new
    // assistant *message id* appears (streaming chunks on the same id do not re-arm).
    setShowJumpToLatest(true);
    if (
      assistantId !== null &&
      assistantId !== prevAssistant &&
      // prevAssistant undefined means seed-only path; treat first observed id as baseline
      prevAssistant !== undefined
    ) {
      newResponseBySessionRef.current[sessionId] = true;
      setHasNewResponseBelow(true);
      lastAssistantIdBySessionRef.current[sessionId] = assistantId;
    } else {
      if (assistantId !== null && prevAssistant === undefined) {
        lastAssistantIdBySessionRef.current[sessionId] = assistantId;
      }
      setHasNewResponseBelow(newResponseBySessionRef.current[sessionId] ?? false);
    }
  }, [messages, sessionId, pinScrollToEnd, markSessionRead]);

  return {
    chatScrollRef,
    stickToBottomRef,
    showJumpToLatest,
    hasNewResponseBelow,
    pinScrollToEnd,
    scrollChatToBottom,
    onChatScroll,
  };
}
