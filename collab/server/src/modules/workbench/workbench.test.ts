/**
 * Log workbench service. Search, views, bookmarks, locators, and chronology
 * over synthetic intake bytes. No host, no provider, no private data.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryAuditStore } from "../audit/index.js";
import { MemoryWorkbenchStore } from "./store.js";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchService,
  type WorkbenchCasePort,
  type WorkbenchEvidenceFile,
} from "./service.js";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CASE = "99999999-9999-4999-8999-999999999999";
const EVIDENCE_A = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_B = "55555555-5555-4555-8555-555555555555";
const ACTOR = { id: "analyst-synthetic-01", username: "analyst-synthetic-01" };
const STRANGER = { id: "viewer-synthetic-02", username: "viewer-synthetic-02" };

const GATEWAY = [
  "2024-03-10T07:30:00Z INFO  edge accepted request rid-0001",
  "2024-03-10T07:45:00Z INFO  edge accepted request rid-0002",
  "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
  "",
].join("\n");

const WORKER = [
  "2024-03-10 01:30:00 INFO  batch worker starting scheduled sweep",
  "2024-03-10 02:30:00 WARN  batch worker heartbeat late",
  "2024-03-10 03:05:00 ERROR batch worker sweep failed retry 1",
  "",
].join("\n");

const HTML_NAME = '<img src=x onerror=alert(1)>.log';
const HTML_BODY = '<script>alert("xss")</script> not a log line\n';

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function file(
  evidenceId: string,
  relativePath: string,
  text: string,
): WorkbenchEvidenceFile {
  return {
    evidenceId,
    relativePath,
    digest: digest(text),
    intakeBatchId: "66666666-6666-4666-8666-666666666666",
    privacyClass: "owner_only",
    text,
  };
}

function harness(options: {
  files?: WorkbenchEvidenceFile[];
  revision?: number | null;
  store?: MemoryWorkbenchStore;
  hostStamps?: {
    source: string;
    message: string;
    ts: number;
    timeQuality: string;
    unresolvedLocalTimestamp: string | null;
  }[];
} = {}) {
  const store = options.store ?? new MemoryWorkbenchStore();
  const timeline: { kind: string; targetId: string | null }[] = [];
  const cases: WorkbenchCasePort = {
    async getCase(id, actor) {
      if (id !== CASE_ID) return null;
      if (actor.id === STRANGER.id) return null;
      return { id };
    },
    async listEvidenceFiles() {
      return (
        options.files ?? [
          file(EVIDENCE_A, "gateway/edge.log", GATEWAY),
          file(EVIDENCE_B, "worker/batch.log", WORKER),
        ]
      );
    },
    async currentNormalizationRevision() {
      return options.revision === undefined ? 3 : options.revision;
    },
    async listHostEventStamps() {
      return options.hostStamps ?? null;
    },
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline(_caseId, event) {
      timeline.push({ kind: event.kind, targetId: event.targetId });
      return undefined;
    },
  };
  const service = new WorkbenchService({
    store,
    cases,
    audit: new MemoryAuditStore(),
  });
  return { service, store, timeline };
}

const SEARCH = {
  schemaId: "cd-collab.log_workbench_search_request.v1",
  query: "timeout",
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
  contextBefore: 1,
  contextAfter: 0,
  cursor: 0,
  limit: 50,
  expectedNormalizationRevision: 3,
};

describe("host corpus overlay", () => {
  it("uses wall-clock host stamps after timezone apply, not Date.parse on local text", async () => {
    const withoutHost = harness({ revision: 1 });
    const local = await withoutHost.service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "heartbeat",
      expectedNormalizationRevision: 1,
    });
    expect(local.matches[0]?.normalizedUtc).toBeNull();

    const applied = harness({
      revision: 2,
      hostStamps: [
        {
          source: "worker/batch.log",
          message: "heartbeat late",
          ts: 1_710_048_600,
          timeQuality: "wall clock",
          unresolvedLocalTimestamp: "2024-03-10 02:30:00",
        },
      ],
    });
    const after = await applied.service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "heartbeat",
      expectedNormalizationRevision: 2,
    });
    expect(after.matches[0]?.normalizedUtc).toBe(new Date(1_710_048_600 * 1000).toISOString());
    const chrono = await applied.service.chronology(CASE_ID, ACTOR, false, "file", []);
    expect(chrono.events.some((event) => event.normalizedUtc?.startsWith("2024-"))).toBe(true);
  });

  it("pins a chronology line as a benchmark without calling it ground truth", async () => {
    const { service } = harness();
    const pin = await service.pinChronologyAnchor(CASE_ID, ACTOR, false, {
      evidenceId: EVIDENCE_A,
      lineNumber: 1,
      status: "pinned",
      note: "",
      idempotencyKey: "anchor-edge-1-pinned",
    });
    expect(pin.status).toBe("pinned");
    const chrono = await service.chronology(CASE_ID, ACTOR, false, "file", []);
    expect(
      chrono.events.find((event) => event.lineNumber === 1 && event.relativePath.includes("edge"))
        ?.anchorStatus,
    ).toBe("pinned");
    await expect(
      service.pinChronologyAnchor(CASE_ID, ACTOR, false, {
        evidenceId: EVIDENCE_A,
        lineNumber: 1,
        status: "human_ground_truth",
        note: "",
        idempotencyKey: "anchor-edge-1-truth",
      }),
    ).rejects.toBeInstanceOf(WorkbenchConflictError);
  });
});

describe("workbench search", () => {
  it("returns the expected timeout line with an honest count", async () => {
    const { service } = harness();
    const result = await service.search(CASE_ID, ACTOR, false, SEARCH);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.text).toContain("upstream timeout");
    expect(result.matches[0]?.text).toContain("rid-0003");
    expect(result.bounded).toBe(false);
    expect(result.atLeast).toBe(1);
  });

  it("keeps HTML-looking names and payloads as inert text", async () => {
    const { service } = harness({
      files: [file(EVIDENCE_A, HTML_NAME, HTML_BODY)],
      revision: 0,
    });
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "<script>",
      mode: "literal",
      expectedNormalizationRevision: 0,
    });
    expect(result.matches[0]?.relativePath).toBe(HTML_NAME);
    expect(result.matches[0]?.text).toContain("<script>alert");
  });

  it("fails closed on a stale normalization revision", async () => {
    const { service } = harness({ revision: 4 });
    await expect(service.search(CASE_ID, ACTOR, false, SEARCH)).rejects.toBeInstanceOf(
      WorkbenchConflictError,
    );
  });

  it("does not guess a zone to satisfy a time range on local timestamps", async () => {
    const { service } = harness();
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "heartbeat",
      filters: {
        ...SEARCH.filters,
        timeFrom: "2024-03-10T07:00:00.000Z",
        timeTo: "2024-03-10T09:00:00.000Z",
      },
    });
    expect(result.matches).toHaveLength(0);
    expect(result.timeFilterUnknownReason).toMatch(/normalized timestamp/);
  });

  it("refuses a case the actor cannot read", async () => {
    const { service } = harness();
    await expect(service.search(CASE_ID, STRANGER, false, SEARCH)).rejects.toBeInstanceOf(
      WorkbenchNotFoundError,
    );
    await expect(service.search(OTHER_CASE, ACTOR, false, SEARCH)).rejects.toBeInstanceOf(
      WorkbenchNotFoundError,
    );
  });
});

describe("workbench saved views", () => {
  const viewBody = {
    name: "Timeout window, two panes",
    filters: SEARCH.filters,
    query: "timeout",
    mode: "case_insensitive",
    selectedPanes: [EVIDENCE_A, EVIDENCE_B],
    timeFrom: "2024-03-10T07:00:00.000Z",
    timeTo: "2024-03-10T09:00:00.000Z",
    sort: "time_asc",
    grouping: "file",
    display: {
      syncScroll: true,
      wrap: false,
      lineNumbers: true,
      displayTimezone: "UTC",
    },
    contextBefore: 1,
    contextAfter: 1,
    idempotencyKey: "view-timeout-0001",
  };

  it("round-trips a saved view and replays an identical retry", async () => {
    const { service, timeline } = harness();
    const first = await service.saveView(CASE_ID, ACTOR, false, viewBody);
    expect(first.replayed).toBe(false);
    expect(first.selectedPanes).toHaveLength(2);
    const replay = await service.saveView(CASE_ID, ACTOR, false, viewBody);
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(timeline.filter((event) => event.kind === "log_workbench_view_saved")).toHaveLength(1);
    const listed = await service.listViews(CASE_ID, ACTOR, false);
    expect(listed).toHaveLength(1);
  });

  it("leaves no view when the metadata write fails", async () => {
    const store = new MemoryWorkbenchStore();
    store.failNextWrite = new Error("forced write failure");
    const { service, timeline } = harness({ store });
    await expect(service.saveView(CASE_ID, ACTOR, false, viewBody)).rejects.toThrow(
      /forced write failure/,
    );
    expect(await service.listViews(CASE_ID, ACTOR, false)).toEqual([]);
    expect(timeline).toEqual([]);
  });
});

describe("workbench bookmarks and locators", () => {
  it("binds a bookmark to digest+line and explains a stale locator", async () => {
    const { service } = harness();
    const inventory = await service.inventory(CASE_ID, ACTOR, false);
    const edge = inventory.items.find((item) => item.relativePath === "gateway/edge.log");
    const page = await service.page(CASE_ID, ACTOR, false, EVIDENCE_A, 3, 1);
    const bookmark = await service.saveBookmark(CASE_ID, ACTOR, false, {
      locator: {
        evidenceId: EVIDENCE_A,
        digestAtBind: edge?.digest,
        byteOffset: page.rows[0]?.byteOffset,
        lineNumber: 3,
        originalTimestamp: page.rows[0]?.originalTimestamp ?? null,
        normalizedUtc: page.rows[0]?.normalizedUtc ?? null,
        corpusRevision: 3,
      },
      note: "Timeout line",
      idempotencyKey: "bookmark-timeout-0001",
    });
    expect(bookmark.status).toBe("resolved");
    const replay = await service.saveBookmark(CASE_ID, ACTOR, false, {
      locator: bookmark.locator,
      note: "Timeout line",
      idempotencyKey: "bookmark-timeout-0001",
    });
    expect(replay.replayed).toBe(true);

    const mutated = harness({
      files: [file(EVIDENCE_A, "gateway/edge.log", `${GATEWAY}extra\n`)],
    });
    await mutated.store.insertBookmark({
      id: bookmark.id,
      caseId: CASE_ID,
      evidenceId: EVIDENCE_A,
      payloadJson: JSON.stringify(bookmark),
      shareSafeToken: bookmark.shareSafeToken,
      idempotencyKey: "bookmark-timeout-0002",
      requestDigest: "b".repeat(64),
      privacyClass: "owner_only",
      createdAt: bookmark.createdAt,
      createdBy: ACTOR.id,
    });
    const listed = await mutated.service.listBookmarks(CASE_ID, ACTOR, false);
    expect(listed[0]?.status).toBe("stale");
    expect(listed[0]?.staleReason).toMatch(/was not moved/);
  });

  it("resolves a share-safe token for an authorized reader and 404s otherwise", async () => {
    const { service } = harness();
    const page = await service.page(CASE_ID, ACTOR, false, EVIDENCE_A, 1, 1);
    const inventory = await service.inventory(CASE_ID, ACTOR, false);
    const bookmark = await service.saveBookmark(CASE_ID, ACTOR, false, {
      locator: {
        evidenceId: EVIDENCE_A,
        digestAtBind: inventory.items[0]?.digest,
        byteOffset: page.rows[0]?.byteOffset,
        lineNumber: 1,
        originalTimestamp: page.rows[0]?.originalTimestamp ?? null,
        normalizedUtc: page.rows[0]?.normalizedUtc ?? null,
        corpusRevision: 3,
      },
      note: "",
      idempotencyKey: "bookmark-first-0001",
    });
    const ok = await service.resolveLocator(
      {
        schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
        token: bookmark.shareSafeToken,
      },
      ACTOR,
      false,
    );
    expect(ok.found).toBe(true);
    expect(ok.status).toBe("resolved");
    expect(ok.relativePath).toBe("gateway/edge.log");

    const denied = await service.resolveLocator(
      {
        schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
        token: bookmark.shareSafeToken,
      },
      STRANGER,
      false,
    );
    expect(denied).toEqual(
      await service.resolveLocator(
        {
          schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
          token: "c".repeat(64),
        },
        ACTOR,
        false,
      ),
    );
    expect(denied.found).toBe(false);
    expect(denied.relativePath).toBeNull();
    expect(denied.investigationId).toBeNull();
  });
});

describe("chronology and review queue", () => {
  it("groups ambiguous local times without assigning a zone", async () => {
    const { service } = harness();
    const queue = await service.reviewQueue(CASE_ID, ACTOR, false);
    expect(queue.candidateCount).toBeGreaterThan(0);
    expect(queue.groups.some((group) => group.key === "worker/batch.log")).toBe(true);
    const preview = await service.previewRule(CASE_ID, ACTOR, false, {
      schemaId: "cd-collab.log_time_review_rule.v1",
      scope: "rotation_family",
      source: null,
      rotationFamily: "worker/batch.log",
      selectedEvidenceIds: [],
      ianaTimezone: "America/Chicago",
      expectedRevision: 3,
      idempotencyKey: "rule-worker-family-0001",
    });
    expect(preview.affectedRelativePaths).toEqual(["worker/batch.log"]);
    expect(preview.affectedRelativePaths).not.toContain("gateway/edge.log");
  });

  it("merges a chronology and keeps unknowns in buckets", async () => {
    const { service } = harness();
    const chronology = await service.chronology(CASE_ID, ACTOR, false, "file", []);
    expect(chronology.events.length).toBeGreaterThan(0);
    expect(chronology.unknownBuckets.some((bucket) => bucket.category === "timezone")).toBe(true);
    expect(chronology.events.some((event) => event.correlationKind === "observed_identifier")).toBe(
      true,
    );
  });

  it("pages a file without returning the rest of the corpus", async () => {
    const { service } = harness();
    const page = await service.page(CASE_ID, ACTOR, false, EVIDENCE_A, 1, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.nextStartLine).toBe(3);
    expect(page.rows.every((row) => row.evidenceId === EVIDENCE_A)).toBe(true);
  });
});

/**
 * A page limit is real; a corpus limit was not. A responder must never be told
 * "no matches" about a corpus the workbench stopped reading part-way through:
 * that is a confident false negative on exactly the question they opened the
 * workbench to answer. Every line the reader selected is now reachable, and a
 * page that stopped early says where it stopped instead of where it gave up.
 */
describe("a corpus larger than one page stays reachable, and says how far it got", () => {
  const filler = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => `line ${from + index} filler`).join("\n");

  it("reaches a match past the old read boundary by advancing the page cursor", async () => {
    const oversized = `${filler(50_000)}\nthe needle is here\n`;
    const { service } = harness({
      files: [file(EVIDENCE_A, "big/app.log", oversized)],
    });
    const first = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "needle",
    });
    // The first page spends its work budget without reaching the needle. That
    // is a bounded page, not a truncated corpus: it hands back a position.
    expect(first.returned).toBe(0);
    expect(first.bounded).toBe(true);
    expect(first.corpusTruncated).toBe(false);
    expect(first.coverageComplete).toBe(false);
    expect(first.scannedLines).toBe(50_000);
    expect(first.nextPageCursor).not.toBeNull();

    const second = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "needle",
      pageCursor: first.nextPageCursor,
    });
    expect(second.returned).toBe(1);
    expect(second.matches[0]?.lineNumber).toBe(50_001);
    expect(second.matches[0]?.text).toContain("the needle is here");
    expect(second.coverageComplete).toBe(true);
    expect(second.corpusTruncated).toBe(false);
    expect(second.nextPageCursor).toBeNull();
    expect(second.scannedLinesTotal).toBe(50_001);
  });

  it("reads a selected file that lies entirely past the old boundary, first", async () => {
    const { service } = harness({
      files: [
        file(EVIDENCE_A, "a-big/app.log", filler(120_000)),
        file(EVIDENCE_B, "b-small/app.log", "the needle is here\n"),
      ],
    });
    // Selecting the small file narrows the read before a byte is spent on the
    // large one, so the match is on the first page rather than four pages in.
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "needle",
      filters: { ...SEARCH.filters, evidenceIds: [EVIDENCE_B] },
    });
    expect(result.returned).toBe(1);
    expect(result.scopeFileCount).toBe(1);
    expect(result.scannedLines).toBe(1);
    expect(result.coverageComplete).toBe(true);
    expect(result.corpusTruncated).toBe(false);
  });

  it("counts every file's lines in the inventory, however far in it sits", async () => {
    const { service } = harness({
      files: [
        file(EVIDENCE_A, "a-big/app.log", `${filler(50_000)}\n`),
        file(EVIDENCE_B, "b-small/app.log", "the needle is here\n"),
      ],
    });
    const inventory = await service.inventory(CASE_ID, ACTOR, false);
    expect(inventory.corpusTruncated).toBe(false);
    expect(inventory.unreadFiles).toEqual([]);
    expect(inventory.items.every((item) => item.fullyRead)).toBe(true);
    expect(inventory.items.find((item) => item.evidenceId === EVIDENCE_A)?.lineCount).toBe(
      50_000,
    );
    expect(inventory.items.find((item) => item.evidenceId === EVIDENCE_B)?.lineCount).toBe(1);
  });

  it("pages a file that used to sit behind the read limit instead of refusing it", async () => {
    const { service } = harness({
      files: [
        file(EVIDENCE_A, "a-big/app.log", filler(50_000)),
        file(EVIDENCE_B, "b-small/app.log", "the needle is here\n"),
      ],
    });
    const page = await service.page(CASE_ID, ACTOR, false, EVIDENCE_B, 1, 80);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.text).toContain("the needle is here");
    expect(page.bounded).toBe(false);
  });

  it("still reports an ordinary corpus as a complete answer", async () => {
    const { service } = harness();
    const inventory = await service.inventory(CASE_ID, ACTOR, false);
    expect(inventory.corpusTruncated).toBe(false);
    expect(inventory.unreadFiles).toEqual([]);
    expect(inventory.items.every((item) => item.fullyRead)).toBe(true);
    const result = await service.search(CASE_ID, ACTOR, false, SEARCH);
    expect(result.corpusTruncated).toBe(false);
    expect(result.bounded).toBe(false);
  });

  it("counts only the lines a file really has", async () => {
    const { service } = harness();
    // The gateway fixture ends with a newline; that is three lines, not four.
    const inventory = await service.inventory(CASE_ID, ACTOR, false);
    expect(inventory.items.find((item) => item.evidenceId === EVIDENCE_A)?.lineCount).toBe(3);
  });
});

describe("a time window is refused rather than compared as text", () => {
  it("rejects a bound that is not a full instant", async () => {
    const { service } = harness();
    await expect(
      service.search(CASE_ID, ACTOR, false, {
        ...SEARCH,
        query: "edge",
        filters: { ...SEARCH.filters, timeFrom: "2024-03-10 08:00" },
      }),
    ).rejects.toThrow(/full UTC instant/);
  });

  it("keeps a line the window really contains", async () => {
    const { service } = harness();
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      query: "edge",
      filters: { ...SEARCH.filters, timeFrom: "2024-03-10T08:00:00Z" },
    });
    expect(result.returned).toBe(1);
    expect(result.matches[0]?.text).toMatch(/upstream timeout/);
  });
});
