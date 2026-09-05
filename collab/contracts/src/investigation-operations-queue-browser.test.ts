import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASE_SCHEMA_ID } from "./case.js";
import {
  INVESTIGATION_COLLECTION_LIMITS,
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
} from "./investigation-collection-browser.js";
import { INVESTIGATION_COORDINATION_SCHEMA_ID } from "./investigation-coordination.js";
import {
  INVESTIGATION_OPERATIONS_QUEUE_COORDINATION_SCOPES,
  INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
  INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
  parseInvestigationOperationsQueuePage,
  parseInvestigationOperationsQueueQuery,
} from "./investigation-operations-queue-browser.js";
import { ContractViolation } from "./parse.js";

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPAQUE_CURSOR = "eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0";

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: CASE_SCHEMA_ID,
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

function coordination(
  investigationId = CASE_A,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaId: INVESTIGATION_COORDINATION_SCHEMA_ID,
    investigationId,
    coordinator: null,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    archived: false,
    ...overrides,
  };
}

function emptyFacet() {
  return { top: [], otherCount: 0 };
}

function facets() {
  return {
    status: { top: [{ key: "open", count: 2 }], otherCount: 0 },
    entity: { top: [{ key: "ent-northwind", count: 1 }], otherCount: 1 },
    impactIdentity: emptyFacet(),
    contributor: { top: [{ key: "identity-alice", count: 1 }], otherCount: 1 },
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: INVESTIGATION_OPERATIONS_QUEUE_PAGE_SCHEMA_ID,
    items: [{ investigation: caseRow(), coordination: coordination() }],
    nextCursor: null,
    hiddenArchivedCount: 1,
    facets: facets(),
    coordinationScopeCounts: { allVisible: 5, mine: 2, unassigned: 2 },
    ...overrides,
  };
}

describe("investigation operations queue query", () => {
  it("defaults to all-visible while preserving normalized collection defaults", () => {
    expect(
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
      }),
    ).toEqual({
      schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
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
      coordinationScope: "all_visible",
    });
  });

  it("normalizes the inherited filters and round-trips an opaque cursor", () => {
    const parsed = parseInvestigationOperationsQueueQuery({
      schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
      q: "  checkout operators  ",
      status: ["open", "monitoring"],
      includeArchived: true,
      entityId: "ent-northwind",
      impactIdentity: {
        productName: " Fixture Desk ",
        version: "4.2",
        build: "",
        component: "queue-worker",
        environment: "",
      },
      contributorId: "identity-alice",
      recordedFrom: "2026-01-01T00:00:00.000Z",
      recordedTo: "2026-08-26T00:00:00.000Z",
      limit: 25,
      coordinationScope: "mine",
    });
    expect(parsed.q).toBe("checkout operators");
    expect(parsed.impactIdentity?.productName).toBe("Fixture Desk");
    expect(parsed.coordinationScope).toBe("mine");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.status)).toBe(true);
    expect(Object.isFrozen(parsed.impactIdentity)).toBe(true);
    expect(
      parseInvestigationOperationsQueueQuery({ ...parsed, cursor: OPAQUE_CURSOR }),
    ).toEqual({ ...parsed, cursor: OPAQUE_CURSOR });
  });

  it("accepts exactly the three non-ranking coordination scopes", () => {
    expect(
      INVESTIGATION_OPERATIONS_QUEUE_COORDINATION_SCOPES.map(
        (coordinationScope) =>
          parseInvestigationOperationsQueueQuery({
            schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
            coordinationScope,
          }).coordinationScope,
      ),
    ).toEqual(["all_visible", "mine", "unassigned"]);
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        coordinationScope: "assigned_to",
      }),
    ).toThrow(ContractViolation);
    for (const forbiddenField of [
      "coordinatorIdentityId",
      "coordinatorId",
      "rank",
      "priority",
      "sla",
      "lease",
      "presence",
      "autoAssign",
    ]) {
      expect(() =>
        parseInvestigationOperationsQueueQuery({
          schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
          coordinationScope: "mine",
          [forbiddenField]: "forbidden",
        }),
      ).toThrow(/unknown key/);
    }
  });

  it("rejects unknown keys, wrong schemas, inherited bounds, and malformed cursors", () => {
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        extra: true,
      }),
    ).toThrow(/unknown key/);
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
      }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        q: "x".repeat(INVESTIGATION_COLLECTION_LIMITS.maxQueryChars + 1),
      }),
    ).toThrow(/exceeds/);
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        limit: INVESTIGATION_COLLECTION_LIMITS.maxLimit + 1,
      }),
    ).toThrow(/page size exceeds cap/);
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        cursor: "not/a/cursor",
      }),
    ).toThrow(/opaque cursor/);
    expect(() =>
      parseInvestigationOperationsQueueQuery({
        schemaId: INVESTIGATION_OPERATIONS_QUEUE_QUERY_SCHEMA_ID,
        status: ["open", "open"],
      }),
    ).toThrow(/duplicate status/);
  });
});

describe("investigation operations queue page", () => {
  it("parses joined authoritative rows, facets, counts, and an opaque cursor", () => {
    const parsed = parseInvestigationOperationsQueuePage(
      page({ nextCursor: OPAQUE_CURSOR }),
    );
    expect(parsed.items[0]?.investigation.id).toBe(CASE_A);
    expect(parsed.items[0]?.coordination.investigationId).toBe(CASE_A);
    expect(parsed.nextCursor).toBe(OPAQUE_CURSOR);
    expect(parsed.coordinationScopeCounts).toEqual({
      allVisible: 5,
      mine: 2,
      unassigned: 2,
    });
    expect(parsed.facets.entity.top[0]?.key).toBe("ent-northwind");
  });

  it("accepts matching archived state and an empty visible page", () => {
    const archived = parseInvestigationOperationsQueuePage(
      page({
        items: [
          {
            investigation: caseRow({ status: "archived" }),
            coordination: coordination(CASE_A, { archived: true }),
          },
        ],
      }),
    );
    expect(archived.items[0]?.coordination.archived).toBe(true);
    const empty = parseInvestigationOperationsQueuePage(
      page({
        items: [],
        hiddenArchivedCount: 0,
        coordinationScopeCounts: { allVisible: 0, mine: 0, unassigned: 0 },
      }),
    );
    expect(empty.items).toEqual([]);
  });

  it("rejects cross-object identity, archive, and duplicate-case contradictions", () => {
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({ items: [{ investigation: caseRow(), coordination: coordination(CASE_B) }] }),
      ),
    ).toThrow(/row investigation identity/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({
          items: [
            {
              investigation: caseRow({ status: "archived" }),
              coordination: coordination(CASE_A),
            },
          ],
        }),
      ),
    ).toThrow(/authoritative investigation archived state/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({
          items: [
            { investigation: caseRow(), coordination: coordination() },
            { investigation: caseRow(), coordination: coordination() },
          ],
        }),
      ),
    ).toThrow(/duplicate case identity/);
  });

  it("rejects invalid counts, unknown nested fields, and wrong schemas", () => {
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({ coordinationScopeCounts: { allVisible: 2, mine: 2, unassigned: 1 } }),
      ),
    ).toThrow(/disjoint subsets/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({ coordinationScopeCounts: { allVisible: 0, mine: 0, unassigned: 0 } }),
      ),
    ).toThrow(/cover every visible row/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({ coordinationScopeCounts: { allVisible: 1, mine: 0, unassigned: 0 } }),
      ),
    ).toThrow(/cover every returned unassigned row/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({ coordinationScopeCounts: { allVisible: 5, mine: -1, unassigned: 2 } }),
      ),
    ).toThrow(/unsigned safe integer/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({
          items: [
            {
              investigation: caseRow(),
              coordination: coordination(),
              leaseExpiresAt: "2026-08-26T00:00:00.000Z",
            },
          ],
        }),
      ),
    ).toThrow(/unknown key/);
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({ schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID }),
      ),
    ).toThrow(ContractViolation);
    expect(() =>
      parseInvestigationOperationsQueuePage(page({ nextCursor: "not/a/cursor" })),
    ).toThrow(/opaque cursor/);
    const tooManyItems = Array.from(
      { length: INVESTIGATION_COLLECTION_LIMITS.maxLimit + 1 },
      (_, index) => {
        const id = `case-${String(index).padStart(3, "0")}`;
        return {
          investigation: caseRow({ id }),
          coordination: coordination(id),
        };
      },
    );
    expect(() =>
      parseInvestigationOperationsQueuePage(
        page({
          items: tooManyItems,
          coordinationScopeCounts: {
            allVisible: tooManyItems.length,
            mine: 0,
            unassigned: tooManyItems.length,
          },
        }),
      ),
    ).toThrow(/at most/);
  });

  it("rejects an oversized page before parsing any nested row", () => {
    const malformedItems = Array.from(
      { length: INVESTIGATION_COLLECTION_LIMITS.maxLimit + 1 },
      () => null,
    );
    try {
      parseInvestigationOperationsQueuePage(
        page({
          items: malformedItems,
          coordinationScopeCounts: {
            allVisible: malformedItems.length,
            mine: 0,
            unassigned: malformedItems.length,
          },
        }),
      );
      throw new Error("expected the oversized page to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolation);
      expect(error).toMatchObject({ path: "$.items" });
      expect((error as ContractViolation).detail).toMatch(/at most/);
    }
  });

  it("does not count an assigned returned row as unassigned", () => {
    const assigned = coordination(CASE_A, {
      coordinator: { identityId: "identity-alice", username: "alice" },
      revision: 1,
      updatedAt: "2026-09-04T08:30:00-05:00",
      updatedBy: { identityId: "identity-alice", username: "alice" },
    });
    const parsed = parseInvestigationOperationsQueuePage(
      page({
        items: [{ investigation: caseRow(), coordination: assigned }],
        coordinationScopeCounts: { allVisible: 1, mine: 1, unassigned: 0 },
      }),
    );
    expect(parsed.coordinationScopeCounts.unassigned).toBe(0);
    expect(parsed.items[0]?.coordination.coordinator?.identityId).toBe("identity-alice");
  });

  it("returns detached, deeply frozen normalized values", () => {
    const input = page();
    const parsed = parseInvestigationOperationsQueuePage(input);
    const inputRecord = input.items[0] as {
      investigation: { title: string; participants: Array<{ username: string }> };
    };
    inputRecord.investigation.title = "Mutated input";
    inputRecord.investigation.participants[0]!.username = "mutated";
    expect(parsed.items[0]?.investigation.title).toBe("Synthetic checkout investigation");
    expect(parsed.items[0]?.investigation.participants[0]?.username).toBe("alice");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.investigation.participants)).toBe(true);
    expect(Object.isFrozen(parsed.facets.entity.top)).toBe(true);
    expect(Object.isFrozen(parsed.coordinationScopeCounts)).toBe(true);
  });

  it("keeps the browser leaf transport-free and the older contracts distinct", () => {
    const source = readFileSync(
      new URL("./investigation-operations-queue-browser.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/server\//);
    expect(() =>
      parseInvestigationOperationsQueuePage({
        schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
        items: [],
        nextCursor: null,
        hiddenArchivedCount: 0,
        facets: facets(),
      }),
    ).toThrow(ContractViolation);
  });
});
