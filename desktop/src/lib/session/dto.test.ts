import { describe, expect, it } from "vitest";
import { newSession, sessionFromDto, sessionToDto } from ".";

describe("chat citation persistence", () => {
  it("round-trips host-authored log corpus provenance across restart", () => {
    const session = newSession("Grounded");
    session.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "Finding",
        citations: [
          {
            id: "log_template:7",
            label: "template 7",
            corpusId: "corpus-original",
          },
        ],
      },
    ];

    const reopened = sessionFromDto(sessionToDto(session));
    expect(reopened.messages[0]?.citations?.[0]).toEqual({
      id: "log_template:7",
      label: "template 7",
      corpusId: "corpus-original",
    });
  });
});
