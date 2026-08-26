import { describe, expect, it } from "vitest";
import { ContractViolation } from "./parse.js";
import {
  parseLogChronologyPage,
  parseLogChronologyQuery,
} from "./investigation-log-chronology.js";

const query = {
  schemaId: "cd-collab.log_chronology_query.v1",
  search: null,
  sources: [],
  limit: 50,
  cursor: null,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    seq: 7,
    source: "worker/batch.log",
    rawTimestamp: "2024-03-10 02:30:00",
    normalizedInstant: null,
    timeState: "order_only",
    timestampProvenance: "unresolved_local",
    orderOnlyReason: "nonexistent_dst_gap",
    level: "warn",
    message: "heartbeat late",
    ...overrides,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.log_chronology_page.v1",
    caseId: "case-synthetic-0001",
    corpusId: "corpus-synthetic-0001",
    corpusRevision: 4,
    search: null,
    sources: [],
    rows: [row()],
    nextCursor: null,
    totalMatched: 1,
    orderOnlyCount: 1,
    timeQuality: "order_only",
    ...overrides,
  };
}

describe("normalized chronology contract", () => {
  it("normalizes literal filters without interpreting wildcard characters", () => {
    const parsed = parseLogChronologyQuery({
      ...query,
      search: "  100%_literal  ",
      sources: ["gateway/edge.log", "worker/batch.log"],
      limit: 0,
    });
    expect(parsed.search).toBe("100%_literal");
    expect(parsed.sources).toEqual(["gateway/edge.log", "worker/batch.log"]);
    expect(parsed.limit).toBe(50);
  });

  it("refuses unknown query fields, traversal, and oversized cursors", () => {
    expect(() =>
      parseLogChronologyQuery({ ...query, unexpected: true }),
    ).toThrow(ContractViolation);
    expect(() =>
      parseLogChronologyQuery({ ...query, sources: ["../outside.log"] }),
    ).toThrow(/traverse upward/);
    expect(() =>
      parseLogChronologyQuery({ ...query, cursor: "x".repeat(2_049) }),
    ).toThrow(/cursor/);
  });

  it("requires an explicit order-only reason and never accepts an instant there", () => {
    expect(() => parseLogChronologyPage(page({ rows: [row({ orderOnlyReason: null })] }))).toThrow(
      /order-only row must say why/,
    );
    expect(() =>
      parseLogChronologyPage(
        page({ rows: [row({ normalizedInstant: "2024-03-10T08:30:00Z" })] }),
      ),
    ).toThrow(/must not carry an instant/);
  });

  it("accepts a resolved local row only when its original text is retained", () => {
    const parsed = parseLogChronologyPage(
      page({
        rows: [
          row({
            rawTimestamp: "2024-03-10 01:30:00",
            normalizedInstant: "2024-03-10T07:30:00Z",
            timeState: "resolved",
            timestampProvenance: "resolved_local",
            orderOnlyReason: null,
          }),
        ],
        totalMatched: 1,
        orderOnlyCount: 0,
        timeQuality: "wall",
      }),
    );
    expect(parsed.rows[0]?.rawTimestamp).toBe("2024-03-10 01:30:00");
    expect(parsed.rows[0]?.source).toBe("worker/batch.log");

    expect(() =>
      parseLogChronologyPage(
        page({
          rows: [
            row({
              normalizedInstant: "2024-03-10T07:30:00Z",
              timeState: "resolved",
              timestampProvenance: "resolved_local",
              rawTimestamp: null,
              orderOnlyReason: null,
            }),
          ],
          totalMatched: 1,
          orderOnlyCount: 0,
          timeQuality: "wall",
        }),
      ),
    ).toThrow(/original timestamp text/);
  });

  it("rejects a page quality summary that disagrees with its counts", () => {
    expect(() => parseLogChronologyPage(page({ timeQuality: "mixed" }))).toThrow(
      /does not match/,
    );
  });

  it("keeps the wire projection free of secret-shaped fields", () => {
    const raw = JSON.stringify(
      parseLogChronologyPage(
        page({
          rows: [row({ message: "redacted marker only" })],
        }),
      ),
    );
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(raw).not.toMatch(/authorization/i);
    expect(raw).not.toMatch(/\/Users\//);
  });
});
