import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countAdvancedFilters,
  filterInvestigationLogs,
  groupSearchMatches,
  LogWorkbench,
  virtualizedWindow,
  WORKBENCH_VIRTUALIZATION,
} from "./LogWorkbench.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const EVIDENCE_A = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_B = "55555555-5555-4555-8555-555555555555";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function inventory() {
  return {
    items: [
      {
        evidenceId: EVIDENCE_A,
        relativePath: "gateway/edge.log",
        rotationFamily: "gateway/edge.log",
        displayLabel: "edge.log",
        digest: "a".repeat(64),
        intakeBatchId: "66666666-6666-4666-8666-666666666666",
        privacyClass: "owner_only",
        lineCount: 3,
      },
      {
        evidenceId: EVIDENCE_B,
        relativePath: '<img src=x onerror=alert(1)>.log',
        rotationFamily: "html.log",
        displayLabel: '<img src=x onerror=alert(1)>.log',
        digest: "b".repeat(64),
        intakeBatchId: null,
        privacyClass: "owner_only",
        lineCount: 1,
      },
    ],
    normalizationRevision: 3,
  };
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/workbench") && !init?.method) {
        return jsonResponse(inventory());
      }
      if (url.includes("/workbench/views") && init?.method === "POST") {
        return jsonResponse({
          schemaId: "cd-collab.log_workbench_view.v1",
          id: "33333333-3333-4333-8333-333333333333",
          name: "Timeout window",
          selectedPanes: [EVIDENCE_A],
          query: "timeout",
          mode: "literal",
          filters: {
            includeTerms: ["edge"],
            excludeTerms: [],
            severity: "error",
            timeFrom: "2024-03-10T07:00:00.000Z",
            timeTo: "2024-03-10T09:00:00.000Z",
          },
          timeFrom: "2024-03-10T07:00:00.000Z",
          timeTo: "2024-03-10T09:00:00.000Z",
          sort: "time_asc",
          grouping: "component",
          display: { syncScroll: false },
        });
      }
      if (url.includes("/workbench/views")) {
        return jsonResponse({
          views: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              name: "Timeout window",
              selectedPanes: [EVIDENCE_A],
              query: "timeout",
              mode: "literal",
              filters: {
                includeTerms: ["edge"],
                excludeTerms: [],
                severity: "error",
                timeFrom: "2024-03-10T07:00:00.000Z",
                timeTo: "2024-03-10T09:00:00.000Z",
              },
              timeFrom: "2024-03-10T07:00:00.000Z",
              timeTo: "2024-03-10T09:00:00.000Z",
              sort: "time_asc",
              grouping: "component",
              display: { syncScroll: false },
            },
          ],
        });
      }
      if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
      if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 2 });
      if (url.includes("/workbench/page")) {
        return jsonResponse({
          evidenceId: EVIDENCE_A,
          relativePath: "gateway/edge.log",
          startLine: 1,
          rows: [
            {
              evidenceId: EVIDENCE_A,
              relativePath: "gateway/edge.log",
              rotationFamily: "gateway/edge.log",
              lineNumber: 1,
              byteOffset: 0,
              text: "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
              wrapped: false,
              originalTimestamp: "2024-03-10T08:10:00Z",
              normalizedUtc: "2024-03-10T08:10:00.000Z",
              parseClass: "explicit_offset",
              contextBefore: [],
              contextAfter: [],
            },
          ],
          wrappedRowCount: 0,
          nextStartLine: null,
          bounded: false,
        });
      }
      if (url.includes("/workbench/search")) {
        return jsonResponse({
          schemaId: "cd-collab.log_workbench_search_result.v1",
          matches: [
            {
              evidenceId: EVIDENCE_A,
              relativePath: "gateway/edge.log",
              rotationFamily: "gateway/edge.log",
              lineNumber: 1,
              byteOffset: 0,
              text: "2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003",
              wrapped: false,
              originalTimestamp: "2024-03-10T08:10:00Z",
              normalizedUtc: "2024-03-10T08:10:00.000Z",
              parseClass: "explicit_offset",
              contextBefore: [],
              contextAfter: [],
            },
          ],
          returned: 1,
          bounded: false,
          atLeast: 1,
          nextCursor: null,
          nextPageCursor: null,
          cancelled: false,
          corpusTruncated: false,
          coverageComplete: true,
          scannedLines: 3,
          scannedLinesTotal: 3,
          scopeFileCount: 1,
          timeFilterApplied: false,
          timeFilterUnknownReason: null,
          timeAuthorityUnavailableReason: null,
          expectedNormalizationRevision: 3,
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }),
  );
}

describe("Log workbench", () => {
  it("shows investigation logs with human labels and keeps HTML filenames as text", async () => {
    stubFetch();
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(await screen.findByRole("heading", { name: "Log workbench" })).toBeTruthy();
    expect(screen.getAllByText("edge.log").length).toBeGreaterThan(0);
    expect(screen.getAllByText('<img src=x onerror=alert(1)>.log').length).toBeGreaterThan(0);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("heading", { name: EVIDENCE_A })).toBeNull();
    expect(screen.getAllByText("Details")).toHaveLength(2);
  });

  it("keeps the default pane, selector, count, and clear state consistent", async () => {
    stubFetch();
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });

    expect((screen.getByLabelText("Show edge.log in a pane") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByText(/1 of 4 panes open/)).toBeTruthy();
    expect(await screen.findByRole("region", { name: "edge.log lines" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear open files" }));
    expect((screen.getByLabelText("Show edge.log in a pane") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.getByText(/no panes open/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "edge.log lines" })).toBeNull();
    expect(screen.getByText("Select a log file to open its lines.")).toBeTruthy();
  });

  it("searches and reports an exact match count", async () => {
    stubFetch();
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.change(screen.getByLabelText("Find in logs"), {
      target: { value: "timeout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getAllByText(/1 match\b/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Every selected line was searched/).length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "Search matches" }).textContent).toMatch(
      /upstream timeout/,
    );
    const navigation = screen.getByRole("group", { name: "Search match navigation" });
    expect(navigation.textContent).toContain("1 of 1");
    expect(screen.getByRole("button", { name: "Previous match" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next match" })).toBeTruthy();
  });

  it("labels normalized, unresolved, and order-only chronology rows explicitly", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/workbench/chronology")) {
          return jsonResponse({
            events: [
              { evidenceId: EVIDENCE_A, relativePath: "a.log", lineNumber: 1, excerpt: "one", adjacencyReason: "time", uncertainty: [], correlationKind: "none", correlationId: null, originalTimestamp: "2024-03-10T08:10:00Z", normalizedUtc: "2024-03-10T08:10:00.000Z" },
              { evidenceId: EVIDENCE_A, relativePath: "a.log", lineNumber: 2, excerpt: "two", adjacencyReason: "order", uncertainty: ["timezone_missing"], correlationKind: "none", correlationId: null, originalTimestamp: "03/10 01:11:00", normalizedUtc: null },
              { evidenceId: EVIDENCE_A, relativePath: "a.log", lineNumber: 3, excerpt: "three", adjacencyReason: "order", uncertainty: ["timestamp_missing"], correlationKind: "none", correlationId: null, originalTimestamp: null, normalizedUtc: null },
            ],
            unknownBuckets: [],
            bounded: false,
          });
        }
        return baseFetch(input, init);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.click(screen.getByRole("button", { name: "Show merged chronology" }));
    const chronology = await screen.findByRole("region", { name: "Merged chronology" });
    expect(chronology.textContent).toContain("Normalized UTC: 2024-03-10T08:10:00.000Z");
    expect(chronology.textContent).toContain("Unresolved local time: 03/10 01:11:00");
    expect(chronology.textContent).toContain("Order only");
  });

  it("restores filters, time window, grouping, and display from a saved view", async () => {
    stubFetch();
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.click(screen.getByRole("button", { name: "Timeout window" }));
    expect((screen.getByLabelText("Find in logs") as HTMLInputElement).value).toBe("timeout");
    expect((screen.getByLabelText("Match mode") as HTMLSelectElement).value).toBe("literal");
    expect((screen.getByLabelText("Include terms") as HTMLInputElement).value).toBe("edge");
    expect((screen.getByLabelText("Severity") as HTMLInputElement).value).toBe("error");
    expect((screen.getByLabelText("From (UTC)") as HTMLInputElement).value).toBe(
      "2024-03-10T07:00:00.000Z",
    );
    expect((screen.getByLabelText("To (UTC)") as HTMLInputElement).value).toBe(
      "2024-03-10T09:00:00.000Z",
    );
    expect((screen.getByLabelText("Chronology grouping") as HTMLSelectElement).value).toBe(
      "component",
    );
    expect((screen.getByLabelText("Synchronize pane scrolling") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("keeps the virtualized window bounded on a large row count", () => {
    const window = virtualizedWindow({
      totalRows: 80_000,
      scrollTop: 12_000,
      rowHeight: WORKBENCH_VIRTUALIZATION.ROW_HEIGHT,
      viewportHeight: WORKBENCH_VIRTUALIZATION.VIEWPORT_HEIGHT,
      overscan: WORKBENCH_VIRTUALIZATION.OVERSCAN,
    });
    expect(window.resident).toBeLessThanOrEqual(40);
  });

  it("reloads inventory after corpus intake on the same investigation", async () => {
    let inventoryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workbench")) {
          inventoryCalls += 1;
          if (inventoryCalls === 1) {
            return jsonResponse({ items: [], normalizationRevision: null });
          }
          return jsonResponse(inventory());
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(await screen.findByText(/no imported logs yet/)).toBeTruthy();
    window.dispatchEvent(
      new CustomEvent("contextdesk:corpus-intake-committed", { detail: { caseId: CASE_ID } }),
    );
    expect((await screen.findAllByText("edge.log")).length).toBeGreaterThan(0);
  });

  it("shows a retryable error when inventory fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid" }, 500)),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

/**
 * Regressions for the triage-usability defects: a partial read must be visible,
 * a hit list must actually navigate, and re-saving a view under one name must
 * not collide.
 */
describe("Log workbench honesty and navigation", () => {
  it("says so on Analyze when a file's bytes could not be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workbench")) {
          return jsonResponse({
            ...inventory(),
            corpusTruncated: true,
            unreadFiles: ["batch.log"],
          });
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/batch\.log/)).toBeTruthy();
  });

  it("does not describe a bounded search as a complete count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/page")) {
          return jsonResponse({
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            startLine: 1,
            rows: [],
            wrappedRowCount: 0,
            nextStartLine: null,
            bounded: false,
          });
        }
        if (url.includes("/workbench/search")) {
          return jsonResponse({
            matches: [],
            returned: 0,
            bounded: true,
            atLeast: 0,
            nextCursor: null,
            nextPageCursor: "cursor-page-two",
            cancelled: false,
            corpusTruncated: false,
            coverageComplete: false,
            scannedLines: 50_000,
            scannedLinesTotal: 50_000,
            scopeFileCount: 1,
            timeFilterApplied: false,
            timeFilterUnknownReason: null,
            timeAuthorityUnavailableReason: null,
            expectedNormalizationRevision: 3,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(screen.getAllByText(/more selected lines to search/).length).toBeGreaterThan(0),
    );
    // "No matches" must never be the last word while lines remain unsearched.
    expect(screen.queryByText(/^0 matches\./)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Keep searching the rest of the selected lines/ }),
    ).toBeTruthy();
  });

  /**
   * The defect this journey pins: a root cause past the first page's work
   * budget used to be unreachable, because the only cursor was a match count
   * and a page that found nothing could not advance it.
   */
  it("reaches a late match by advancing the page cursor, then says coverage is complete", async () => {
    const sentCursors: (string | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/search")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { pageCursor?: string | null };
          sentCursors.push(body.pageCursor);
          if (!body.pageCursor) {
            return jsonResponse({
              matches: [],
              returned: 0,
              bounded: true,
              atLeast: 0,
              nextCursor: null,
              nextPageCursor: "resume-at-50001",
              cancelled: false,
              corpusTruncated: false,
              coverageComplete: false,
              scannedLines: 50_000,
              scannedLinesTotal: 50_000,
              scopeFileCount: 1,
              timeFilterApplied: false,
              timeFilterUnknownReason: null,
              timeAuthorityUnavailableReason: null,
              expectedNormalizationRevision: 3,
            });
          }
          return jsonResponse({
            matches: [
              {
                evidenceId: EVIDENCE_A,
                relativePath: "gateway/edge.log",
                rotationFamily: "gateway/edge.log",
                lineNumber: 50_001,
                byteOffset: 900_000,
                text: "ERROR the needle is here rid-late",
                wrapped: false,
                originalTimestamp: null,
                normalizedUtc: null,
                parseClass: "unparsable",
                contextBefore: [],
                contextAfter: [],
              },
            ],
            returned: 1,
            bounded: false,
            atLeast: 1,
            nextCursor: null,
            nextPageCursor: null,
            cancelled: false,
            corpusTruncated: false,
            coverageComplete: true,
            scannedLines: 1,
            scannedLinesTotal: 50_001,
            scopeFileCount: 1,
            timeFilterApplied: false,
            timeFilterUnknownReason: null,
            timeAuthorityUnavailableReason: null,
            expectedNormalizationRevision: 3,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const keepGoing = await screen.findByRole("button", {
      name: /Keep searching the rest of the selected lines/,
    });
    fireEvent.click(keepGoing);
    await waitFor(() =>
      expect(screen.getAllByText(/Every selected line was searched/).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/gateway\/edge\.log:50001/)).toBeTruthy();
    expect(sentCursors).toEqual([null, "resume-at-50001"]);
    expect(
      screen.queryByRole("button", { name: /Keep searching the rest of the selected lines/ }),
    ).toBeNull();
    // Nothing left to load, so nothing offers to load it.
    expect(screen.queryByRole("button", { name: /Load more matches/ })).toBeNull();
    expect(screen.queryByText(/Load more to see the rest/)).toBeNull();
  });

  it("opens the matched file at the matched line when a hit is chosen", async () => {
    const pageRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/page")) {
          pageRequests.push(url);
          return jsonResponse({
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            startLine: 1,
            rows: [],
            wrappedRowCount: 0,
            nextStartLine: null,
            bounded: false,
          });
        }
        if (url.includes("/workbench/search")) {
          return jsonResponse({
            matches: [
              {
                evidenceId: EVIDENCE_A,
                relativePath: "gateway/edge.log",
                rotationFamily: "gateway/edge.log",
                lineNumber: 4200,
                byteOffset: 91_000,
                text: "ERROR edge upstream timeout rid-0003",
                wrapped: false,
                originalTimestamp: null,
                normalizedUtc: null,
                parseClass: "missing",
                contextBefore: [],
                contextAfter: [],
              },
            ],
            returned: 1,
            bounded: false,
            atLeast: 1,
            nextCursor: null,
            cancelled: false,
            corpusTruncated: false,
            timeFilterApplied: false,
            timeFilterUnknownReason: null,
            expectedNormalizationRevision: 3,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("list", { name: "Search matches" });
    pageRequests.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "gateway/edge.log:4200" }));
    // The pane is paged to a window that contains line 4200 rather than left
    // sitting on line 1 where the match cannot be seen.
    await waitFor(() =>
      expect(pageRequests.some((url) => /startLine=419\d/.test(url))).toBe(true),
    );
  });

  it("saves a changed view under the same name instead of colliding on the key", async () => {
    const saved: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        if (url.includes("/workbench/views") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { idempotencyKey: string };
          saved.push(body.idempotencyKey);
          return jsonResponse({ id: "33333333-3333-4333-8333-333333333333" });
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/page")) {
          return jsonResponse({
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            startLine: 1,
            rows: [],
            wrappedRowCount: 0,
            nextStartLine: null,
            bounded: false,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Find in logs"), {
      target: { value: "timeout rid-0003" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[0]).not.toBe(saved[1]);
    // The same view saved twice still replays under one key.
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(saved).toHaveLength(3));
    expect(saved[2]).toBe(saved[1]);
  });
  it("picks up a log uploaded through the evidence board beside it", async () => {
    let inventoryCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workbench")) {
          inventoryCalls += 1;
          if (inventoryCalls === 1) {
            return jsonResponse({ items: [], normalizationRevision: null });
          }
          return jsonResponse(inventory());
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(await screen.findByText(/no imported logs yet/)).toBeTruthy();
    window.dispatchEvent(
      new CustomEvent("contextdesk:evidence-changed", { detail: { caseId: CASE_ID } }),
    );
    expect((await screen.findAllByText("edge.log")).length).toBeGreaterThan(0);
  });

  it("keeps a paged pane where the reader left it when another file is opened", async () => {
    const pageRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/page")) {
          pageRequests.push(url);
          const start = Number(new URL(url, "http://x").searchParams.get("startLine") ?? "1");
          return jsonResponse({
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            startLine: start,
            rows: [],
            wrappedRowCount: 0,
            nextStartLine: start + 80,
            bounded: true,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    await waitFor(() => expect(pageRequests.length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: "Load next lines" })[0]!);
    await waitFor(() =>
      expect(pageRequests.some((url) => url.includes("startLine=81"))).toBe(true),
    );
    pageRequests.length = 0;
    // Opening a second file must not re-page the first back to line 1.
    fireEvent.click(
      screen.getByLabelText("Show <img src=x onerror=alert(1)>.log in a pane"),
    );
    await waitFor(() => expect(pageRequests.length).toBeGreaterThan(0));
    expect(
      pageRequests.filter(
        (url) => url.includes(encodeURIComponent(EVIDENCE_A)) && url.includes("startLine=1&"),
      ),
    ).toEqual([]);
  });
});

const EVIDENCE_C = "77777777-7777-4777-8777-777777777777";

function fileItem(index: number) {
  const id = `22222222-2222-4222-8222-${index.toString(16).padStart(12, "0")}`;
  const name = `svc-${String(index).padStart(3, "0")}.log`;
  return {
    evidenceId: index === 0 ? EVIDENCE_A : index === 1 ? EVIDENCE_B : index === 2 ? EVIDENCE_C : id,
    relativePath: `hosts/host-${index % 16}/${name}`,
    rotationFamily: name,
    displayLabel: name,
    digest: index.toString(16).padStart(64, "a"),
    intakeBatchId: null,
    privacyClass: "owner_only",
    lineCount: 12,
  };
}

function inventoryOf(count: number) {
  return {
    items: Array.from({ length: count }, (_, index) => fileItem(index)),
    normalizationRevision: 1,
  };
}

function stubSizedWorkbench(count: number, searchBody?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventoryOf(count));
      if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
      if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
      if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 2 });
      if (url.includes("/workbench/page")) {
        return jsonResponse({
          evidenceId: EVIDENCE_A,
          relativePath: "hosts/host-0/svc-000.log",
          startLine: 1,
          rows: [],
          wrappedRowCount: 0,
          nextStartLine: null,
          bounded: false,
        });
      }
      if (url.includes("/workbench/search") && searchBody) return jsonResponse(searchBody);
      return jsonResponse({ error: "not_found" }, 404);
    }),
  );
}

describe("Log workbench file picker at 3, 30, and 300 files", () => {
  it("keeps three files fully listed and filterable", async () => {
    stubSizedWorkbench(3);
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    expect(screen.getAllByRole("checkbox", { name: /Show .* in a pane/ })).toHaveLength(3);
    expect(screen.getByText(/3 files/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter log files"), {
      target: { value: "svc-002" },
    });
    expect(screen.getAllByRole("checkbox", { name: /Show .* in a pane/ })).toHaveLength(1);
    expect(screen.getByLabelText("Show svc-002.log in a pane")).toBeTruthy();
  });

  it("filters thirty files and caps side-by-side panes at four", async () => {
    stubSizedWorkbench(30);
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    expect(screen.getByText(/30 files/)).toBeTruthy();
    const visible = screen.getAllByRole("checkbox", { name: /Show .* in a pane/ });
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThanOrEqual(40);
    expect(screen.getByText(/Showing files/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Show svc-001.log in a pane"));
    fireEvent.click(screen.getByLabelText("Show svc-002.log in a pane"));
    fireEvent.click(screen.getByLabelText("Show svc-003.log in a pane"));
    fireEvent.click(screen.getByLabelText("Show svc-004.log in a pane"));
    expect(screen.getByText(/Only 4 files can be open side by side/)).toBeTruthy();
    expect(screen.getByText(/4 of 4 panes open/)).toBeTruthy();
    expect((screen.getByLabelText("Show svc-004.log in a pane") as HTMLInputElement).checked).toBe(
      false,
    );

    fireEvent.change(screen.getByLabelText("Filter log files"), {
      target: { value: "svc-029" },
    });
    expect(screen.getByLabelText("Show svc-029.log in a pane")).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /Show .* in a pane/ })).toHaveLength(1);
  });

  it("bounds the 300-file picker DOM and jumps by filter", async () => {
    stubSizedWorkbench(300);
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    const visible = screen.getAllByRole("checkbox", { name: /Show .* in a pane/ });
    expect(visible.length).toBeLessThanOrEqual(40);
    expect(visible.length).toBeLessThan(300);
    expect(screen.getByText(/300 files/)).toBeTruthy();
    expect(screen.getByText(/Showing files 1/)).toBeTruthy();
    expect(screen.queryByText("Details")).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter log files"), {
      target: { value: "svc-299" },
    });
    expect(screen.getAllByRole("checkbox", { name: /Show .* in a pane/ })).toHaveLength(1);
    expect(screen.getByLabelText("Show svc-299.log in a pane")).toBeTruthy();
    expect(screen.getByText(/1 of 300 files match/)).toBeTruthy();
    expect(screen.getByText("Details")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter log files"), {
      target: { value: "no-such-file" },
    });
    expect(screen.getByText(/No files match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear file filter" }));
    expect(screen.getAllByRole("checkbox", { name: /Show .* in a pane/ }).length).toBeGreaterThan(1);
  });
});

describe("Log workbench search hierarchy and progressive disclosure", () => {
  it("groups matches by file and marks the current hit", async () => {
    stubSizedWorkbench(3, {
      matches: [
        {
          evidenceId: EVIDENCE_A,
          relativePath: "hosts/host-0/svc-000.log",
          rotationFamily: "svc-000.log",
          lineNumber: 4,
          byteOffset: 10,
          text: "ERROR timeout in gateway",
          wrapped: false,
          originalTimestamp: null,
          normalizedUtc: null,
          parseClass: "missing",
          contextBefore: [],
          contextAfter: [],
        },
        {
          evidenceId: EVIDENCE_C,
          relativePath: "hosts/host-2/svc-002.log",
          rotationFamily: "svc-002.log",
          lineNumber: 9,
          byteOffset: 40,
          text: "ERROR timeout in worker",
          wrapped: false,
          originalTimestamp: null,
          normalizedUtc: null,
          parseClass: "missing",
          contextBefore: [],
          contextAfter: [],
        },
      ],
      returned: 2,
      bounded: false,
      atLeast: 2,
      nextCursor: null,
      nextPageCursor: null,
      cancelled: false,
      corpusTruncated: false,
      coverageComplete: true,
      scannedLines: 24,
      scannedLinesTotal: 24,
      scopeFileCount: 3,
      timeFilterUnknownReason: null,
    });
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const hits = await screen.findByRole("list", { name: "Search matches" });
    expect(hits.textContent).toMatch(/svc-000\.log/);
    expect(hits.textContent).toMatch(/svc-002\.log/);
    expect(hits.textContent).toMatch(/1 match/);
    expect(hits.querySelectorAll(".log-workbench__hit-group")).toHaveLength(2);
    expect(hits.querySelector(".log-workbench__hit-row--current")).toBeTruthy();
    expect(
      hits.querySelector(".log-workbench__hit-row--current")?.textContent,
    ).toMatch(/hosts\/host-0\/svc-000\.log:4/);
  });

  it("keeps advanced filters closed and names how many are on", async () => {
    stubFetch();
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    const advanced = document.querySelector("details.log-workbench__search-advanced");
    expect(advanced?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Advanced filters")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Match mode"), { target: { value: "literal" } });
    fireEvent.change(screen.getByLabelText("Include terms"), { target: { value: "edge" } });
    expect(screen.getByText("Advanced filters (2 on)")).toBeTruthy();
  });

  it("links timezone uncertainty to the review panel without implying a zone", async () => {
    stubSizedWorkbench(3);
    render(
      <>
        <div hidden>
          <section id="triage-log-time-capture" tabIndex={-1}>Capture review</section>
        </div>
        <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />
        <section id="triage-log-time" tabIndex={-1} data-testid="visible-timezone-review">
          Analyze review
        </section>
      </>,
    );
    const link = await screen.findByRole("link", { name: "Open Timezone review" });
    expect(link).toBeTruthy();
    expect(link.getAttribute("href")).toBe(
      "#triage-log-time",
    );
    fireEvent.click(link);
    expect(window.location.hash).toBe("#triage-log-time");
    expect(document.activeElement).toBe(screen.getByTestId("visible-timezone-review"));
    expect(screen.getByText(/nothing here will guess one/i)).toBeTruthy();
  });

  it("marks inventory loading as busy for assistive tech", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(document.getElementById("log-workbench")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(/Loading this investigation/)).toBeTruthy();
  });
});

describe("Log workbench selection helpers", () => {
  it("filters by label or path and groups hits in file order", () => {
    const files = [
      { displayLabel: "edge.log", relativePath: "gateway/edge.log" },
      { displayLabel: "batch.log", relativePath: "worker/batch.log" },
      { displayLabel: "offset.log", relativePath: "mailer/offset.log" },
    ];
    expect(filterInvestigationLogs(files, "batch")).toEqual([files[1]]);
    expect(filterInvestigationLogs(files, "gateway")).toEqual([files[0]]);
    const grouped = groupSearchMatches([
      { relativePath: "gateway/edge.log" },
      { relativePath: "worker/batch.log" },
      { relativePath: "gateway/edge.log" },
    ]);
    expect(grouped.map((group) => group.displayLabel)).toEqual(["edge.log", "batch.log"]);
    expect(grouped[0]?.entries.map((entry) => entry.index)).toEqual([0, 2]);
    expect(
      countAdvancedFilters({
        mode: "case_insensitive",
        include: "",
        exclude: "",
        severity: "",
        timeFrom: "",
        timeTo: "",
      }),
    ).toBe(0);
    expect(
      countAdvancedFilters({
        mode: "regex",
        include: "edge",
        exclude: "",
        severity: "",
        timeFrom: "",
        timeTo: "",
      }),
    ).toBe(2);
  });

  it("keeps the file-picker virtual window bounded", () => {
    const window = virtualizedWindow({
      totalRows: 300,
      scrollTop: 0,
      rowHeight: WORKBENCH_VIRTUALIZATION.FILE_ROW_HEIGHT,
      viewportHeight: WORKBENCH_VIRTUALIZATION.FILE_VIEWPORT_HEIGHT,
      overscan: WORKBENCH_VIRTUALIZATION.FILE_OVERSCAN,
    });
    expect(window.resident).toBeLessThanOrEqual(40);
    expect(WORKBENCH_VIRTUALIZATION.MAX_PANES).toBe(4);
    expect(WORKBENCH_VIRTUALIZATION.FILE_VIRTUALIZE_AFTER).toBeLessThan(30);
  });
});
