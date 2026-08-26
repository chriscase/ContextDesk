import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogWorkbench, WORKBENCH_VIRTUALIZATION } from "./LogWorkbench.js";
import { virtualizedWindow } from "@cd-collab/contracts";

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
          cancelled: false,
          timeFilterApplied: false,
          timeFilterUnknownReason: null,
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
    expect(screen.getByText("Technical identifiers (3)")).toBeTruthy();
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
    expect(screen.getAllByText(/every match in the read lines/).length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "Search matches" }).textContent).toMatch(
      /upstream timeout/,
    );
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
  it("says so on Analyze when the corpus was only read part-way", async () => {
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
    expect(await screen.findByText(/more log lines than one read can cover/)).toBeTruthy();
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
            cancelled: false,
            corpusTruncated: true,
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
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(screen.getAllByText(/matches past the read limit were not counted/).length)
        .toBeGreaterThan(0),
    );
    expect(screen.queryByText(/^0 matches\./)).toBeNull();
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

  it("explains a file the bounded read never reached instead of an empty pane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workbench")) {
          return jsonResponse({ ...inventory(), corpusTruncated: true, unreadFiles: ["edge.log"] });
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/page")) {
          return jsonResponse(
            {
              error:
                "This investigation holds more log lines than one read can cover, so this file was not reached. Narrow the selected files and try again.",
            },
            409,
          );
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    expect(await screen.findByText(/this file was not reached/)).toBeTruthy();
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
    fireEvent.click(screen.getByLabelText("Show edge.log in a pane"));
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
