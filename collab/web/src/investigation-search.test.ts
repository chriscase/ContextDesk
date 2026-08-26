import { describe, expect, it } from "vitest";
import {
  ARCHIVED_STATUS,
  DEFAULT_FILTER,
  admitsArchived,
  hiddenArchivedNotice,
  matchesQuery,
  normalizeQuery,
  searchableValues,
  statusCounts,
  visibleInvestigations,
  type InvestigationFilter,
  type SearchableInvestigation,
} from "./investigation-search.js";

function row(overrides: Partial<SearchableInvestigation> = {}): SearchableInvestigation {
  return {
    id: "case-1",
    title: "Checkout timeouts",
    status: "open",
    severity: "high",
    problemStatement: "Synthetic checkout requests time out waiting on inventory.",
    affectedParties: "Fixture storefront operators",
    impact: "Synthetic checkout attempts do not complete.",
    scope: "Checkout-to-inventory calls only.",
    openQuestions: ["Did pool pressure begin before latency rose?"],
    participants: [{ username: "alice" }],
    ...overrides,
  };
}

function filter(overrides: Partial<InvestigationFilter> = {}): InvestigationFilter {
  return { ...DEFAULT_FILTER, ...overrides };
}

describe("search covers what the investigation says about itself", () => {
  it("matches the affected parties a reader would remember it by", () => {
    expect(matchesQuery(row(), normalizeQuery("storefront operators"))).toBe(true);
  });

  it("matches impact, scope, and open questions", () => {
    expect(matchesQuery(row(), normalizeQuery("do not complete"))).toBe(true);
    expect(matchesQuery(row(), normalizeQuery("inventory calls"))).toBe(true);
    expect(matchesQuery(row(), normalizeQuery("pool pressure"))).toBe(true);
  });

  it("matches the problem statement, title, and participants", () => {
    expect(matchesQuery(row(), normalizeQuery("waiting on inventory"))).toBe(true);
    expect(matchesQuery(row(), normalizeQuery("checkout"))).toBe(true);
    expect(matchesQuery(row(), normalizeQuery("alice"))).toBe(true);
  });

  it("matches an involved entity label supplied by the caller", () => {
    expect(matchesQuery(row(), normalizeQuery("northwind"), ["Northwind Trading"])).toBe(true);
    expect(matchesQuery(row(), normalizeQuery("northwind"), [])).toBe(false);
  });

  it("matches a recorded occurrence as the literal text it was written with", () => {
    const historical = row({ occurredAt: "2024-11-04" });
    expect(matchesQuery(historical, normalizeQuery("2024-11"))).toBe(true);
    // No zone is invented to make a partial date comparable.
    expect(matchesQuery(historical, normalizeQuery("2024-11-04T00:00:00Z"))).toBe(false);
  });

  it("still matches a pasted identifier", () => {
    expect(matchesQuery(row({ id: "8f3c-not-a-real-uuid" }), normalizeQuery("8f3c"))).toBe(true);
  });

  it("folds case and ignores surrounding whitespace", () => {
    expect(matchesQuery(row(), normalizeQuery("  CHECKOUT  "))).toBe(true);
  });

  it("treats an empty query as no query", () => {
    expect(normalizeQuery("   ")).toBe("");
    expect(matchesQuery(row(), normalizeQuery("   "))).toBe(true);
  });

  it("matches nothing that is not there", () => {
    expect(matchesQuery(row(), normalizeQuery("payment gateway"))).toBe(false);
  });

  it("skips absent fields without matching an empty string", () => {
    const sparse: SearchableInvestigation = { id: "case-2", title: "Bare" };
    expect(searchableValues(sparse)).toEqual(["Bare", "case-2"]);
    expect(matchesQuery(sparse, normalizeQuery("bare"))).toBe(true);
  });
});

describe("archiving actually removes an investigation from the working list", () => {
  const rows = [
    row({ id: "live", status: "open" }),
    row({ id: "filed", status: ARCHIVED_STATUS }),
  ];

  it("hides archived investigations by default", () => {
    const result = visibleInvestigations(rows, filter());
    expect(result.visible.map((r) => r.id)).toEqual(["live"]);
    expect(result.hiddenArchived).toBe(1);
  });

  it("reveals them when the reader asks", () => {
    const result = visibleInvestigations(rows, filter({ includeArchived: true }));
    expect(result.visible.map((r) => r.id)).toEqual(["live", "filed"]);
    expect(result.hiddenArchived).toBe(0);
  });

  it("shows them when the archived status is selected explicitly", () => {
    const result = visibleInvestigations(rows, filter({ status: ARCHIVED_STATUS }));
    expect(result.visible.map((r) => r.id)).toEqual(["filed"]);
    expect(result.hiddenArchived).toBe(0);
    expect(admitsArchived(filter({ status: ARCHIVED_STATUS }))).toBe(true);
  });

  it("counts as hidden only what the reader was otherwise looking for", () => {
    // An archived case that fails the query is not something archiving hid —
    // reporting it would offer to reveal a row the reader never asked for.
    const unrelated: SearchableInvestigation = {
      id: "filed",
      status: ARCHIVED_STATUS,
      title: "Unrelated mailer backlog",
    };
    const result = visibleInvestigations([unrelated], filter({ query: "checkout" }));
    expect(result.visible).toEqual([]);
    expect(result.hiddenArchived).toBe(0);
  });

  it("never hides anything silently", () => {
    expect(hiddenArchivedNotice(0)).toBeNull();
    expect(hiddenArchivedNotice(1)).toMatch(/1 archived investigation is hidden/);
    expect(hiddenArchivedNotice(4)).toMatch(/4 archived investigations are hidden/);
  });
});

describe("status and entity filters", () => {
  const rows = [
    row({ id: "a", status: "open" }),
    row({ id: "b", status: "monitoring" }),
    row({ id: "c", status: ARCHIVED_STATUS }),
  ];

  it("narrows to one status", () => {
    expect(
      visibleInvestigations(rows, filter({ status: "monitoring" })).visible.map((r) => r.id),
    ).toEqual(["b"]);
  });

  it("narrows to one entity's investigations", () => {
    const members = new Map([["ent-1", new Set(["b"])]]);
    expect(
      visibleInvestigations(rows, filter({ entityId: "ent-1" }), members).visible.map((r) => r.id),
    ).toEqual(["b"]);
  });

  it("narrows to nothing when the entity index is empty", () => {
    expect(visibleInvestigations(rows, filter({ entityId: "ent-1" })).visible).toEqual([]);
  });

  it("counts every status including archived, so the reveal option is not empty", () => {
    const counts = statusCounts(rows, ["open", "monitoring", "resolved", ARCHIVED_STATUS]);
    expect(counts).toEqual([
      ["open", 1],
      ["monitoring", 1],
      ["resolved", 0],
      [ARCHIVED_STATUS, 1],
    ]);
  });

  it("appends a status the wire reported but this build does not know", () => {
    const counts = statusCounts([row({ status: "escalated" })], ["open"]);
    expect(counts).toContainEqual(["escalated", 1]);
  });
});

describe("filters compose", () => {
  it("applies query, status, entity, and archived visibility together", () => {
    const rows = [
      row({ id: "a", status: "open", affectedParties: "Northwind" }),
      row({ id: "b", status: ARCHIVED_STATUS, affectedParties: "Northwind" }),
      row({ id: "c", status: "open", affectedParties: "Contoso" }),
    ];
    const members = new Map([["ent-1", new Set(["a", "b"])]]);
    const narrow = visibleInvestigations(
      rows,
      filter({ query: "northwind", entityId: "ent-1" }),
      members,
    );
    expect(narrow.visible.map((r) => r.id)).toEqual(["a"]);
    expect(narrow.hiddenArchived).toBe(1);

    const wide = visibleInvestigations(
      rows,
      filter({ query: "northwind", entityId: "ent-1", includeArchived: true }),
      members,
    );
    expect(wide.visible.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("preserves the order it was given", () => {
    const rows = [row({ id: "z" }), row({ id: "a" }), row({ id: "m" })];
    expect(visibleInvestigations(rows, filter()).visible.map((r) => r.id)).toEqual(["z", "a", "m"]);
  });
});
