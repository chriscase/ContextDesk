/** Transcript scroll machinery (#146) — keep refs + double-rAF pin together. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSession, Msg } from "../lib/session";

const NEAR_BOTTOM_PX = 120;

export function useChatScroll(
  messages: Msg[],
  sessionId: string,
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>,
) {
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const ignoreScrollRef = useRef(false);
  const [unreadBelow, setUnreadBelow] = useState(0);

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

  const pinScrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const run = () => {
      const el = chatScrollRef.current;
      if (!el) return;
      ignoreScrollRef.current = true;
      const top = Math.max(0, el.scrollHeight - el.clientHeight);
      if (behavior === "smooth") {
        el.scrollTo({ top, behavior: "smooth" });
      } else {
        el.scrollTop = top;
      }
      window.setTimeout(
        () => {
          ignoreScrollRef.current = false;
        },
        behavior === "smooth" ? 320 : 0,
      );
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, []);

  const scrollChatToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      stickToBottomRef.current = true;
      setUnreadBelow(0);
      pinScrollToEnd(behavior);
      const last = messages[messages.length - 1];
      if (last && sessionId) markSessionRead(sessionId, last.id);
    },
    [messages, sessionId, markSessionRead, pinScrollToEnd],
  );

  const onChatScroll = useCallback(() => {
    if (ignoreScrollRef.current) return;
    const el = chatScrollRef.current;
    if (!el || !sessionId) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX) {
      stickToBottomRef.current = true;
      setUnreadBelow(0);
      const last = messages[messages.length - 1];
      if (last) markSessionRead(sessionId, last.id);
    } else {
      stickToBottomRef.current = false;
    }
  }, [messages, sessionId, markSessionRead]);

  useEffect(() => {
    if (stickToBottomRef.current) pinScrollToEnd("auto");
  }, [messages, pinScrollToEnd]);

  return {
    chatScrollRef,
    stickToBottomRef,
    unreadBelow,
    pinScrollToEnd,
    scrollChatToBottom,
    onChatScroll,
  };
}
