import { describe, expect, it } from "vitest";
import { newSession } from "../lib/session";
import { shouldPersistUiSession } from "./useChatSessions";

describe("main-chat corpus attachment persistence (#695)", () => {
  it("keeps ordinary empty drafts ephemeral but persists an empty linked chat", () => {
    const ordinary = newSession("Chat");
    expect(shouldPersistUiSession(ordinary)).toBe(false);

    const linked = { ...ordinary, linkedCorpusId: "corpus-a" };
    expect(shouldPersistUiSession(linked)).toBe(true);
  });

  it("never persists a trashed chat through the active-session path", () => {
    const linked = {
      ...newSession("Incident"),
      linkedCorpusId: "corpus-a",
      trashed: true,
    };
    expect(shouldPersistUiSession(linked)).toBe(false);
  });
});
