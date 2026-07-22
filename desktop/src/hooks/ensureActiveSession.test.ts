import { describe, expect, it } from "vitest";
import { newSession, type ChatSession } from "../lib/session";

/**
 * Pure mirror of ensureActiveSession selection rules (keep in sync with
 * useChatSessions.ensureActiveSession).
 */
function pickActiveSession(
  sessions: ChatSession[],
  activeSessionId: string | null,
): ChatSession | null {
  const open = sessions.filter((s) => !s.archived && !s.trashed);
  return (
    (activeSessionId
      ? open.find((s) => s.id === activeSessionId)
      : undefined) ??
    open[0] ??
    null
  );
}

describe("ensureActiveSession selection", () => {
  it("returns null when no open chats (caller must create)", () => {
    expect(pickActiveSession([], null)).toBeNull();
    const trashed = { ...newSession("gone"), trashed: true };
    expect(pickActiveSession([trashed], trashed.id)).toBeNull();
  });

  it("prefers active open session over first", () => {
    const a = newSession("A");
    const b = newSession("B");
    expect(pickActiveSession([a, b], b.id)?.id).toBe(b.id);
  });

  it("falls back to first open when active is missing", () => {
    const a = newSession("A");
    const b = newSession("B");
    expect(pickActiveSession([a, b], "missing")?.id).toBe(a.id);
  });
});
