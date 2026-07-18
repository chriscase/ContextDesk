import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, streamAnnouncementSlice } from "../lib/a11y";

type Props = {
  /** Full assistant message text (growing while streaming). */
  text: string;
  streaming: boolean;
};

/**
 * Debounced polite live region for streamed assistant answers (#149).
 * Announces settled sentences, not every token; reduced-motion → end only.
 */
export function StreamLiveRegion({ text, streaming }: Props) {
  const [announce, setAnnounce] = useState("");
  const lastAnnounced = useRef("");
  const reduced = prefersReducedMotion();

  useEffect(() => {
    if (!text.trim()) {
      return;
    }

    if (reduced) {
      if (!streaming) {
        const slice = streamAnnouncementSlice(text, false);
        if (slice && slice !== lastAnnounced.current) {
          lastAnnounced.current = slice;
          setAnnounce(slice);
        }
      }
      return;
    }

    const delay = streaming ? 900 : 0;
    const id = window.setTimeout(() => {
      const slice = streamAnnouncementSlice(text, streaming);
      if (slice && slice !== lastAnnounced.current) {
        lastAnnounced.current = slice;
        setAnnounce(slice);
      }
    }, delay);
    return () => window.clearTimeout(id);
  }, [text, streaming, reduced]);

  // Reset when a new turn starts (text shrinks / empty).
  useEffect(() => {
    if (!text) {
      lastAnnounced.current = "";
      setAnnounce("");
    }
  }, [text]);

  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      data-testid="stream-live-region"
    >
      {announce}
    </div>
  );
}
