/**
 * The investigation record graph must survive a restart on the single-node
 * SQLite backend, exactly like case and evidence state does.
 *
 * A long-lived investigation that forgets who it involved, what it cited, or
 * why it was resolved is worse than one that never recorded it: the record
 * still looks complete. Every identity and label here is synthetic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemEvidenceStore } from "../evidence/store.js";
import { CatalogService } from "../modules/catalog/index.js";
import { CaseService } from "../modules/cases/index.js";
import { EntityService } from "../modules/entities/index.js";
import { ReferenceService } from "../modules/references/index.js";
import { ResolutionService } from "../modules/resolutions/index.js";
import { createSqliteRuntime } from "./sqlite.js";

const actor = { id: "local:lead", username: "lead" };

function wire(runtime: ReturnType<typeof createSqliteRuntime>, evidenceRoot: string) {
  const evidence = new FilesystemEvidenceStore({ rootDir: evidenceRoot });
  const catalog = new CatalogService(runtime.catalog, runtime.audit);
  const resolutions = new ResolutionService({
    store: runtime.resolutions,
    audit: runtime.audit,
  });
  const cases = new CaseService(evidence, runtime.audit, runtime.cases, catalog, resolutions);
  const investigations = {
    getCase: (id: string, who: { id: string; username: string }, isAdmin: boolean) =>
      cases.getCase(id, who, isAdmin),
    appendDomainTimeline: (
      caseId: string,
      event: {
        kind: string;
        actor: { id: string; username: string };
        targetId: string | null;
        clientTime: string | null;
        payload: unknown;
      },
    ) => cases.appendDomainTimeline(caseId, event),
  };
  resolutions.bindInvestigations(investigations);
  return {
    cases,
    resolutions,
    entities: new EntityService({ store: runtime.entities, audit: runtime.audit, investigations }),
    references: new ReferenceService({
      store: runtime.references,
      audit: runtime.audit,
      investigations,
    }),
  };
}

describe("SQLite durability for the investigation record graph", () => {
  it("keeps entities, involvement, citations, occurred-at, and resolutions across a reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-record-sqlite-"));
    const path = join(root, "collab.sqlite");
    const evidenceRoot = join(root, "evidence");
    try {
      const first = createSqliteRuntime(path);
      const one = wire(first, evidenceRoot);
      const older = await one.cases.createCase(
        actor,
        { title: "Synthetic prior investigation", occurredAt: "2019-06-04" },
        "test",
      );
      const current = await one.cases.createCase(
        actor,
        { title: "Synthetic current investigation" },
        "test",
      );
      const entity = await one.entities.createEntity(
        actor,
        { kind: "organization", label: "Fable Harbor" },
        "test",
      );
      await one.entities.recordInvolvement(
        current.id,
        actor,
        true,
        { entityId: entity.id, relationship: "affected", occurredAt: "2024-11-04" },
        "test",
      );
      await one.references.create(
        current.id,
        actor,
        true,
        { toInvestigationId: older.id, note: "Synthetic prior signature." },
        "test",
      );
      await one.cases.setStatus(current.id, actor, "resolved", "test", {
        resolution: {
          basis: "human_only",
          rationale: "Synthetic conclusion reached by reading the recorded notes.",
          unknowns: ["What moved the synthetic batch schedule."],
        },
      });
      first.state.close();

      const second = createSqliteRuntime(path);
      const two = wire(second, evidenceRoot);
      try {
        const reopenedOlder = await two.cases.getCase(older.id, actor, true);
        expect(reopenedOlder?.occurredAt).toBe("2019-06-04");
        expect(reopenedOlder?.occurredAtPrecision).toBe("day");
        expect(reopenedOlder?.occurredAtZone).toBe("unspecified");

        const registry = await two.entities.listEntities();
        expect(registry.entities.map((row) => row.label)).toEqual(["Fable Harbor"]);

        const involvement = await two.entities.listInvolvements(current.id, actor, true);
        expect(involvement.involvements).toHaveLength(1);
        expect(involvement.involvements[0]?.recordedLabel).toBe("Fable Harbor");
        expect(involvement.involvements[0]?.occurredAt).toBe("2024-11-04");

        const references = await two.references.list(current.id, actor, true);
        expect(references.outbound).toHaveLength(1);
        expect(references.outbound[0]?.recordedTitle).toBe("Synthetic prior investigation");

        const resolutions = await two.resolutions.list(current.id, actor, true);
        expect(resolutions.resolutions).toHaveLength(1);
        expect(resolutions.resolutions[0]?.basis).toBe("human_only");
        expect(resolutions.resolutions[0]?.unknowns).toEqual([
          "What moved the synthetic batch schedule.",
        ]);
        const reopenedCurrent = await two.cases.getCase(current.id, actor, true);
        expect(reopenedCurrent?.status).toBe("resolved");
      } finally {
        second.state.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still refuses a resolved status with no record after a reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-record-sqlite-guard-"));
    const path = join(root, "collab.sqlite");
    const evidenceRoot = join(root, "evidence");
    try {
      const first = createSqliteRuntime(path);
      const one = wire(first, evidenceRoot);
      const created = await one.cases.createCase(actor, { title: "Synthetic unresolved" }, "test");
      first.state.close();

      const second = createSqliteRuntime(path);
      const two = wire(second, evidenceRoot);
      try {
        await expect(
          two.cases.setStatus(created.id, actor, "resolved", "test"),
        ).rejects.toThrow(/resolution_required/);
        const reopened = await two.cases.getCase(created.id, actor, true);
        expect(reopened?.status).toBe("open");
      } finally {
        second.state.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
