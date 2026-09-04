import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CASE_LIST_SCHEMA_ID,
  CASE_SCHEMA_ID,
  ContractViolation,
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  parseInvestigationCollectionPage,
  parseInvestigationCollectionQuery,
  type CaseV1,
} from "@cd-collab/contracts";
import { describe, expect, it, vi } from "vitest";
import { FilesystemEvidenceStore } from "../../evidence/store.js";
import { MemoryAuditStore } from "../audit/index.js";
import { CatalogService } from "../catalog/index.js";
import {
  createInvestigationCollectionGraph,
  MemoryInvestigationCollectionGraph,
} from "./collection-graph.js";
import {
  CollectionQueryError,
  buildInvestigationCollectionPage,
  collectionQueryFromHttp,
  collectionQueryFingerprint,
  requestsInvestigationCollectionPage,
} from "./collection-query.js";
import { CaseService } from "./service.js";
import { MemoryCaseStore, type CaseRow } from "./store.js";

const ALICE = { id: "identity-alice", username: "alice" };
const EVE = { id: "identity-eve", username: "eve" };
const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CASE_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CASE_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const IMPACT = {
  productName: "Fixture Desk",
  version: "4.2",
  build: "",
  component: "queue-worker",
  environment: "",
};

function query(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof parseInvestigationCollectionQuery> {
  return parseInvestigationCollectionQuery({
    schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
    ...overrides,
  });
}

function row(overrides: Partial<CaseRow> & Pick<CaseRow, "id" | "title" | "createdAt">): CaseRow {
  return {
    severity: "medium",
    status: "open",
    legalHold: false,
    retentionClass: "standard",
    createdBy: ALICE.id,
    createdByUsername: ALICE.username,
    participants: [{ identityId: ALICE.id, username: ALICE.username }],
    problemStatement: "",
    affectedParties: "",
    impact: "",
    scope: "",
    openQuestions: [],
    situationVersion: 0,
    investigationContext: null,
    occurredAt: null,
    ...overrides,
  };
}

function toCase(item: CaseRow): CaseV1 {
  return {
    schemaId: CASE_SCHEMA_ID,
    id: item.id,
    title: item.title,
    problemStatement: item.problemStatement ?? "",
    affectedParties: item.affectedParties ?? "",
    impact: item.impact ?? "",
    scope: item.scope ?? "",
    openQuestions: item.openQuestions ? [...item.openQuestions] : [],
    situationVersion: item.situationVersion ?? 0,
    investigationContext: item.investigationContext ?? null,
    occurredAt: item.occurredAt ?? null,
    occurredAtPrecision: item.occurredAtPrecision ?? "unknown",
    occurredAtZone: item.occurredAtZone ?? "unspecified",
    severity: item.severity,
    status: item.status,
    legalHold: item.legalHold,
    retentionClass: item.retentionClass,
    participants: item.participants.map((participant) => ({ ...participant })),
    createdAt: item.createdAt,
    createdBy: item.createdBy,
  };
}

async function withService(
  fn: (ctx: {
    service: CaseService;
    store: MemoryCaseStore;
    graph: MemoryInvestigationCollectionGraph;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cd-collab-collection-query-"));
  const store = new MemoryCaseStore();
  const graph = new MemoryInvestigationCollectionGraph();
  const service = new CaseService(
    new FilesystemEvidenceStore({ rootDir: root }),
    new MemoryAuditStore(),
    store,
    new CatalogService(),
  );
  service.bindCollectionGraph(graph);
  try {
    await fn({ service, store, graph });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("collection query HTTP adapter", () => {
  it("returns an immutable empty graph snapshot without invoking loaders", async () => {
    const loadEntities = vi.fn(async () => []);
    const loadImpacts = vi.fn(async () => []);
    const provider = createInvestigationCollectionGraph({ loadEntities, loadImpacts });

    const snapshot = await provider.snapshot([]);

    expect(loadEntities).not.toHaveBeenCalled();
    expect(loadImpacts).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.entitiesFor(CASE_A)).toEqual([]);
    expect(snapshot.impactsFor(CASE_A)).toEqual([]);
    expect(Object.isFrozen(snapshot.entitiesFor(CASE_A))).toBe(true);
    expect(Object.isFrozen(snapshot.impactsFor(CASE_A))).toBe(true);
  });

  it("materializes graph data only for the membership-authorized investigation set", async () => {
    const loadEntities = vi.fn(async () => [
      { caseId: CASE_A, entityId: "ent-visible", label: "Visible service" },
      { caseId: CASE_B, entityId: "ent-hidden", label: "Hidden service" },
    ]);
    const provider = createInvestigationCollectionGraph({ loadEntities });
    const snapshot = await provider.snapshot([CASE_A]);
    expect(loadEntities).toHaveBeenCalledWith([CASE_A]);
    expect(snapshot.entitiesFor(CASE_A)).toEqual([
      { entityId: "ent-visible", label: "Visible service" },
    ]);
    expect(snapshot.entitiesFor(CASE_B)).toEqual([]);
  });

  it("coerces a GET query into the frozen parser without casts", () => {
    const parsed = parseInvestigationCollectionQuery(
      collectionQueryFromHttp({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        q: "  storefront  ",
        status: ["open", "monitoring"],
        includeArchived: "true",
        entityId: "ent-northwind",
        impactIdentity: JSON.stringify(IMPACT),
        contributorId: "identity-alice",
        recordedFrom: "2026-01-01T00:00:00.000Z",
        recordedTo: "2026-08-26T00:00:00.000Z",
        limit: "25",
      }),
    );
    expect(parsed.q).toBe("storefront");
    expect(parsed.status).toEqual(["open", "monitoring"]);
    expect(parsed.includeArchived).toBe(true);
    expect(parsed.entityId).toBe("ent-northwind");
    expect(parsed.impactIdentity).toEqual(IMPACT);
    expect(parsed.limit).toBe(25);
  });

  it("treats a repeated status query param as the status array", () => {
    const parsed = parseInvestigationCollectionQuery(
      collectionQueryFromHttp({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        status: "open",
      }),
    );
    expect(parsed.status).toEqual(["open"]);
  });

  it("opts into the collection page only when schemaId is present", () => {
    expect(requestsInvestigationCollectionPage({})).toBe(false);
    expect(requestsInvestigationCollectionPage({ q: "checkout" })).toBe(false);
    expect(
      requestsInvestigationCollectionPage({ schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID }),
    ).toBe(true);
  });
});

describe("collection query service and store", () => {
  it("returns a valid filtered page from membership-filtered store rows", async () => {
    await withService(async ({ service, store, graph }) => {
      const open = row({
        id: CASE_A,
        title: "Synthetic checkout investigation",
        affectedParties: "Fixture storefront operators",
        createdAt: "2026-08-26T00:00:00.000Z",
      });
      const other = row({
        id: CASE_B,
        title: "Unrelated mailer timeout",
        createdAt: "2026-08-25T00:00:00.000Z",
        status: "monitoring",
      });
      await store.insertCase(open);
      await store.insertCase(other);
      graph.linkEntity(CASE_A, "ent-northwind", "Northwind");
      graph.recordImpact(CASE_A, IMPACT);

      const page = await service.listCollectionPage(
        ALICE,
        false,
        query({
          q: "storefront",
          status: ["open"],
          entityId: "ent-northwind",
          impactIdentity: IMPACT,
          contributorId: ALICE.id,
          recordedFrom: "2026-08-01T00:00:00.000Z",
          recordedTo: "2026-08-31T00:00:00.000Z",
        }),
      );
      const parsed = parseInvestigationCollectionPage(page);
      expect(parsed.schemaId).toBe(INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID);
      expect(parsed.items.map((item) => item.id)).toEqual([CASE_A]);
      expect(parsed.nextCursor).toBeNull();
      expect(parsed).not.toHaveProperty("rank");
      expect(parsed).not.toHaveProperty("urgency");
      expect(parsed.facets.impactIdentity.top[0]?.identity).toEqual(IMPACT);
    });
  });

  it("distinguishes an empty authorized set from a filtered-empty page", async () => {
    await withService(async ({ service, store }) => {
      const empty = await service.listCollectionPage(ALICE, false, query({ q: "checkout" }));
      expect(empty.items).toEqual([]);
      expect(empty.hiddenArchivedCount).toBe(0);
      expect(empty.facets.status.top.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0]);
      expect(empty.facets.contributor.top).toEqual([]);

      await store.insertCase(
        row({
          id: CASE_A,
          title: "Synthetic checkout investigation",
          createdAt: "2026-08-26T00:00:00.000Z",
        }),
      );
      const filteredEmpty = await service.listCollectionPage(
        ALICE,
        false,
        query({ q: "no-such-token" }),
      );
      expect(filteredEmpty.items).toEqual([]);
      expect(filteredEmpty.hiddenArchivedCount).toBe(0);
      expect(filteredEmpty.facets.status.top).toEqual(
        expect.arrayContaining([{ key: "open", count: 1 }]),
      );
      expect(filteredEmpty.facets.contributor.top).toEqual([{ key: ALICE.id, count: 1 }]);
    });
  });

  it("reports archived matches hidden by default and reveals them when asked", async () => {
    await withService(async ({ service, store }) => {
      await store.insertCase(
        row({
          id: CASE_A,
          title: "Live checkout",
          createdAt: "2026-08-26T00:00:00.000Z",
        }),
      );
      await store.insertCase(
        row({
          id: CASE_B,
          title: "Archived checkout",
          status: "archived",
          createdAt: "2026-08-25T00:00:00.000Z",
        }),
      );
      await store.insertCase(
        row({
          id: CASE_C,
          title: "Unrelated archived mailer",
          status: "archived",
          createdAt: "2026-08-24T00:00:00.000Z",
        }),
      );

      const hidden = await service.listCollectionPage(ALICE, false, query({ q: "checkout" }));
      expect(hidden.items.map((item) => item.id)).toEqual([CASE_A]);
      expect(hidden.hiddenArchivedCount).toBe(1);
      expect(hidden.facets.status.top.find((bucket) => bucket.key === "archived")?.count).toBe(2);

      const shown = await service.listCollectionPage(
        ALICE,
        false,
        query({ q: "checkout", includeArchived: true }),
      );
      expect(shown.items.map((item) => item.id)).toEqual([CASE_A, CASE_B]);
      expect(shown.hiddenArchivedCount).toBe(0);

      const explicit = await service.listCollectionPage(
        ALICE,
        false,
        query({ status: ["archived"] }),
      );
      expect(explicit.items.map((item) => item.id).sort()).toEqual([CASE_B, CASE_C].sort());
      expect(explicit.hiddenArchivedCount).toBe(0);
    });
  });

  it("keeps facets on the authorized set and conceals non-member cases at the store boundary", async () => {
    await withService(async ({ service, store, graph }) => {
      await store.insertCase(
        row({
          id: CASE_A,
          title: "Alice checkout",
          createdAt: "2026-08-26T00:00:00.000Z",
        }),
      );
      await store.insertCase(
        row({
          id: CASE_B,
          title: "Eve private mailer",
          createdAt: "2026-08-25T00:00:00.000Z",
          createdBy: EVE.id,
          createdByUsername: EVE.username,
          participants: [{ identityId: EVE.id, username: EVE.username }],
        }),
      );
      graph.linkEntity(CASE_A, "ent-northwind", "Northwind");
      graph.linkEntity(CASE_B, "ent-contoso", "Contoso");
      graph.recordImpact(CASE_B, IMPACT);

      const listed = await store.listCases();
      expect(listed.map((item) => item.id).sort()).toEqual([CASE_A, CASE_B].sort());

      const page = await service.listCollectionPage(ALICE, false, query());
      expect(page.items.map((item) => item.id)).toEqual([CASE_A]);
      expect(page.facets.entity.top.map((bucket) => bucket.key)).toEqual(["ent-northwind"]);
      expect(page.facets.contributor.top.map((bucket) => bucket.key)).toEqual([ALICE.id]);
      expect(page.facets.impactIdentity.top).toEqual([]);
      expect(JSON.stringify(page)).not.toContain(CASE_B);
      expect(JSON.stringify(page)).not.toContain("ent-contoso");
      expect(JSON.stringify(page)).not.toContain(EVE.id);
    });
  });

  it("pages with a query-bound actor-bound cursor without repeating or skipping", async () => {
    await withService(async ({ service, store }) => {
      await store.insertCase(
        row({ id: CASE_A, title: "One", createdAt: "2026-08-26T00:00:00.000Z" }),
      );
      await store.insertCase(
        row({ id: CASE_B, title: "Two", createdAt: "2026-08-25T00:00:00.000Z" }),
      );
      await store.insertCase(
        row({ id: CASE_C, title: "Three", createdAt: "2026-08-24T00:00:00.000Z" }),
      );
      await store.insertCase(
        row({ id: CASE_D, title: "Four", createdAt: "2026-08-23T00:00:00.000Z" }),
      );

      const first = await service.listCollectionPage(ALICE, false, query({ limit: 2 }));
      expect(first.items.map((item) => item.id)).toEqual([CASE_A, CASE_B]);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await service.listCollectionPage(
        ALICE,
        false,
        query({ limit: 2, cursor: first.nextCursor }),
      );
      expect(second.items.map((item) => item.id)).toEqual([CASE_C, CASE_D]);
      expect(second.nextCursor).toBeNull();

      const seen = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(4);

      await expect(
        service.listCollectionPage(
          EVE,
          false,
          query({ limit: 2, cursor: first.nextCursor }),
        ),
      ).rejects.toBeInstanceOf(CollectionQueryError);
      await expect(
        service.listCollectionPage(
          ALICE,
          false,
          query({ q: "Two", limit: 2, cursor: first.nextCursor }),
        ),
      ).rejects.toMatchObject({ code: "stale_cursor" });
    });
  });

  it("fails closed on malformed and unknown query or cursor values", async () => {
    await withService(async ({ service, store }) => {
      await store.insertCase(
        row({ id: CASE_A, title: "Checkout", createdAt: "2026-08-26T00:00:00.000Z" }),
      );
      expect(() =>
        parseInvestigationCollectionQuery(
          collectionQueryFromHttp({
            schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
            extra: true,
          }),
        ),
      ).toThrow(/unknown key/);
      expect(() =>
        parseInvestigationCollectionQuery(
          collectionQueryFromHttp({
            schemaId: CASE_LIST_SCHEMA_ID,
          }),
        ),
      ).toThrow(ContractViolation);
      await expect(
        service.listCollectionPage(ALICE, false, query({ cursor: "not-a-cursor" })),
      ).rejects.toMatchObject({ code: "malformed_cursor" });

      await store.insertCase(
        row({ id: CASE_B, title: "Second checkout", createdAt: "2026-08-25T00:00:00.000Z" }),
      );
      const first = await service.listCollectionPage(ALICE, false, query({ limit: 1 }));
      expect(first.nextCursor).toEqual(expect.any(String));
      await store.updateCaseMeta({ id: CASE_A, status: "archived" });
      await expect(
        service.listCollectionPage(ALICE, false, query({ limit: 1, cursor: first.nextCursor })),
      ).rejects.toMatchObject({ code: "stale_cursor" });
    });
  });

  it("does not invent ranking and keeps fingerprints stable across status order", () => {
    const left = collectionQueryFingerprint(query({ status: ["monitoring", "open"] }));
    const right = collectionQueryFingerprint(query({ status: ["open", "monitoring"] }));
    expect(left).toBe(right);
    const page = buildInvestigationCollectionPage({
      authorized: [
        row({ id: CASE_A, title: "Checkout", createdAt: "2026-08-26T00:00:00.000Z" }),
      ],
      query: query(),
      actor: ALICE,
      isAdmin: false,
      graph: null,
      toCase,
    });
    expect(page).not.toHaveProperty("completeness");
    expect(page.facets.status.top.map((bucket) => bucket.key)).toEqual([
      "open",
      "monitoring",
      "resolved",
      "archived",
    ]);
  });
});
