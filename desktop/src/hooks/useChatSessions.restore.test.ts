/**
 * Durable chat selection: what reopens on relaunch, and what "New chat"
 * actually creates.
 *
 * Hydration used to hard-select the first session the host returned, so the
 * conversation the user was last reading was silently dropped on every launch.
 */

import { describe, expect, it } from "vitest";
import { newSession, type ChatSession } from "../lib/session";
import {
  isPristineBlank,
  nextChatTitle,
  pickRestoredSession,
} from "./useChatSessions";

function session(
  id: string,
  title: string,
  flags: Partial<ChatSession> = {},
): ChatSession {
  return { ...newSession(title), id, ...flags };
}

describe("restoring the last-read conversation", () => {
  const loaded = [
    session("s-newest", "Release notes"),
    session("s-middle", "Auth refactor"),
    session("s-oldest", "Incident review"),
  ];

  it("reopens the stored conversation rather than the newest one", () => {
    expect(pickRestoredSession(loaded, "s-oldest")).toBe("s-oldest");
  });

  it("falls back to the newest chat when nothing was stored", () => {
    expect(pickRestoredSession(loaded, null)).toBe("s-newest");
  });

  it("ignores a stored id for a chat that no longer exists", () => {
    expect(pickRestoredSession(loaded, "s-deleted")).toBe("s-newest");
  });

  it("refuses to reopen a chat that was archived or trashed since", () => {
    const withHidden = [
      ...loaded,
      session("s-archived", "Old spike", { archived: true }),
      session("s-trashed", "Scratch", { trashed: true }),
    ];
    expect(pickRestoredSession(withHidden, "s-archived")).toBe("s-newest");
    expect(pickRestoredSession(withHidden, "s-trashed")).toBe("s-newest");
  });

  it("has nothing to restore when no chats loaded", () => {
    expect(pickRestoredSession([], "s-oldest")).toBeNull();
  });
});

describe("default chat titles", () => {
  it("numbers past the highest used, so trashing does not create a duplicate", () => {
    // Create "Chat 2", trash "Chat 1": counting sessions would hand out a
    // second "Chat 2".
    const remaining = [session("s-2", "Chat 2")];
    expect(nextChatTitle(remaining)).toBe("Chat 3");
  });

  it("starts at Chat 1 with nothing open", () => {
    expect(nextChatTitle([])).toBe("Chat 1");
  });

  it("is unaffected by chats the user has renamed", () => {
    const named = [session("a", "Incident review"), session("b", "Chat 4")];
    expect(nextChatTitle(named)).toBe("Chat 5");
  });
});

describe("which blank chat \"New chat\" may reuse", () => {
  const blank = () => session("s-blank", "Chat 2");

  it("reuses a genuinely untouched blank chat", () => {
    expect(isPristineBlank(blank(), false)).toBe(true);
  });

  it("refuses a blank chat holding unsent composer text", () => {
    // Reusing it would resurrect a draft the user had walked away from.
    expect(isPristineBlank(blank(), true)).toBe(false);
  });

  it.each([
    ["a renamed chat", { title: "Incident review", titleLocked: true }],
    ["a pinned chat", { pinned: true }],
    ["a chat with a chosen model", { chatModel: "mistral:latest" }],
    ["a chat pinned to a provider", { providerProfileId: "ollama" }],
    ["a chat with a pinned skill", { pinnedSkillId: "triage" }],
    ["a chat with an attached corpus", { linkedCorpusId: "corpus-a" }],
  ])("refuses %s", (_label, overrides) => {
    // Each of these is a setting the user chose; silently handing it to the
    // next "New chat" would be someone else's configuration.
    expect(isPristineBlank({ ...blank(), ...overrides }, false)).toBe(false);
  });

  it("refuses a chat that already has messages", () => {
    const withHistory = {
      ...blank(),
      messages: [{ id: "m1", role: "user" as const, content: "hi" }],
    };
    expect(isPristineBlank(withHistory, false)).toBe(false);
  });
});
