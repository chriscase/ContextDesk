import { describe, expect, it } from "vitest";
import { CASE_LIST_SCHEMA_ID, parseCaseList } from "./case.js";
import { ContractViolation } from "./parse.js";
import {
  INVESTIGATION_COLLECTION_LIMITS,
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  parseInvestigationCollectionPage,
  parseInvestigationCollectionQuery,
} from "./investigation-collection-browser.js";

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPAQUE_CURSOR = "eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0";

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.case.v1",
    id: CASE_A,
    title: "Synthetic checkout investigation",
    problemStatement: "Checkout waits on inventory.",
    affectedParties: "Fixture storefront operators",
    impact: "Synthetic checkout attempts do not complete.",
    scope: "Checkout-to-inventory calls only.",
    openQuestions: ["Did pool pressure begin before latency rose?"],
    situationVersion: 1,
    investigationContext: null,
    occurredAt: null,
    occurredAtPrecision: "unknown",
    occurredAtZone: "unspecified",
    severity: "medium",
    status: "open",
    legalHold: false,
    retentionClass: "standard",
    participants: [{ identityId: "identity-alice", username: "alice" }],
    createdAt: "2026-08-26T00:00:00.000Z",
    createdBy: "identity-alice",
    ...overrides,
  };
}

function emptyFacet() {
  return { top: [] as Array<{ key: string; count: number }>, otherCount: 0 };
}

function facets(overrides: Record<string, unknown> = {}) {
  return {
    status: {
      top: [
        { key: "open", count: 2 },
        { key: "monitoring", count: 1 },
        { key: "resolved", count: 0 },
        { key: "archived", count: 1 },
      ],
      otherCount: 0,
    },
    entity: {
      top: [{ key: "ent-northwind", count: 2 }],
      otherCount: 3,
    },
    impactIdentity: {
      top: [{ key: "Fixture Desk · 4.2 · queue-worker", count: 1 }],
      otherCount: 4,
    },
    contributor: {
      top: [{ key: "identity-alice", count: 2 }],
      otherCount: 1,
    },
    ...overrides,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items: [caseRow()],
    nextCursor: null,
    hiddenArchivedCount: 1,
    facets: facets(),
    ...overrides,
  };
}

describe("investigation collection query", () => {
  it("parses a valid default query", () => {
    const parsed = parseInvestigationCollectionQuery({
      schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
    });
    expect(parsed).toEqual({
      schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
      q: "",
      status: [],
      includeArchived: false,
      entityId: null,
      impactIdentity: null,
      contributorId: null,
      recordedFrom: null,
      recordedTo: null,
      cursor: null,
      limit: INVESTIGATION_COLLECTION_LIMITS.defaultLimit,
    });
  });

  it("parses a valid full query", () => {
    const parsed = parseInvestigationCollectionQuery({
      schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
      q: "  storefront operators  ",
      status: ["open", "monitoring"],
      includeArchived: true,
      entityId: "ent-northwind",
      impactIdentity: {
        productName: "Fixture Desk",
        version: "4.2",
        build: "",
        component: "queue-worker",
        environment: "",
      },
      contributorId: "identity-alice",
      recordedFrom: "2026-01-01T00:00:00.000Z",
      recordedTo: "2026-08-26T00:00:00.000Z",
      cursor: OPAQUE_CURSOR,
      limit: 25,
    });
    expect(parsed.q).toBe("storefront operators");
    expect(parsed.status).toEqual(["open", "monitoring"]);
    expect(parsed.includeArchived).toBe(true);
    expect(parsed.entityId).toBe("ent-northwind");
    expect(parsed.impactIdentity).toEqual({
      productName: "Fixture Desk",
      version: "4.2",
      build: "",
      component: "queue-worker",
      environment: "",
    });
    expect(parsed.contributorId).toBe("identity-alice");
    expect(parsed.recordedFrom).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.recordedTo).toBe("2026-08-26T00:00:00.000Z");
    expect(parsed.cursor).toBe(OPAQUE_CURSOR);
    expect(parsed.limit).toBe(25);
  });

  it("parses a valid filtered query without ranking fields", () => {
    const parsed = parseInvestigationCollectionQuery({
      schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
      q: "checkout",
      status: ["archived"],
      includeArchived: false,
    });
    expect(parsed.q).toBe("checkout");
    expect(parsed.status).toEqual(["archived"]);
    expect(parsed.includeArchived).toBe(false);
    expect(parsed).not.toHaveProperty("sort");
    expect(parsed).not.toHaveProperty("urgency");
    expect(parsed).not.toHaveProperty("completeness");
  });

  it("treats limit 0 as the bounded default", () => {
    expect(
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        limit: 0,
      }).limit,
    ).toBe(INVESTIGATION_COLLECTION_LIMITS.defaultLimit);
  });

  it("rejects malformed queries, unknown keys, and the wrong version", () => {
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        extra: true,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: "cd-collab.investigation_collection_query.v2",
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: CASE_LIST_SCHEMA_ID,
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        status: "open",
      }),
    ).toThrow(/expected array/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        status: ["all"],
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        includeArchived: "yes",
      }),
    ).toThrow(/expected boolean/);
  });

  it("rejects out-of-bounds query text, limit, cursor, and recorded range", () => {
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        q: "x".repeat(INVESTIGATION_COLLECTION_LIMITS.maxQueryChars + 1),
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        q: "checkout\nwith a second line",
      }),
    ).toThrow(/single line/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        limit: INVESTIGATION_COLLECTION_LIMITS.maxLimit + 1,
      }),
    ).toThrow(/page size exceeds cap/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        limit: -1,
      }),
    ).toThrow(/unsigned safe integer/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        cursor: "short",
      }),
    ).toThrow(/opaque cursor/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        cursor: "not/a/cursor",
      }),
    ).toThrow(/opaque cursor/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        recordedFrom: "2024-11-04",
      }),
    ).toThrow(/ISO-8601 instant/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        recordedFrom: "2026-08-26T00:00:00.000Z",
        recordedTo: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/range end/);
  });

  it("rejects duplicate status filters and empty impact identities", () => {
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        status: ["open", "open"],
      }),
    ).toThrow(/duplicate status/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        impactIdentity: {
          productName: "",
          version: "",
          build: "",
          component: "",
          environment: "",
        },
      }),
    ).toThrow(/at least one/);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
        entityId: "../outside",
      }),
    ).toThrow(/bounded identity token/);
  });
});

describe("investigation collection page", () => {
  it("parses a page of CaseV1 items and keeps the cursor opaque", () => {
    const parsed = parseInvestigationCollectionPage(page({ nextCursor: OPAQUE_CURSOR }));
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.id).toBe(CASE_A);
    expect(parsed.items[0]?.status).toBe("open");
    expect(parsed.nextCursor).toBe(OPAQUE_CURSOR);
    expect(parsed.hiddenArchivedCount).toBe(1);
    expect(parsed.facets.status.top.map((bucket) => bucket.key)).toEqual([
      "open",
      "monitoring",
      "resolved",
      "archived",
    ]);
  });

  it("parses an empty filtered page without inventing ranking", () => {
    const parsed = parseInvestigationCollectionPage(
      page({
        items: [],
        nextCursor: null,
        hiddenArchivedCount: 0,
        facets: {
          status: emptyFacet(),
          entity: emptyFacet(),
          impactIdentity: emptyFacet(),
          contributor: emptyFacet(),
        },
      }),
    );
    expect(parsed.items).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.hiddenArchivedCount).toBe(0);
    expect(parsed).not.toHaveProperty("rank");
    expect(parsed).not.toHaveProperty("completeness");
  });

  it("parses a filtered page that withholds archived matches", () => {
    const parsed = parseInvestigationCollectionPage(
      page({
        items: [caseRow({ id: CASE_B, status: "monitoring", title: "Northwind inventory" })],
        hiddenArchivedCount: 2,
        facets: facets({
          entity: { top: [{ key: "ent-northwind", count: 1 }], otherCount: 0 },
        }),
      }),
    );
    expect(parsed.items.map((item) => item.id)).toEqual([CASE_B]);
    expect(parsed.hiddenArchivedCount).toBe(2);
    expect(parsed.facets.entity.top).toEqual([{ key: "ent-northwind", count: 1 }]);
  });

  it("reuses CaseV1 parsing for item fields and unknown keys", () => {
    expect(() =>
      parseInvestigationCollectionPage(
        page({ items: [caseRow({ investigationContext: { productName: "Fixture", tags: ["later"] } })] }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseInvestigationCollectionPage(page({ items: [caseRow({ schemaId: "cd-collab.case.v2" })] })),
    ).toThrow(ContractViolation);
  });

  it("rejects malformed envelopes, the wrong version, and current list documents", () => {
    expect(() => parseInvestigationCollectionPage(page({ extra: true }))).toThrow(/unknown key/);
    expect(() =>
      parseInvestigationCollectionPage(page({ schemaId: "cd-collab.investigation_collection_page.v2" })),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationCollectionPage({
        schemaId: CASE_LIST_SCHEMA_ID,
        cases: [caseRow()],
      }),
    ).toThrow(ContractViolation);
    expect(() => parseInvestigationCollectionPage(page({ nextCursor: "not/a/cursor" }))).toThrow(
      /opaque cursor/,
    );
    expect(() => parseInvestigationCollectionPage(page({ hiddenArchivedCount: -1 }))).toThrow(
      /unsigned safe integer/,
    );
  });

  it("rejects pages that exceed the item cap", () => {
    const items = Array.from({ length: INVESTIGATION_COLLECTION_LIMITS.maxLimit + 1 }, (_, index) =>
      caseRow({ id: `case-${String(index).padStart(3, "0")}` }),
    );
    expect(() => parseInvestigationCollectionPage(page({ items }))).toThrow(/at most/);
  });

  it("rejects negative and duplicate facet counts and keeps families isolated", () => {
    expect(() =>
      parseInvestigationCollectionPage(
        page({
          facets: facets({
            entity: { top: [{ key: "ent-northwind", count: -1 }], otherCount: 0 },
          }),
        }),
      ),
    ).toThrow(/unsigned safe integer/);
    expect(() =>
      parseInvestigationCollectionPage(
        page({
          facets: facets({
            contributor: {
              top: [
                { key: "identity-alice", count: 2 },
                { key: "identity-alice", count: 1 },
              ],
              otherCount: 0,
            },
          }),
        }),
      ),
    ).toThrow(/duplicate facet count identity/);
    expect(() =>
      parseInvestigationCollectionPage(
        page({
          facets: facets({
            status: { top: [{ key: "ent-northwind", count: 1 }], otherCount: 0 },
          }),
        }),
      ),
    ).toThrow(/recorded case status/);
    const isolated = parseInvestigationCollectionPage(
      page({
        facets: facets({
          entity: { top: [{ key: "open", count: 1 }], otherCount: 0 },
          status: { top: [{ key: "open", count: 1 }], otherCount: 0 },
        }),
      }),
    );
    expect(isolated.facets.entity.top[0]?.key).toBe("open");
    expect(isolated.facets.status.top[0]?.key).toBe("open");
    expect(isolated.facets.impactIdentity.top[0]?.key).toContain("Fixture Desk");
    expect(isolated.facets.contributor.top[0]?.key).toBe("identity-alice");
  });

  it("rejects duplicate case and participant identities", () => {
    expect(() =>
      parseInvestigationCollectionPage(page({ items: [caseRow(), caseRow()] })),
    ).toThrow(/duplicate case identity/);
    expect(() =>
      parseInvestigationCollectionPage(
        page({
          items: [
            caseRow({
              participants: [
                { identityId: "identity-alice", username: "alice" },
                { identityId: "identity-alice", username: "Alice" },
              ],
            }),
          ],
        }),
      ),
    ).toThrow(/duplicate participant identity/);
  });

  it("leaves the current case list envelope compatible and distinct", () => {
    const listed = parseCaseList({
      schemaId: CASE_LIST_SCHEMA_ID,
      cases: [caseRow({ id: "case-synthetic-1" })],
    });
    expect(listed.cases[0]?.id).toBe("case-synthetic-1");
    expect(() => parseInvestigationCollectionPage(listed)).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationCollectionQuery({
        schemaId: CASE_LIST_SCHEMA_ID,
        cases: listed.cases,
      }),
    ).toThrow(ContractViolation);
  });
});
