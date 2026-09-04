import {
  parseSoftwareImpact,
  parseSoftwareImpactList,
  parseSoftwareImpactSuggestions,
  softwareImpactIdentityKey,
} from "@cd-collab/contracts";
import { describe, expect, it } from "vitest";
import { MemoryAuditStore } from "../audit/index.js";
import {
  DuplicateSoftwareImpactError,
  InvestigationNotVisibleError,
  SoftwareImpactService,
} from "./service.js";

const alice = { id: "local:alice", username: "alice" };
const bob = { id: "local:bob", username: "bob" };

function gateway(visible: readonly string[] = ["case-a"]) {
  return {
    getCase: async (id: string) => (visible.includes(id) ? { id, title: "Synthetic case" } : null),
    appendDomainTimeline: async () => undefined,
  };
}

describe("software impact service", () => {
  it("records several named identities without ranking their builds", async () => {
    const service = new SoftwareImpactService({
      audit: new MemoryAuditStore(),
      investigations: gateway(),
    });
    const older = await service.record(
      "case-a",
      alice,
      false,
      { productName: "Fixture Desk", version: "4.1", status: "ruled_out" },
      "test",
    );
    const newer = await service.record(
      "case-a",
      alice,
      false,
      { productName: "Fixture Desk", version: "4.2", build: "build-007", status: "confirmed" },
      "test",
    );
    const listed = parseSoftwareImpactList(await service.list("case-a", alice, false));
    expect(listed.ordering).toBe("recorded_at");
    expect(listed.records.map((row) => row.id)).toEqual([older.id, newer.id]);
    expect(listed.records.map((row) => row.status)).toEqual(["ruled_out", "confirmed"]);
    expect(softwareImpactIdentityKey(older)).not.toBe(softwareImpactIdentityKey(newer));
  });

  it("refuses a second active claim for the same identity", async () => {
    const service = new SoftwareImpactService({ investigations: gateway() });
    const first = await service.record(
      "case-a",
      alice,
      false,
      { productName: "Fixture Desk", build: "build-007", status: "suspected" },
      "test",
    );
    await expect(
      service.record(
        "case-a",
        alice,
        false,
        { productName: "fixture desk", build: "BUILD-007", status: "confirmed" },
        "test",
      ),
    ).rejects.toBeInstanceOf(DuplicateSoftwareImpactError);
    const updated = parseSoftwareImpact(
      await service.setStatus("case-a", first.id, alice, false, "confirmed", "Now corroborated.", "test"),
    );
    expect(updated.status).toBe("confirmed");
    expect(updated.note).toBe("Now corroborated.");
    expect(updated.recordedAt).toBe(first.recordedAt);
  });

  it("keeps a released row and hides it from new duplicate checks", async () => {
    const service = new SoftwareImpactService({ investigations: gateway() });
    const first = await service.record(
      "case-a",
      alice,
      false,
      { component: "queue-worker", status: "observed" },
      "test",
    );
    const released = await service.release("case-a", first.id, alice, false, "test");
    expect(released.state).toBe("released");
    expect(released.releasedAt).not.toBeNull();
    const again = await service.record(
      "case-a",
      alice,
      false,
      { component: "queue-worker", status: "ruled_out" },
      "test",
    );
    expect(again.id).not.toBe(first.id);
    expect(again.status).toBe("ruled_out");
  });

  it("does not disclose another investigation's records or suggestion values", async () => {
    const service = new SoftwareImpactService({
      investigations: {
        getCase: async (id, actor) => {
          if (id === "case-a" && actor.username === "alice") return { id, title: "A" };
          if (id === "case-b" && actor.username === "bob") return { id, title: "B" };
          return null;
        },
        appendDomainTimeline: async () => undefined,
      },
    });
    await service.record("case-b", bob, false, { productName: "Secret Catalog", status: "confirmed" }, "test");
    await expect(service.list("case-b", alice, false)).rejects.toBeInstanceOf(InvestigationNotVisibleError);
    const suggestions = parseSoftwareImpactSuggestions(
      await service.suggestions("productName", alice, false, ["case-a"]),
    );
    expect(suggestions.values).toEqual([]);
  });

  it("offers suggestions only from investigations the reader can already see", async () => {
    const service = new SoftwareImpactService({
      investigations: {
        getCase: async (id) => ({ id, title: id }),
        appendDomainTimeline: async () => undefined,
      },
    });
    await service.record("case-a", alice, false, { environment: "QA / us-central", status: "observed" }, "test");
    await service.record("case-b", bob, false, { environment: "prod-west", status: "suspected" }, "test");
    const suggestions = parseSoftwareImpactSuggestions(
      await service.suggestions("environment", alice, false, ["case-a"]),
    );
    expect(suggestions.values).toEqual(["QA / us-central"]);
  });

  it("projects only canonical identities from the authorized collection set", async () => {
    const service = new SoftwareImpactService({
      investigations: {
        getCase: async (id) => ({ id, title: id }),
        appendDomainTimeline: async () => undefined,
      },
    });
    await service.record("case-a", alice, false, {
      productName: "Fixture Desk",
      version: "4.2",
      status: "observed",
    }, "test");
    await service.record("case-b", bob, false, {
      productName: "Secret Catalog",
      status: "suspected",
    }, "test");
    expect(await service.collectionIdentities(["case-a"])).toEqual([{
      caseId: "case-a",
      productName: "Fixture Desk",
      version: "4.2",
      build: "",
      component: "",
      environment: "",
    }]);
  });
});
