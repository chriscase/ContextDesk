/**
 * Full-corpus search and paging over synthetic intake bytes.
 *
 * The defect these pin: the workbench used to read at most 50,000 lines of an
 * investigation *before* applying the reader's file selection, and the only
 * cursor it offered was a match ordinal. A root cause on line 150,000 was
 * therefore unreachable — no number of "load more" requests could advance past
 * a page that found nothing, and selecting the file it lived in did not help,
 * because the selection was applied after the read budget was already spent.
 *
 * No host, no provider, no private data: every byte here is generated.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKBENCH_LIMITS, decodeWorkbenchPageCursor } from "@cd-collab/contracts";
import { MemoryAuditStore } from "../audit/index.js";
import { MemoryWorkbenchStore } from "./store.js";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchService,
  type WorkbenchCasePort,
  type WorkbenchEvidenceDescriptor,
  type WorkbenchHostSearchOutcome,
  type WorkbenchSearchResultV1,
} from "./service.js";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = { id: "analyst-synthetic-01", username: "analyst-synthetic-01" };
const STRANGER = { id: "viewer-synthetic-02", username: "viewer-synthetic-02" };

const BIG = "22222222-2222-4222-8222-222222222222";
const LATE = "33333333-3333-4333-8333-333333333333";
const DUPE_A = "44444444-4444-4444-8444-444444444444";
const DUPE_B = "55555555-5555-4555-8555-555555555555";
const DUPE_NESTED = "66666666-6666-4666-8666-666666666666";

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface SyntheticFile {
  evidenceId: string;
  relativePath: string;
  text: string;
  privacyClass?: "owner_only" | "share_safe";
}

/**
 * A port shaped like the shipped one: metadata without bytes, and one file's
 * bytes on demand. It records every read so a test can prove which files were
 * opened — and, more to the point, which were not.
 */
function harness(options: {
  files: SyntheticFile[];
  revision?: number | null;
  hostSearch?: (input: {
    sources: string[];
  }) => Promise<WorkbenchHostSearchOutcome | null>;
}) {
  const reads: string[] = [];
  let wholeCorpusReads = 0;
  const descriptorOf = (file: SyntheticFile): WorkbenchEvidenceDescriptor => ({
    evidenceId: file.evidenceId,
    relativePath: file.relativePath,
    digest: digest(file.text),
    intakeBatchId: null,
    privacyClass: file.privacyClass ?? "owner_only",
  });
  const cases: WorkbenchCasePort = {
    async getCase(id, actor) {
      if (id !== CASE_ID) return null;
      if (actor.id === STRANGER.id) return null;
      return { id };
    },
    async listEvidenceDescriptors() {
      return options.files.map(descriptorOf);
    },
    async readEvidenceText(_caseId, evidenceId) {
      reads.push(evidenceId);
      return options.files.find((file) => file.evidenceId === evidenceId)?.text ?? null;
    },
    async listEvidenceFiles() {
      wholeCorpusReads += 1;
      return options.files.map((file) => ({ ...descriptorOf(file), text: file.text }));
    },
    async currentNormalizationRevision() {
      return options.revision === undefined ? 3 : options.revision;
    },
    ...(options.hostSearch ? { hostSearch: async (_c: string, input: { sources: string[] }) => options.hostSearch!(input) } : {}),
    async casePrivacyClass() {
      return "owner_only";
    },
    async appendTimeline() {
      return undefined;
    },
  };
  const store = new MemoryWorkbenchStore();
  const service = new WorkbenchService({
    store,
    cases,
    audit: new MemoryAuditStore(),
  });
  return {
    service,
    store,
    reads,
    wholeCorpusReads: () => wholeCorpusReads,
    /** A second service over the same bytes: a cursor must survive a restart. */
    restarted: () =>
      new WorkbenchService({
        store: new MemoryWorkbenchStore(),
        cases,
        audit: new MemoryAuditStore(),
      }),
  };
}

describe("private-read revocation", () => {
  it("omits private files, never invokes an unscoped host, and preserves share-safe reads", async () => {
    let hostCalls = 0;
    const onlyPrivate = harness({
      files: [{ evidenceId: BIG, relativePath: "private/app.log", text: "private\n" }],
      hostSearch: async () => {
        hostCalls += 1;
        return null;
      },
    });
    const hidden = await onlyPrivate.service.search(
      CASE_ID,
      ACTOR,
      false,
      {
        ...SEARCH,
        filters: {
          ...SEARCH.filters,
          timeFrom: "2024-03-10T00:00:00Z",
          timeTo: "2024-03-11T00:00:00Z",
        },
      },
      { canReadPrivate: false },
    );
    expect(hidden.scopeFileCount).toBe(0);
    expect(onlyPrivate.reads).toEqual([]);
    expect(hostCalls).toBe(0);
    await expect(
      onlyPrivate.service.page(CASE_ID, ACTOR, false, BIG, 1, 10, false),
    ).rejects.toBeInstanceOf(WorkbenchNotFoundError);
    expect(onlyPrivate.reads).toEqual([]);

    let mixedHostCalls = 0;
    const mixed = harness({
      files: [
        { evidenceId: BIG, relativePath: "private/app.log", text: "private\n" },
        {
          evidenceId: LATE,
          relativePath: "shared/app.log",
          text: "the needle is share safe\n",
          privacyClass: "share_safe",
        },
      ],
      hostSearch: async () => {
        mixedHostCalls += 1;
        return null;
      },
    });
    const inventory = await mixed.service.inventory(CASE_ID, ACTOR, false, false);
    expect(inventory.items.map((item) => item.evidenceId)).toEqual([LATE]);
    expect(mixed.reads).toEqual([LATE]);
    mixed.reads.length = 0;
    await mixed.service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      filters: {
        ...SEARCH.filters,
        timeFrom: "2024-03-10T00:00:00Z",
        timeTo: "2024-03-11T00:00:00Z",
      },
    }, { canReadPrivate: false });
    expect(mixedHostCalls).toBe(0);
    expect(mixed.reads).toEqual([LATE]);
  });

  it("hides stored private bookmarks, locator tokens, and views before corpus reads", async () => {
    const h = harness({
      files: [{ evidenceId: LATE, relativePath: "private/app.log", text: "one\ntwo\n" }],
    });
    const bookmark = await h.service.saveBookmark(CASE_ID, ACTOR, false, {
      locator: {
        evidenceId: LATE,
        digestAtBind: digest("one\ntwo\n"),
        byteOffset: 0,
        lineNumber: 1,
        originalTimestamp: null,
        normalizedUtc: null,
        corpusRevision: null,
      },
      note: "private analyst note",
      idempotencyKey: "private-bookmark-0001",
    }, true);
    await h.service.saveView(CASE_ID, ACTOR, false, {
      name: "Private view",
      filters: SEARCH.filters,
      query: "private",
      mode: "literal",
      selectedPanes: [LATE],
      timeFrom: null,
      timeTo: null,
      sort: "ingest_order",
      grouping: "none",
      display: {
        syncScroll: true,
        wrap: false,
        lineNumbers: true,
        displayTimezone: "UTC",
      },
      contextBefore: 0,
      contextAfter: 0,
      idempotencyKey: "private-view-0001",
    }, true);

    h.reads.length = 0;
    await expect(h.service.listBookmarks(CASE_ID, ACTOR, false, false)).resolves.toEqual([]);
    await expect(h.service.listViews(CASE_ID, ACTOR, false, false)).resolves.toEqual([]);
    await expect(h.service.resolveLocator({
      schemaId: "cd-collab.log_workbench_share_safe_locator.v1",
      token: bookmark.shareSafeToken,
    }, ACTOR, false, false)).resolves.toMatchObject({
      found: false,
      investigationId: null,
    });
    expect(h.reads).toEqual([]);
  });
});

const SEARCH = {
  schemaId: "cd-collab.log_workbench_search_request.v1" as const,
  query: "needle",
  mode: "literal" as const,
  filters: {
    includeTerms: [] as string[],
    excludeTerms: [] as string[],
    severity: null,
    component: null,
    file: null as string | null,
    rotationFamily: null as string | null,
    timeFrom: null as string | null,
    timeTo: null as string | null,
    evidenceIds: [] as string[],
  },
  contextBefore: 1,
  contextAfter: 1,
  cursor: 0,
  limit: 50,
  expectedNormalizationRevision: 3,
};

/** 200,000 lines with a needle planted before and after the old 50,000 cap. */
const TOTAL_LINES = 200_000;
const EARLY_NEEDLE = 12_345;
const LATE_NEEDLE = 150_000;

function bigCorpusText(): string {
  const lines: string[] = [];
  for (let n = 1; n <= TOTAL_LINES; n += 1) {
    if (n === EARLY_NEEDLE) lines.push(`INFO line ${n} the needle is here early`);
    else if (n === LATE_NEEDLE) lines.push(`ERROR line ${n} the needle is here late`);
    else lines.push(`INFO line ${n} ordinary traffic rid-${n}`);
  }
  return `${lines.join("\n")}\n`;
}

const BIG_TEXT = bigCorpusText();

/** Walk every page a search offers, following the position cursor. */
async function walkPages(
  service: WorkbenchService,
  request: Record<string, unknown>,
  maxPages = 40,
): Promise<{ pages: WorkbenchSearchResultV1[]; matches: { evidenceId: string; lineNumber: number }[] }> {
  const pages: WorkbenchSearchResultV1[] = [];
  const matches: { evidenceId: string; lineNumber: number }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result: WorkbenchSearchResultV1 = await service.search(CASE_ID, ACTOR, false, {
      ...request,
      pageCursor: cursor,
    });
    pages.push(result);
    for (const match of result.matches) {
      matches.push({ evidenceId: match.evidenceId, lineNumber: match.lineNumber });
    }
    if (result.nextPageCursor === null) return { pages, matches };
    cursor = result.nextPageCursor;
  }
  throw new Error(`search did not converge within ${maxPages} pages`);
}

describe("a 200,000-line investigation is searchable end to end", () => {
  it("finds the needle before the old boundary on the first page", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT }],
    });
    const first = await service.search(CASE_ID, ACTOR, false, SEARCH);
    expect(first.matches.map((match) => match.lineNumber)).toEqual([EARLY_NEEDLE]);
    // Still more corpus to cover, and the page says so rather than implying
    // this is every match.
    expect(first.coverageComplete).toBe(false);
    expect(first.corpusTruncated).toBe(false);
    expect(first.nextPageCursor).not.toBeNull();
  });

  it("reaches the needle past the old boundary by advancing the cursor", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT }],
    });
    const { pages, matches } = await walkPages(service, SEARCH);
    expect(matches.map((match) => match.lineNumber)).toEqual([EARLY_NEEDLE, LATE_NEEDLE]);
    const last = pages.at(-1)!;
    expect(last.coverageComplete).toBe(true);
    expect(last.corpusTruncated).toBe(false);
    expect(last.scannedLinesTotal).toBeGreaterThanOrEqual(TOTAL_LINES);
    // Every page stays inside the per-page work budget.
    for (const page of pages) {
      expect(page.scannedLines).toBeLessThanOrEqual(WORKBENCH_LIMITS.maxSearchWorkLines);
    }
  });

  it("returns zero-match pages that still carry a cursor forward", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT }],
    });
    const { pages } = await walkPages(service, SEARCH);
    const empty = pages.filter((page) => page.returned === 0);
    expect(empty.length).toBeGreaterThan(0);
    // A page with no matches and lines still unread is the exact case the old
    // ordinal cursor could not express.
    for (const page of empty.slice(0, -1)) {
      expect(page.nextPageCursor).not.toBeNull();
      expect(page.coverageComplete).toBe(false);
    }
  });

  it("never materializes the corpus: no whole-file listing, one read per file", async () => {
    const { service, reads, wholeCorpusReads } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT }],
    });
    await walkPages(service, SEARCH);
    expect(wholeCorpusReads()).toBe(0);
    expect(new Set(reads)).toEqual(new Set([BIG]));
  });
});

describe("scope is applied before a byte is read", () => {
  const files: SyntheticFile[] = [
    { evidenceId: BIG, relativePath: "a-gateway/app.log", text: BIG_TEXT },
    {
      evidenceId: LATE,
      relativePath: "z-worker/late.log",
      text: "ERROR the needle is here, in a file that used to sit past the boundary\n",
    },
  ];

  it("reads only the selected file, even when it sorts after a huge one", async () => {
    const { service, reads } = harness({ files });
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      filters: { ...SEARCH.filters, evidenceIds: [LATE] },
    });
    expect(result.returned).toBe(1);
    expect(result.scopeFileCount).toBe(1);
    expect(result.scannedLines).toBe(1);
    expect(result.coverageComplete).toBe(true);
    // The 200,000-line file was never opened. Under the old order it was read
    // first, spent the whole budget, and the selected file was reported as
    // unreachable.
    expect(reads).toEqual([LATE]);
  });

  it("narrows by relative path without reading the rest", async () => {
    const { service, reads } = harness({ files });
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      filters: { ...SEARCH.filters, file: "z-worker/late.log" },
    });
    expect(result.returned).toBe(1);
    expect(reads).toEqual([LATE]);
  });

  it("pages a file that lies past the old boundary instead of refusing it", async () => {
    const { service } = harness({ files });
    const page = await service.page(CASE_ID, ACTOR, false, LATE, 1, 80);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.text).toContain("the needle is here");
  });

  it("pages deep into a large file without reading any other file", async () => {
    const { service, reads } = harness({ files });
    const page = await service.page(CASE_ID, ACTOR, false, BIG, LATE_NEEDLE, 3);
    expect(page.rows.map((row) => row.lineNumber)).toEqual([
      LATE_NEEDLE,
      LATE_NEEDLE + 1,
      LATE_NEEDLE + 2,
    ]);
    expect(page.rows[0]?.text).toContain("the needle is here late");
    expect(reads).toEqual([BIG]);
  });
});

describe("review preview bounded evidence path", () => {
  it("uses descriptors and read-one without invoking the legacy bulk fixture method", async () => {
    const evidenceId = "77777777-7777-4777-8777-777777777777";
    const { service, reads, wholeCorpusReads } = harness({
      files: [{
        evidenceId,
        relativePath: "worker/batch.log",
        text: "2024-03-10 01:30:00 INFO scheduled sweep\n",
      }],
    });
    await service.previewRule(CASE_ID, ACTOR, false, {
      schemaId: "cd-collab.log_time_review_rule.v1",
      scope: "source",
      source: "worker/batch.log",
      rotationFamily: null,
      selectedEvidenceIds: [],
      ianaTimezone: "UTC",
      expectedRevision: 3,
      idempotencyKey: "bounded-preview-0001",
    });
    expect(wholeCorpusReads()).toBe(0);
    expect(reads).toEqual([evidenceId]);
  });
});

describe("duplicate names and nested paths stay distinct", () => {
  const files: SyntheticFile[] = [
    { evidenceId: DUPE_A, relativePath: "alpha/app.log", text: "ERROR the needle is here in alpha\n" },
    { evidenceId: DUPE_B, relativePath: "beta/app.log", text: "ERROR the needle is here in beta\n" },
    {
      evidenceId: DUPE_NESTED,
      relativePath: "alpha/nested/app.log",
      text: "ERROR the needle is here in alpha nested\n",
    },
  ];

  it("keeps same-named files apart and orders them deterministically", async () => {
    const { service } = harness({ files });
    const result = await service.search(CASE_ID, ACTOR, false, SEARCH);
    expect(result.returned).toBe(3);
    expect(result.matches.map((match) => match.relativePath)).toEqual([
      "alpha/app.log",
      "alpha/nested/app.log",
      "beta/app.log",
    ]);
    expect(new Set(result.matches.map((match) => match.evidenceId)).size).toBe(3);
  });

  it("selects one of three same-named files by evidence id", async () => {
    const { service, reads } = harness({ files });
    const result = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      filters: { ...SEARCH.filters, evidenceIds: [DUPE_NESTED] },
    });
    expect(result.matches.map((match) => match.relativePath)).toEqual(["alpha/nested/app.log"]);
    expect(reads).toEqual([DUPE_NESTED]);
  });
});

describe("cursors neither skip nor repeat a match", () => {
  /** 100 needles spread through 3,000 lines, paged seven at a time. */
  const planted = Array.from({ length: 100 }, (_, index) => index * 30 + 7);
  const text = `${Array.from({ length: 3_000 }, (_, index) => {
    const line = index + 1;
    return planted.includes(line)
      ? `ERROR line ${line} the needle is here`
      : `INFO line ${line} ordinary`;
  }).join("\n")}\n`;

  it("returns exactly the planted matches, in order, across many pages", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text }],
    });
    const { matches, pages } = await walkPages(service, { ...SEARCH, limit: 7 }, 60);
    const lineNumbers = matches.map((match) => match.lineNumber);
    expect(lineNumbers).toEqual(planted);
    expect(new Set(lineNumbers).size).toBe(planted.length);
    expect(pages.at(-1)?.coverageComplete).toBe(true);
  });

  it("keeps the lines above a match visible when a page resumes mid-file", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text }],
    });
    const first = await service.search(CASE_ID, ACTOR, false, { ...SEARCH, limit: 7 });
    const second = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      limit: 7,
      pageCursor: first.nextPageCursor,
    });
    const resumed = second.matches[0]!;
    // The lead-in is read as context, not re-counted as a match.
    expect(resumed.contextBefore).toHaveLength(1);
    expect(resumed.contextBefore[0]).toContain(`line ${resumed.lineNumber - 1} `);
    expect(resumed.contextAfter[0]).toContain(`line ${resumed.lineNumber + 1} `);
    expect(resumed.lineNumber).toBeGreaterThan(first.matches.at(-1)!.lineNumber);
  });

  it("resumes a cursor minted before a restart", async () => {
    const started = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text }],
    });
    const first = await started.service.search(CASE_ID, ACTOR, false, { ...SEARCH, limit: 7 });
    // A cursor is a record, not session state: a fresh service resumes it.
    const second = await started
      .restarted()
      .search(CASE_ID, ACTOR, false, { ...SEARCH, limit: 7, pageCursor: first.nextPageCursor });
    expect(second.matches.map((match) => match.lineNumber)).toEqual(planted.slice(7, 14));
  });

  it("still honours the older match-ordinal cursor over the whole corpus", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text }],
    });
    // A client written against the first contract sends no pageCursor at all.
    const second = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      limit: 7,
      cursor: 7,
    });
    expect(second.matches.map((match) => match.lineNumber)).toEqual(planted.slice(7, 14));
    expect(second.nextCursor).toBe(14);
  });
});

describe("a cursor is refused rather than resumed against a moved corpus", () => {
  const files: SyntheticFile[] = [
    { evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT },
  ];

  it("refuses a cursor whose normalization revision has moved", async () => {
    const { service } = harness({ files });
    const first = await service.search(CASE_ID, ACTOR, false, SEARCH);
    const moved = harness({ files, revision: 4 });
    await expect(
      moved.service.search(CASE_ID, ACTOR, false, {
        ...SEARCH,
        expectedNormalizationRevision: 4,
        pageCursor: first.nextPageCursor,
      }),
    ).rejects.toBeInstanceOf(WorkbenchConflictError);
  });

  it("refuses a cursor minted against a different set of files", async () => {
    const { service } = harness({ files });
    const first = await service.search(CASE_ID, ACTOR, false, SEARCH);
    const grown = harness({
      files: [...files, { evidenceId: LATE, relativePath: "z/late.log", text: "ERROR needle\n" }],
    });
    await expect(
      grown.service.search(CASE_ID, ACTOR, false, {
        ...SEARCH,
        pageCursor: first.nextPageCursor,
      }),
    ).rejects.toThrow(/selected files changed/);
  });

  it("refuses a request whose expected revision is already stale", async () => {
    const { service } = harness({ files, revision: 9 });
    await expect(
      service.search(CASE_ID, ACTOR, false, SEARCH),
    ).rejects.toThrow(/stale normalization revision/);
  });

  it("refuses a malformed resume token instead of reading from the start", async () => {
    const { service, reads } = harness({ files });
    await expect(
      service.search(CASE_ID, ACTOR, false, { ...SEARCH, pageCursor: "not-a-cursor" }),
    ).rejects.toThrow();
    expect(reads).toEqual([]);
  });

  it("carries no filename in the resume token", async () => {
    const { service } = harness({ files });
    const first = await service.search(CASE_ID, ACTOR, false, SEARCH);
    const decoded = decodeWorkbenchPageCursor(first.nextPageCursor!);
    expect(decoded.evidenceId).toBe(BIG);
    expect(JSON.stringify(decoded)).not.toContain("gateway");
    expect(JSON.stringify(decoded)).not.toContain("app.log");
  });
});

describe("authorization and cancellation stop the read", () => {
  const files: SyntheticFile[] = [
    { evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT },
  ];

  it("reads nothing for a caller who cannot see the investigation", async () => {
    const { service, reads } = harness({ files });
    await expect(
      service.search(CASE_ID, STRANGER, false, SEARCH),
    ).rejects.toBeInstanceOf(WorkbenchNotFoundError);
    await expect(
      service.page(CASE_ID, STRANGER, false, BIG, 1, 10),
    ).rejects.toBeInstanceOf(WorkbenchNotFoundError);
    expect(reads).toEqual([]);
  });

  it("reports a cancelled scan as partial, with no cursor that would imply more", async () => {
    const { service } = harness({ files });
    let seen = 0;
    const result = await service.search(CASE_ID, ACTOR, false, SEARCH, {
      cancelled: () => {
        seen += 1;
        return seen > 5_000;
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.bounded).toBe(true);
    expect(result.coverageComplete).toBe(false);
    // A cancelled scan cannot promise where to pick up, so it says truncated
    // rather than handing back a cursor it cannot stand behind.
    expect(result.nextPageCursor).toBeNull();
    expect(result.corpusTruncated).toBe(true);
  });

  it("reports a file whose bytes vanished as truncated, not as empty", async () => {
    const { service } = harness({
      files: [{ evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT }],
    });
    const missing = await service.search(CASE_ID, ACTOR, false, {
      ...SEARCH,
      filters: { ...SEARCH.filters, evidenceIds: ["77777777-7777-4777-8777-777777777777"] },
    });
    expect(missing.scopeFileCount).toBe(0);
    expect(missing.returned).toBe(0);
    expect(missing.coverageComplete).toBe(true);
  });
});

describe("locators resolve wherever they sit in the corpus", () => {
  const files: SyntheticFile[] = [
    { evidenceId: BIG, relativePath: "gateway/app.log", text: BIG_TEXT },
    { evidenceId: LATE, relativePath: "worker/late.log", text: "one\ntwo\nthree\n" },
  ];

  it("resolves a bookmark on a line past the old read boundary", async () => {
    const { service } = harness({ files });
    const saved = await service.saveBookmark(CASE_ID, ACTOR, false, {
      locator: {
        evidenceId: BIG,
        digestAtBind: digest(BIG_TEXT),
        byteOffset: 0,
        lineNumber: LATE_NEEDLE,
        originalTimestamp: null,
        normalizedUtc: null,
        corpusRevision: null,
      },
      note: "late root cause",
      idempotencyKey: "bookmark-late-0001",
    });
    // Under the old whole-corpus resolve this line was never read, so the
    // bookmark reported as unresolvable the moment it was saved.
    expect(saved.status).toBe("resolved");
    const listed = await service.listBookmarks(CASE_ID, ACTOR, false);
    expect(listed.map((row) => row.status)).toEqual(["resolved"]);
  });

  it("reads each bookmarked file once, however many bookmarks it holds", async () => {
    const { service, reads } = harness({ files });
    for (const lineNumber of [1, 2, 3]) {
      await service.saveBookmark(CASE_ID, ACTOR, false, {
        locator: {
          evidenceId: LATE,
          digestAtBind: digest("one\ntwo\nthree\n"),
          byteOffset: 0,
          lineNumber,
          originalTimestamp: null,
          normalizedUtc: null,
          corpusRevision: null,
        },
        note: `line ${lineNumber}`,
        idempotencyKey: `bookmark-small-000${lineNumber}`,
      });
    }
    reads.length = 0;
    const listed = await service.listBookmarks(CASE_ID, ACTOR, false);
    expect(listed).toHaveLength(3);
    expect(listed.every((row) => row.status === "resolved")).toBe(true);
    // Three bookmarks in one file cost one read, and the unrelated
    // 200,000-line file is never opened.
    expect(reads).toEqual([LATE]);
  });
});

describe("the timestamp authority owns a time-filtered search", () => {
  const files: SyntheticFile[] = [
    {
      evidenceId: BIG,
      relativePath: "gateway/app.log",
      text: "2024-03-10 08:10:00 ERROR the needle is here with a local clock\n",
    },
  ];
  const TIMED = {
    ...SEARCH,
    filters: {
      ...SEARCH.filters,
      timeFrom: "2024-03-10T00:00:00Z",
      timeTo: "2024-03-11T00:00:00Z",
    },
  };

  it("asks the host, scoped to the selected files", async () => {
    let asked: string[] = [];
    const { service } = harness({
      files,
      hostSearch: async (input) => {
        asked = input.sources;
        return {
          corpusRevision: 3,
          stamps: [
            {
              source: "gateway/app.log",
              message: "the needle is here with a local clock",
              ts: Date.parse("2024-03-10T15:10:00Z") / 1000,
              timeQuality: "wall clock",
              unresolvedLocalTimestamp: null,
            },
          ],
          bounded: false,
          atLeast: 1,
          cancelled: false,
          diagnostic: null,
        };
      },
    });
    const result = await service.search(CASE_ID, ACTOR, false, TIMED);
    expect(asked).toEqual(["gateway/app.log"]);
    // The host resolved the local clock; the workbench never guessed a zone.
    expect(result.returned).toBe(1);
    expect(result.matches[0]?.normalizedUtc).toBe("2024-03-10T15:10:00.000Z");
  });

  it("refuses a time-filtered search when the host cannot be reached", async () => {
    const { service } = harness({
      files,
      hostSearch: async () => {
        throw new Error("log-time host operation exceeded its deadline");
      },
    });
    await expect(service.search(CASE_ID, ACTOR, false, TIMED)).rejects.toThrow(
      /timestamp authority could not be reached/,
    );
  });

  it("still answers a text-only search when the host is unreachable", async () => {
    const { service } = harness({
      files,
      hostSearch: async () => {
        throw new Error("log-time host operation exceeded its deadline");
      },
    });
    const result = await service.search(CASE_ID, ACTOR, false, SEARCH);
    expect(result.returned).toBe(1);
    expect(result.coverageComplete).toBe(true);
  });

  it("says which basis it used when the case has no built corpus", async () => {
    const { service } = harness({ files, hostSearch: async () => null });
    const result = await service.search(CASE_ID, ACTOR, false, TIMED);
    expect(result.timeAuthorityUnavailableReason).toMatch(/no built log corpus/);
    // A local clock is left out of the window rather than guessed into it.
    expect(result.returned).toBe(0);
    expect(result.timeFilterUnknownReason).toMatch(/no normalized timestamp/);
  });
});
