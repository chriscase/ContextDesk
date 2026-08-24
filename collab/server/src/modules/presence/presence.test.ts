import { describe, expect, it } from "vitest";
import { MemoryPresenceBackend, PgPresenceBackend, PresenceService } from "./service.js";

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

  it("purges stale memory presence before consulting case visibility", async () => {
    const backend = new MemoryPresenceBackend();
    await backend.touch("case-1", { id: "uid-a", username: "alice" }, "case_board");
    let visibilityLookups = 0;
    const query = {
      actorId: "uid-a",
      isAdmin: false,
      limit: 20,
      visibility: {
        caseTitle: () => {
          visibilityLookups += 1;
          return "Visible";
        },
      },
    };

    expect(await backend.listOverviewPresence({ ...query, now: Date.now() + 46_000 })).toEqual([]);
    expect(visibilityLookups).toBe(0);

    expect(await backend.listOverviewPresence(query)).toEqual([]);
    expect(visibilityLookups).toBe(0);
  });

  it("trusts PostgreSQL's freshness cutoff instead of filtering with the app clock", async () => {
    const statements: string[] = [];
    const backend = new PgPresenceBackend({
      query: async (sql: string) => {
        statements.push(sql);
        return {
          rows: [{
            case_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            identity_id: "uid-a",
            username: "alice",
            surface: "case_board",
            last_seen_at: "2000-01-01T00:00:00.000Z",
          }],
        };
      },
    } as never);

    const farFuture = Date.parse("2100-01-01T00:00:00.000Z");
    const caseRows = await backend.list(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      farFuture,
    );
    expect(caseRows).toHaveLength(1);

    const overviewRows = await backend.listOverviewPresence({
      actorId: "uid-a",
      isAdmin: false,
      limit: 20,
      visibility: null,
      now: farFuture,
    });

    expect(overviewRows).toHaveLength(1);
    expect(overviewRows[0]?.username).toBe("alice");
    expect(statements.some((sql) => /last_seen_at >= now\(\) - interval '45 seconds'/.test(sql)))
      .toBe(true);
  });
});
