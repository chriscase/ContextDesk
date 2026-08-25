import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../db/migrate.js";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { adminUrl, withDisposableDb } from "../../test/disposable-db.js";
import { MemoryAuditStore, PgAuditStore } from "../audit/index.js";
import { CaseService, MemoryCaseStore, PgCaseStore } from "../cases/index.js";
import { CatalogService, PgCatalogStore } from "./index.js";

const ALICE = { id: "alice", username: "alice" };
const BOB = { id: "bob", username: "bob" };
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class InjectedFailureStore extends MemoryCaseStore {
  failTimelineKind: string | null = null;
  override async appendTimeline(
    caseId: string,
    event: Parameters<MemoryCaseStore["appendTimeline"]>[1],
  ): Promise<Awaited<ReturnType<MemoryCaseStore["appendTimeline"]>>> {
    if (this.failTimelineKind && event.kind === this.failTimelineKind) {
      throw new Error(`injected timeline failure:${event.kind}`);
    }
    return super.appendTimeline(caseId, event);
  }
}

async function humanSourceFor(catalog: CatalogService, identityId: string) {
  return (await catalog.list()).find((source) => source.identityId === identityId) ?? null;
}

async function harness(store: MemoryCaseStore, audit: MemoryAuditStore = new MemoryAuditStore()) {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-catalog-atomic-"));
  dirs.push(root);
  const evidence = new FilesystemEvidenceStore({ rootDir: root });
  const catalog = new CatalogService(undefined, audit);
  const cases = new CaseService(evidence, audit, store, catalog);
  return { cases, catalog, audit };
}

describe("catalog mutation atomicity", () => {
  it("does not leave a human source when the first contribution timeline fails", async () => {
    const store = new InjectedFailureStore();
    store.failTimelineKind = "contribution_created";
    const { cases, catalog, audit } = await harness(store);
    const created = await cases.createCase(ALICE, { title: "Synthetic catalog atomic fixture" }, "test");
    expect(await humanSourceFor(catalog, ALICE.id)).toBeNull();
    await expect(
      cases.addContribution(
        created.id,
        ALICE,
        { kind: "note", body: "Synthetic timeout observation before catalog mint." },
        "test",
      ),
    ).rejects.toThrow(/injected timeline failure:contribution_created/);
    expect(await cases.listContributions(created.id, ALICE, true)).toEqual([]);
    expect((await cases.listTimeline(created.id)).some((event) => event.kind === "contribution_created")).toBe(
      false,
    );
    expect(await audit.list({ action: "contribution_create" })).toEqual([]);
    expect(await audit.list({ action: "catalog_create" })).toEqual([]);
    expect(await catalog.findByIdentity(ALICE.id)).toBeNull();
    expect(await humanSourceFor(catalog, ALICE.id)).toBeNull();
  });

  it("keeps a concurrent standalone catalog create when a contribution rolls back", async () => {
    const store = new InjectedFailureStore();
    const { cases, catalog, audit } = await harness(store);
    const created = await cases.createCase(ALICE, { title: "Synthetic catalog isolation fixture" }, "test");
    let releaseBob: () => void = () => {};
    const bobGate = new Promise<void>((resolve) => {
      releaseBob = resolve;
    });
    const bobCreated = (async () => {
      await bobGate;
      return catalog.create(
        BOB,
        {
          name: "mailer-timeout-source",
          kind: "internal-system",
          description: "Synthetic mailer timeout ingest.",
        },
        "test",
      );
    })();
    const originalAppend = store.appendTimeline.bind(store);
    store.appendTimeline = async (caseId, event) => {
      if (event.kind === "contribution_created") {
        releaseBob();
        await bobCreated;
        throw new Error("injected timeline failure:contribution_created");
      }
      return originalAppend(caseId, event);
    };
    await expect(
      cases.addContribution(
        created.id,
        ALICE,
        { kind: "note", body: "Synthetic timeout observation before catalog mint." },
        "test",
      ),
    ).rejects.toThrow(/injected timeline failure:contribution_created/);
    const bobSource = await bobCreated;
    expect(await catalog.get(bobSource.id)).not.toBeNull();
    expect(bobSource.name).toBe("mailer-timeout-source");
    expect(await catalog.findByIdentity(ALICE.id)).toBeNull();
    expect(await cases.listContributions(created.id, ALICE, true)).toEqual([]);
    expect(await audit.list({ action: "contribution_create" })).toEqual([]);
    expect((await audit.list({ action: "catalog_create" })).map((row) => row.target)).toEqual([bobSource.id]);
  });

  it("does not leave a human source when the first evidence registration fails", async () => {
    const store = new InjectedFailureStore();
    store.failTimelineKind = "evidence_registered";
    const { cases, catalog, audit } = await harness(store);
    const created = await cases.createCase(ALICE, { title: "Synthetic catalog evidence atomic fixture" }, "test");
    expect(await humanSourceFor(catalog, ALICE.id)).toBeNull();
    await expect(
      cases.addEvidence(
        created.id,
        ALICE,
        {
          kind: "log",
          filename: "mailer.log",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout\n"),
          summary: "Synthetic mailer timeout.",
          privacyClass: "share_safe",
        },
        "test",
      ),
    ).rejects.toThrow(/injected timeline failure:evidence_registered/);
    expect(await cases.listArtifacts(created.id, ALICE, true)).toEqual([]);
    expect(await cases.listContributions(created.id, ALICE, true)).toEqual([]);
    expect((await cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(false);
    expect(await audit.list({ action: "evidence_register" })).toEqual([]);
    expect(await audit.list({ action: "catalog_create" })).toEqual([]);
    expect(await catalog.findByIdentity(ALICE.id)).toBeNull();
  });
});

describe.skipIf(!adminUrl())("postgres catalog mutation atomicity", () => {
  it("rolls back a PostgreSQL human source with the case transaction", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-catalog-atomic-"));
      dirs.push(root);
      class InjectedPgCaseStore extends PgCaseStore {
        failTimelineKind: string | null = null;
        override async appendTimeline(
          caseId: string,
          event: Parameters<PgCaseStore["appendTimeline"]>[1],
        ): Promise<Awaited<ReturnType<PgCaseStore["appendTimeline"]>>> {
          if (this.failTimelineKind && event.kind === this.failTimelineKind) {
            throw new Error(`injected timeline failure:${event.kind}`);
          }
          return super.appendTimeline(caseId, event);
        }
      }
      const caseStore = new InjectedPgCaseStore(pool);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, caseStore, catalog);
      try {
        const created = await cases.createCase(ALICE, { title: "PG catalog atomic fixture" }, "test");
        expect(await humanSourceFor(catalog, ALICE.id)).toBeNull();
        caseStore.failTimelineKind = "contribution_created";
        await expect(
          cases.addContribution(
            created.id,
            ALICE,
            { kind: "note", body: "Synthetic PostgreSQL timeout observation before catalog mint." },
            "test",
          ),
        ).rejects.toThrow(/injected timeline failure:contribution_created/);
        expect(await cases.listContributions(created.id, ALICE, true)).toEqual([]);
        expect((await cases.listTimeline(created.id)).some((event) => event.kind === "contribution_created")).toBe(
          false,
        );
        expect(await audit.list({ action: "contribution_create" })).toEqual([]);
        expect(await audit.list({ action: "catalog_create" })).toEqual([]);
        expect(await catalog.findByIdentity(ALICE.id)).toBeNull();
        expect(await humanSourceFor(catalog, ALICE.id)).toBeNull();
      } finally {
        await pool.end();
      }
    });
  });

  it("keeps a concurrent PostgreSQL catalog create when a contribution rolls back", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-catalog-isolation-"));
      dirs.push(root);
      class InjectedPgCaseStore extends PgCaseStore {
        onContributionCreated?: () => Promise<void>;
        override async appendTimeline(
          caseId: string,
          event: Parameters<PgCaseStore["appendTimeline"]>[1],
        ): Promise<Awaited<ReturnType<PgCaseStore["appendTimeline"]>>> {
          if (event.kind === "contribution_created") {
            await this.onContributionCreated?.();
            throw new Error("injected timeline failure:contribution_created");
          }
          return super.appendTimeline(caseId, event);
        }
      }
      const caseStore = new InjectedPgCaseStore(pool);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, caseStore, catalog);
      try {
        const created = await cases.createCase(ALICE, { title: "PG catalog isolation fixture" }, "test");
        let releaseBob: () => void = () => {};
        const bobGate = new Promise<void>((resolve) => {
          releaseBob = resolve;
        });
        const bobCreated = (async () => {
          await bobGate;
          return catalog.create(
            BOB,
            {
              name: "mailer-timeout-source",
              kind: "internal-system",
              description: "Synthetic mailer timeout ingest.",
            },
            "test",
          );
        })();
        caseStore.onContributionCreated = async () => {
          releaseBob();
          await bobCreated;
        };
        await expect(
          cases.addContribution(
            created.id,
            ALICE,
            { kind: "note", body: "Synthetic PostgreSQL timeout observation before catalog mint." },
            "test",
          ),
        ).rejects.toThrow(/injected timeline failure:contribution_created/);
        const bobSource = await bobCreated;
        expect(await catalog.get(bobSource.id)).not.toBeNull();
        expect(await catalog.findByIdentity(ALICE.id)).toBeNull();
        expect(await cases.listContributions(created.id, ALICE, true)).toEqual([]);
        expect(await audit.list({ action: "contribution_create" })).toEqual([]);
        expect((await audit.list({ action: "catalog_create" })).map((row) => row.target)).toEqual([bobSource.id]);
      } finally {
        await pool.end();
      }
    });
  });

  it("rolls back a PostgreSQL human source when first evidence registration fails", async () => {
    await withDisposableDb(async (client, url) => {
      await migrateUp(client);
      const pool = new Pool({ connectionString: url, max: 4 });
      const root = await mkdtemp(join(tmpdir(), "cd-collab-pg-catalog-evidence-atomic-"));
      dirs.push(root);
      class InjectedPgCaseStore extends PgCaseStore {
        failTimelineKind: string | null = null;
        override async appendTimeline(
          caseId: string,
          event: Parameters<PgCaseStore["appendTimeline"]>[1],
        ): Promise<Awaited<ReturnType<PgCaseStore["appendTimeline"]>>> {
          if (this.failTimelineKind && event.kind === this.failTimelineKind) {
            throw new Error(`injected timeline failure:${event.kind}`);
          }
          return super.appendTimeline(caseId, event);
        }
      }
      const caseStore = new InjectedPgCaseStore(pool);
      const evidence = new FilesystemEvidenceStore({ rootDir: root });
      const audit = new PgAuditStore(pool);
      const catalog = new CatalogService(new PgCatalogStore(pool), audit);
      const cases = new CaseService(evidence, audit, caseStore, catalog);
      try {
        const created = await cases.createCase(ALICE, { title: "PG catalog evidence atomic fixture" }, "test");
        expect(await humanSourceFor(catalog, ALICE.id)).toBeNull();
        caseStore.failTimelineKind = "evidence_registered";
        await expect(
          cases.addEvidence(
            created.id,
            ALICE,
            {
              kind: "log",
              filename: "mailer.log",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode("2026-08-25T00:00:00Z synthetic mailer timeout\n"),
              summary: "Synthetic mailer timeout.",
              privacyClass: "share_safe",
            },
            "test",
          ),
        ).rejects.toThrow(/injected timeline failure:evidence_registered/);
        expect(await cases.listArtifacts(created.id, ALICE, true)).toEqual([]);
        expect((await cases.listTimeline(created.id)).some((event) => event.kind === "evidence_registered")).toBe(
          false,
        );
        expect(await audit.list({ action: "evidence_register" })).toEqual([]);
        expect(await audit.list({ action: "catalog_create" })).toEqual([]);
        expect(await catalog.findByIdentity(ALICE.id)).toBeNull();
      } finally {
        await pool.end();
      }
    });
  });
});
