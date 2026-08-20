import { describe, expect, it } from "vitest";
import { PresenceService } from "./service.js";

describe("ephemeral case presence", () => {
  it("deduplicates a user and updates their surface", async () => {
    const presence = new PresenceService();
    await presence.touch("case-1", { id: "uid-a", username: "alice" }, "case_board");
    await presence.touch("case-1", { id: "uid-b", username: "bob" }, "triage_runs");
    await presence.touch("case-1", { id: "uid-a", username: "alice" }, "experiment_lab");

    const members = await presence.list("case-1");
    expect(members.members.map((member) => member.username)).toEqual(["alice", "bob"]);
    expect(members.members.find((member) => member.username === "alice")?.surface).toBe("experiment_lab");
  });
});
