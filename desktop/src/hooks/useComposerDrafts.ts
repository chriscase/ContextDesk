/**
 * Per-conversation composer drafts.
 *
 * `ChatPane` is unmounted whenever the user leaves the Chat pane, and it stays
 * mounted across chat switches. Draft text kept inside the composer therefore
 * used to be destroyed by a trip to Help and to follow the user from one chat
 * into the next. Owning drafts above the pane switch fixes both: a draft is
 * tied to its conversation and survives unmount.
 */

import { useCallback, useMemo, useState } from "react";

export type ComposerDrafts = {
  /** Draft for one conversation; empty string when there is none. */
  draftFor: (sessionId: string) => string;
  setDraft: (sessionId: string, text: string) => void;
  clearDraft: (sessionId: string) => void;
  /** Drop drafts for conversations that no longer exist. */
  retainSessions: (sessionIds: readonly string[]) => void;
};

export function useComposerDrafts(): ComposerDrafts {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const draftFor = useCallback(
    (sessionId: string) => (sessionId ? (drafts[sessionId] ?? "") : ""),
    [drafts],
  );

  const setDraft = useCallback((sessionId: string, text: string) => {
    if (!sessionId) return;
    setDrafts((all) => {
      if ((all[sessionId] ?? "") === text) return all;
      if (!text) {
        if (!(sessionId in all)) return all;
        const { [sessionId]: _dropped, ...rest } = all;
        return rest;
      }
      return { ...all, [sessionId]: text };
    });
  }, []);

  const clearDraft = useCallback((sessionId: string) => {
    if (!sessionId) return;
    setDrafts((all) => {
      if (!(sessionId in all)) return all;
      const { [sessionId]: _dropped, ...rest } = all;
      return rest;
    });
  }, []);

  const retainSessions = useCallback((sessionIds: readonly string[]) => {
    setDrafts((all) => {
      const keep = new Set(sessionIds);
      const next: Record<string, string> = {};
      let changed = false;
      for (const [id, text] of Object.entries(all)) {
        if (keep.has(id)) next[id] = text;
        else changed = true;
      }
      return changed ? next : all;
    });
  }, []);

  // Stable identity so callers can depend on it in effects without looping.
  return useMemo(
    () => ({ draftFor, setDraft, clearDraft, retainSessions }),
    [draftFor, setDraft, clearDraft, retainSessions],
  );
}
