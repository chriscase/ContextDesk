/**
 * Log workbench host-timestamp overlay at realistic scale.
 *
 * The overlay used to be a synchronous scan over every (line, stamp) pair. At
 * the 50,000-line read limit that blocked the event loop for minutes, so one
 * investigation's Log workbench read stalled every other request on the box.
 * These tests pin the properties that made the rewrite safe to ship: it stays
 * inside a time budget at the read cap, it lets an unrelated request through
 * while it runs, it refuses a corpus whose revision moved underneath it, and it
 * produces nothing at all when it is cancelled or the host is down.
 *
 * Everything here is synthetic: invented batch workers, invented edge gateways,
 * generated log text, and a scripted host. No provider, no network, no private
 * data.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKBENCH_LIMITS } from "@cd-collab/contracts";
import { MemoryAuditStore } from "../audit/index.js";
import { MemoryWorkbenchStore } from "./store.js";
import {
  WorkbenchCancelledError,
  WorkbenchConflictError,
  WorkbenchService,
  type WorkbenchCasePort,
  type WorkbenchEvidenceFile,
  type WorkbenchHostStamps,
} from "./service.js";

const CASE_BIG = "11111111-1111-4111-8111-111111111111";
const CASE_SMALL = "77777777-7777-4777-8777-777777777777";
const ACTOR = { id: "analyst-synthetic-01", username: "analyst-synthetic-01" };
const CAP = WORKBENCH_LIMITS.maxSearchWorkLines;

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A synthetic corpus carrying every timestamp shape the overlay must survive
 * side by side: an explicit UTC offset, a bare local calendar time with no
 * zone, and a line with no parsable timestamp at all. Duplicate text is
 * deliberate — several lines share one body, which is what forces the join to
 * respect host order rather than matching whichever copy it saw first.
 */
function syntheticLog(lineCount: number, marker: string): string {
  const rows: string[] = [];
  for (let i = 0; i < lineCount; i += 1) {
    const bucket = i % 4;
    if (bucket === 0) {
      rows.push(
        `2024-03-10T07:${String(i % 60).padStart(2, "0")}:00Z INFO ${marker} edge accepted request rid-${i}`,
      );
    } else if (bucket === 1) {
      rows.push(
        `2024-03-10 0${(i % 9) + 1}:${String(i % 60).padStart(2, "0")}:00 WARN ${marker} batch worker heartbeat late shard=${i}`,
      );
    } else if (bucket === 2) {
      rows.push(`operator note: ${marker} lane stalled, no clock on this line`);
    } else {
      rows.push(`${marker} repeated shard flush`);
    }
  }
  rows.push("");
  return rows.join("\n");
}

function evidenceFile(
  evidenceId: string,
  relativePath: string,
  text: string,
): WorkbenchEvidenceFile {
  return {
    evidenceId,
    relativePath,
    digest: digest(text),
    intakeBatchId: null,
    privacyClass: "owner_only",
    text,
  };
}

/**
 * Stamps a host would return for such a corpus: some anchored on a real local
 * timestamp, some on real text, and a large block that matches nothing because
 * the corpus already reads correctly. The non-matching block is the expensive
 * case — every one of them had to be compared against every line.
 */
function syntheticStamps(count: number, marker: string): WorkbenchHostStamps["stamps"] {
  const stamps: WorkbenchHostStamps["stamps"] = [];
  for (let i = 0; i < count; i += 1) {
    if (i % 5 === 0) {
      stamps.push({
        source: `worker/${marker}.log`,
        message: `${marker} batch worker heartbeat late shard=${(i * 4) + 1}`,
        ts: 1_710_048_600 + i,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: `2024-03-10 0${(((i * 4) + 1) % 9) + 1}:${String(((i * 4) + 1) % 60).padStart(2, "0")}:00`,
      });
    } else {
      stamps.push({
        source: `worker/${marker}.log`,
        message: `unrelated host event ordinal=${i} kind=heartbeat`,
        ts: 1_710_000_000 + i,
        timeQuality: "wall clock",
        unresolvedLocalTimestamp: null,
      });
    }
  }
  return stamps;
}

interface CaseFixture {
  files: WorkbenchEvidenceFile[];
  host: WorkbenchHostStamps | null;
}

interface HarnessOptions {
  cases: Record<string, CaseFixture>;
  /** Thrown by the next host read, then cleared — a host that fell over. */
  hostFailure?: { error: Error | null };
  /** Observes host reads, so a test can move a revision mid-flight. */
  onHostRead?: (caseId: string) => void | Promise<void>;
}

function harness(options: HarnessOptions) {
  const hostReads: string[] = [];
  const cases: WorkbenchCasePort = {
    async getCase(id) {
      return options.cases[id] ? { id } : null;
    },
    async listEvidenceFiles(id) {
      return options.cases[id]?.files ?? [];
    },
    async currentNormalizationRevision(id) {
      return options.cases[id]?.host?.corpusRevision ?? null;
    },
    async listHostEventStamps(id) {
      hostReads.push(id);
      if (options.hostFailure?.error) {
        const error = options.hostFailure.error;
        options.hostFailure.error = null;
        throw error;
      }
      await options.onHostRead?.(id);
      return options.cases[id]?.host ?? null;
    },
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline() {
      return undefined;
    },
  };
  const service = new WorkbenchService({
    store: new MemoryWorkbenchStore(),
    cases,
    audit: new MemoryAuditStore(),
  });
  return { service, hostReads };
}

function searchBody(query: string, expectedNormalizationRevision: number | null) {
  return {
    schemaId: "cd-collab.log_workbench_search_request.v1",
    query,
    mode: "case_insensitive",
    filters: {
      includeTerms: [],
      excludeTerms: [],
      severity: null,
      component: null,
      file: null,
      rotationFamily: null,
      timeFrom: null,
      timeTo: null,
      evidenceIds: [],
    },
    contextBefore: 0,
    contextAfter: 0,
    cursor: 0,
    limit: 20,
    expectedNormalizationRevision,
  };
}

function bigCase(marker = "alpha", revision = 4): CaseFixture {
  return {
    files: [evidenceFile("ev-big", `worker/${marker}.log`, syntheticLog(CAP, marker))],
    host: { corpusRevision: revision, stamps: syntheticStamps(2_000, marker) },
  };
}

function smallCase(marker = "beta", revision = 2): CaseFixture {
  return {
    files: [evidenceFile("ev-small", `worker/${marker}.log`, syntheticLog(40, marker))],
    host: { corpusRevision: revision, stamps: syntheticStamps(8, marker) },
  };
}

// ---------------------------------------------------------------------------
// Scale and responsiveness
// ---------------------------------------------------------------------------

describe("overlay at the read cap", () => {
  /**
   * The regression budget.
   *
   * The shipped join needed roughly 100 seconds of blocking work for this
   * input. 30 seconds is two orders of magnitude above what the indexed join
   * costs on a developer machine, which keeps this from flaking on a loaded CI
   * runner while still failing hard if the join ever goes quadratic again.
   *
   * Reproduce with:
   *   npm run test -w @cd-collab/server -- workbench-overlay
   */
  const BUDGET_MS = 30_000;

  it(`overlays ${CAP.toLocaleString("en-US")} lines against 2,000 stamps within ${BUDGET_MS} ms`, async () => {
    const { service } = harness({ cases: { [CASE_BIG]: bigCase() } });
    const started = process.hrtime.bigint();
    const result = await service.search(CASE_BIG, ACTOR, false, searchBody("heartbeat", 4));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
    expect(result.expectedNormalizationRevision).toBe(4);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("keeps every timestamp class honest across the whole corpus", async () => {
    const { service } = harness({ cases: { [CASE_BIG]: bigCase() } });
    const inventory = await service.inventory(CASE_BIG, ACTOR, false);
    expect(inventory.items[0]?.lineCount).toBe(CAP);

    // The host offered 400 stamps carrying a heartbeat message. They are
    // claimed by the earliest 400 heartbeat lines, in host order.
    const early = await service.page(CASE_BIG, ACTOR, false, "ev-big", 1, 200);
    const earlyLocal = early.rows.filter((row) => row.text.includes("heartbeat late"));
    expect(earlyLocal.length).toBeGreaterThan(0);
    expect(earlyLocal.every((row) => row.normalizedUtc !== null)).toBe(true);

    const late = await service.page(CASE_BIG, ACTOR, false, "ev-big", 45_000, 200);

    // Past the point where the host ran out of stamps, a bare local calendar
    // time keeps its own text and gains no clock. Guessing one here is exactly
    // the failure the overlay exists to prevent.
    const lateLocal = late.rows.filter((row) => row.text.includes("heartbeat late"));
    expect(lateLocal.length).toBeGreaterThan(0);
    expect(lateLocal.every((row) => row.normalizedUtc === null)).toBe(true);
    expect(lateLocal.every((row) => row.originalTimestamp !== null)).toBe(true);
    expect(lateLocal.every((row) => row.parseClass === "local_ambiguous")).toBe(true);

    // A line with an explicit offset already knows its instant and does not
    // need the host to tell it one.
    const explicit = late.rows.filter((row) => row.text.includes("edge accepted"));
    expect(explicit.length).toBeGreaterThan(0);
    expect(explicit.every((row) => row.normalizedUtc !== null)).toBe(true);

    // A line with no parsable timestamp never acquires one. `splitLogText`
    // keeps the raw line as `originalTimestamp` and calls it unparsable; the
    // overlay must leave both alone rather than promote it to an instant.
    const unparsable = late.rows.filter((row) => row.text.includes("lane stalled"));
    expect(unparsable.length).toBeGreaterThan(0);
    expect(unparsable.every((row) => row.normalizedUtc === null)).toBe(true);
    expect(unparsable.every((row) => row.parseClass === "unparsable")).toBe(true);
    expect(unparsable.every((row) => row.originalTimestamp === row.text)).toBe(true);
  });

  it("never lets one stamp claim more than one duplicate line", async () => {
    const text = ["dup shard flush", "dup shard flush", "dup shard flush", ""].join("\n");
    const { service } = harness({
      cases: {
        [CASE_SMALL]: {
          files: [evidenceFile("ev-dup", "worker/dup.log", text)],
          host: {
            corpusRevision: 1,
            stamps: [
              {
                source: "worker/dup.log",
                message: "dup shard flush",
                ts: 1_710_000_100,
                timeQuality: "wall clock",
                unresolvedLocalTimestamp: null,
              },
            ],
          },
        },
      },
    });
    const page = await service.page(CASE_SMALL, ACTOR, false, "ev-dup", 1, 10);
    const stamped = page.rows.filter((row) => row.normalizedUtc !== null);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.lineNumber).toBe(1);
    // The rows the stamp did not claim keep their own identity and order.
    expect(page.rows.map((row) => row.lineNumber)).toEqual([1, 2, 3]);
  });

  it("does not stall an unrelated investigation's read", async () => {
    const { service } = harness({
      cases: { [CASE_BIG]: bigCase(), [CASE_SMALL]: smallCase() },
    });
    const order: string[] = [];
    const big = service
      .search(CASE_BIG, ACTOR, false, searchBody("heartbeat", 4))
      .then((result) => {
        order.push("big");
        return result;
      });
    const small = service
      .search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 2))
      .then((result) => {
        order.push("small");
        return result;
      });
    const [bigResult, smallResult] = await Promise.all([big, small]);

    // The small investigation must finish first. Under the shipped join the
    // large overlay held the loop to completion and this was impossible.
    expect(order).toEqual(["small", "big"]);
    expect(smallResult.matches.length).toBeGreaterThan(0);
    expect(bigResult.matches.length).toBeGreaterThan(0);
    // Neither read borrowed the other's revision.
    expect(smallResult.expectedNormalizationRevision).toBe(2);
    expect(bigResult.expectedNormalizationRevision).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Revision discipline
// ---------------------------------------------------------------------------

describe("revision discipline", () => {
  it("refuses a read whose expected revision is already stale", async () => {
    const { service } = harness({ cases: { [CASE_SMALL]: smallCase() } });
    await expect(
      service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 1)),
    ).rejects.toBeInstanceOf(WorkbenchConflictError);
  });

  it("refuses to publish rows from a revision that moved during the read", async () => {
    const fixture = smallCase();
    const { service } = harness({
      cases: { [CASE_SMALL]: fixture },
      // A zone is applied while the corpus read is in flight: the host answers
      // with the newer revision, so the rows describe a timeline the caller did
      // not ask for.
      onHostRead: () => {
        fixture.host = { corpusRevision: 9, stamps: fixture.host?.stamps ?? [] };
      },
    });
    await expect(
      service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 2)),
    ).rejects.toBeInstanceOf(WorkbenchConflictError);
  });

  it("reports the revision the returned rows actually reflect", async () => {
    const { service } = harness({ cases: { [CASE_SMALL]: smallCase("beta", 6) } });
    const result = await service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", null));
    expect(result.expectedNormalizationRevision).toBe(6);
    const chronology = await service.chronology(CASE_SMALL, ACTOR, false, "file", []);
    expect(chronology.expectedNormalizationRevision).toBe(6);
    const queue = await service.reviewQueue(CASE_SMALL, ACTOR, false);
    expect(queue.normalizationRevision).toBe(6);
    const inventory = await service.inventory(CASE_SMALL, ACTOR, false);
    expect(inventory.normalizationRevision).toBe(6);
  });

  it("falls back to the durable revision when the case has no host corpus", async () => {
    const { service } = harness({
      cases: {
        [CASE_SMALL]: {
          files: [evidenceFile("ev-none", "worker/none.log", syntheticLog(12, "none"))],
          host: null,
        },
      },
    });
    const result = await service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", null));
    expect(result.expectedNormalizationRevision).toBeNull();
    // With no host corpus nothing may claim a local line's clock.
    for (const row of result.matches) {
      expect(row.normalizedUtc).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Cancellation and host failure
// ---------------------------------------------------------------------------

describe("giving up cleanly", () => {
  it("cancels mid-overlay and returns nothing at all", async () => {
    const { service } = harness({ cases: { [CASE_BIG]: bigCase() } });
    const signal = { aborted: false };
    const reading = service.search(CASE_BIG, ACTOR, false, searchBody("heartbeat", 4), { signal });
    // Let the overlay start, then hang up the way a closed connection does.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    signal.aborted = true;
    await expect(reading).rejects.toBeInstanceOf(WorkbenchCancelledError);
  });

  it("still serves the next reader after a cancelled read", async () => {
    const { service } = harness({ cases: { [CASE_SMALL]: smallCase() } });
    await expect(
      service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 2), {
        signal: { aborted: true },
      }),
    ).rejects.toBeInstanceOf(WorkbenchCancelledError);
    const after = await service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 2));
    expect(after.matches.length).toBeGreaterThan(0);
  });

  it("fails closed when the host is down, and recovers when it restarts", async () => {
    const hostFailure = { error: new Error("log-time host operation failed") as Error | null };
    const { service, hostReads } = harness({
      cases: { [CASE_SMALL]: smallCase() },
      hostFailure,
    });
    // A host that fell over must not yield a corpus with the overlay silently
    // missing — that would read as "this case has no host timestamps".
    await expect(
      service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 2)),
    ).rejects.toThrow(/host/);

    const recovered = await service.search(CASE_SMALL, ACTOR, false, searchBody("heartbeat", 2));
    expect(hostReads).toHaveLength(2);
    expect(recovered.matches.some((row) => row.normalizedUtc !== null)).toBe(true);
  });
});
