import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const CASE_B = "99999999-9999-4999-8999-999999999999";
const EVIDENCE_A = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_B = "55555555-5555-4555-8555-555555555555";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
  it("does not load or event-reload while Analyze is mounted but inactive", async () => {
    stubFetch();
    const view = render(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active={false} />,
    );
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(
        new CustomEvent("contextdesk:evidence-changed", { detail: { caseId: CASE_ID } }),
      );
      window.dispatchEvent(
        new CustomEvent("contextdesk:log-time-changed", { detail: { caseId: CASE_ID } }),
      );
    });
    await waitFor(() => expect(fetch).not.toHaveBeenCalled());

    view.rerender(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />);
    await waitFor(() => {
      const inventoryReads = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([input, init]) => String(input).endsWith("/workbench") && !init?.method,
      );
      expect(inventoryReads).toHaveLength(1);
    });
  });

  it("does not publish an inventory reply that finishes after Analyze becomes inactive", async () => {
    const pendingInventory = deferred<Response>();
    let inventoryReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) {
          inventoryReads += 1;
          if (inventoryReads === 1) return pendingInventory.promise;
          const fresh = inventory();
          fresh.items[0] = {
            ...fresh.items[0]!,
            relativePath: "fresh-return.log",
            displayLabel: "fresh-return.log",
          };
          fresh.items = fresh.items.slice(0, 1);
          fresh.normalizationRevision = 4;
          return jsonResponse(fresh);
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) {
          return jsonResponse({ candidateCount: 0 });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    const view = render(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />,
    );
    await waitFor(() => expect(inventoryReads).toBe(1));
    view.rerender(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active={false} />,
    );

    const stale = inventory();
    stale.items[0] = {
      ...stale.items[0]!,
      relativePath: "stale-hidden.log",
      displayLabel: "stale-hidden.log",
    };
    stale.items = stale.items.slice(0, 1);
    await act(async () => {
      pendingInventory.resolve(jsonResponse(stale));
      await pendingInventory.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("stale-hidden.log")).toBeNull();
    expect(inventoryReads).toBe(1);

    view.rerender(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />,
    );
    expect(await screen.findByLabelText("Show fresh-return.log in a pane")).toBeTruthy();
    expect(inventoryReads).toBe(2);
  });

  it("does not expose completed stale inventory while a hidden change reloads", async () => {
    const freshInventory = deferred<Response>();
    let inventoryReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) {
          inventoryReads += 1;
          if (inventoryReads === 1) {
            const stale = inventory();
            stale.items[0] = {
              ...stale.items[0]!,
              relativePath: "stale-ready.log",
              displayLabel: "stale-ready.log",
            };
            stale.items = stale.items.slice(0, 1);
            return jsonResponse(stale);
          }
          return freshInventory.promise;
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) {
          return jsonResponse({ candidateCount: 0 });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    const view = render(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />,
    );
    expect(await screen.findByLabelText("Show stale-ready.log in a pane")).toBeTruthy();

    view.rerender(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active={false} />,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("contextdesk:evidence-changed", { detail: { caseId: CASE_ID } }),
      );
    });
    expect(inventoryReads).toBe(1);

    view.rerender(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />,
    );
    expect(screen.queryByText("stale-ready.log")).toBeNull();
    expect(screen.getByText(/Loading this investigation’s logs/i)).toBeTruthy();
    await waitFor(() => expect(inventoryReads).toBe(2));

    const fresh = inventory();
    fresh.items[0] = {
      ...fresh.items[0]!,
      relativePath: "fresh-after-hidden.log",
      displayLabel: "fresh-after-hidden.log",
    };
    fresh.items = fresh.items.slice(0, 1);
    await act(async () => {
      freshInventory.resolve(jsonResponse(fresh));
      await freshInventory.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByLabelText("Show fresh-after-hidden.log in a pane")).toBeTruthy();
    expect(screen.queryByText("stale-ready.log")).toBeNull();
  });

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
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Save view" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Show merged chronology" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.change(screen.getByLabelText("Find in logs"), { target: { value: "timeout" } });
    fireEvent.keyDown(screen.getByLabelText("Find in logs"), { key: "Enter" });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(fetchCalls);
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
    fireEvent.change(screen.getByLabelText("Find in logs"), {
      target: { value: "a different request" },
    });
    expect(screen.queryByRole("list", { name: "Search matches" })).toBeNull();
    expect(screen.queryByText(/Every selected line was searched/)).toBeNull();
  });

  it("invalidates scoped results when a bookmark opens another evidence pane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) {
          return jsonResponse({
            bookmarks: [{
              id: "bookmark-second-file",
              note: "Open second file",
              status: "resolved",
              staleReason: null,
              locator: { evidenceId: EVIDENCE_B, lineNumber: 1 },
              shareSafeToken: "bookmark-second-file-token",
            }],
          });
        }
        if (url.includes("/workbench/review-queue")) {
          return jsonResponse({ candidateCount: 0 });
        }
        if (url.includes("/workbench/page")) {
          return jsonResponse({
            evidenceId: url.includes(encodeURIComponent(EVIDENCE_B)) ? EVIDENCE_B : EVIDENCE_A,
            relativePath: url.includes(encodeURIComponent(EVIDENCE_B))
              ? '<img src=x onerror=alert(1)>.log'
              : "gateway/edge.log",
            startLine: 1,
            rows: [],
            wrappedRowCount: 0,
            nextStartLine: null,
            bounded: false,
          });
        }
        if (url.includes("/workbench/search")) {
          return jsonResponse({
            matches: [{
              evidenceId: EVIDENCE_A,
              relativePath: "gateway/edge.log",
              rotationFamily: "gateway/edge.log",
              lineNumber: 1,
              byteOffset: 0,
              text: "result scoped only to the first pane",
              wrapped: false,
              originalTimestamp: null,
              normalizedUtc: null,
              parseClass: "missing",
              contextBefore: [],
              contextAfter: [],
            }],
            returned: 1,
            bounded: false,
            atLeast: 1,
            nextCursor: null,
            nextPageCursor: null,
            coverageComplete: true,
            timeFilterUnknownReason: null,
          });
        }
        if (url.includes("/workbench/chronology")) {
          return jsonResponse({
            events: [{
              evidenceId: EVIDENCE_A,
              relativePath: "gateway/edge.log",
              lineNumber: 1,
              excerpt: "chronology scoped only to the first pane",
              adjacencyReason: "order",
              uncertainty: [],
              correlationKind: "none",
              correlationId: null,
              originalTimestamp: null,
              normalizedUtc: null,
            }],
            unknownBuckets: [],
            bounded: false,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Show merged chronology" }));
    expect(await screen.findByText("result scoped only to the first pane")).toBeTruthy();
    expect(await screen.findByText("chronology scoped only to the first pane")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open second file" }));

    expect(screen.getByText(/2 of 4 panes open/)).toBeTruthy();
    expect(screen.queryByText("result scoped only to the first pane")).toBeNull();
    expect(screen.queryByText("chronology scoped only to the first pane")).toBeNull();
    expect(screen.queryByText(/Every selected line was searched/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Merged chronology" })).toBeNull();
  });

  it("preserves scoped results and explains when a bookmark would exceed four panes", async () => {
    const capIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
      "10000000-0000-4000-8000-000000000005",
    ] as const;
    const pageRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) {
          return jsonResponse({
            items: capIds.map((evidenceId, index) => ({
              evidenceId,
              relativePath: `worker/file-${index + 1}.log`,
              rotationFamily: `worker/file-${index + 1}.log`,
              displayLabel: `file-${index + 1}.log`,
              digest: String(index + 1).repeat(64),
              intakeBatchId: null,
              privacyClass: "owner_only",
              lineCount: 1,
            })),
            normalizationRevision: 3,
          });
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) {
          return jsonResponse({
            bookmarks: [{
              id: "bookmark-fifth-file",
              note: "Open fifth file",
              status: "resolved",
              staleReason: null,
              locator: { evidenceId: capIds[4], lineNumber: 1 },
              shareSafeToken: "bookmark-fifth-file-token",
            }],
          });
        }
        if (url.includes("/workbench/review-queue")) {
          return jsonResponse({ candidateCount: 0 });
        }
        if (url.includes("/workbench/page")) {
          pageRequests.push(url);
          const evidenceId = capIds.find((id) => url.includes(encodeURIComponent(id))) ?? capIds[0];
          return jsonResponse({
            evidenceId,
            relativePath: `worker/file-${capIds.indexOf(evidenceId) + 1}.log`,
            startLine: 1,
            rows: [],
            wrappedRowCount: 0,
            nextStartLine: null,
            bounded: false,
          });
        }
        if (url.includes("/workbench/search")) {
          return jsonResponse({
            matches: [{
              evidenceId: capIds[0],
              relativePath: "worker/file-1.log",
              rotationFamily: "worker/file-1.log",
              lineNumber: 1,
              byteOffset: 0,
              text: "preserved four-pane search result",
              wrapped: false,
              originalTimestamp: null,
              normalizedUtc: null,
              parseClass: "missing",
              contextBefore: [],
              contextAfter: [],
            }],
            returned: 1,
            bounded: false,
            atLeast: 1,
            nextCursor: null,
            nextPageCursor: null,
            coverageComplete: true,
            timeFilterUnknownReason: null,
          });
        }
        if (url.includes("/workbench/chronology")) {
          return jsonResponse({
            events: [{
              evidenceId: capIds[0],
              relativePath: "worker/file-1.log",
              lineNumber: 1,
              excerpt: "preserved four-pane chronology result",
              adjacencyReason: "order",
              uncertainty: [],
              correlationKind: "none",
              correlationId: null,
              originalTimestamp: null,
              normalizedUtc: null,
            }],
            unknownBuckets: [],
            bounded: false,
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    for (const name of ["file-2.log", "file-3.log", "file-4.log"]) {
      fireEvent.click(screen.getByLabelText(`Show ${name} in a pane`));
    }
    expect(screen.getByText(/4 of 4 panes open/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Show merged chronology" }));
    expect(await screen.findByText("preserved four-pane search result")).toBeTruthy();
    expect(await screen.findByText("preserved four-pane chronology result")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open fifth file" }));

    expect(screen.getByText(/Only 4 files can be open side by side/)).toBeTruthy();
    expect(screen.getByText("preserved four-pane search result")).toBeTruthy();
    expect(screen.getByText("preserved four-pane chronology result")).toBeTruthy();
    expect(screen.getByText(/4 of 4 panes open/)).toBeTruthy();
    expect(pageRequests.some((url) => url.includes(encodeURIComponent(capIds[4])))).toBe(false);
  });

  it("does not publish search or chronology responses after the file scope is cleared", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const searchGate = deferred<Response>();
    const chronologyGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workbench/search")) return searchGate.promise;
        if (url.includes("/workbench/chronology")) return chronologyGate.promise;
        return baseFetch(input, init);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Show merged chronology" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear open files" }));

    await act(async () => {
      searchGate.resolve(
        jsonResponse({
          matches: [{
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            rotationFamily: "gateway/edge.log",
            lineNumber: 1,
            byteOffset: 0,
            text: "obsolete search result",
            wrapped: false,
            originalTimestamp: null,
            normalizedUtc: null,
            parseClass: "missing",
            contextBefore: [],
            contextAfter: [],
          }],
          returned: 1,
          bounded: false,
          atLeast: 1,
          nextCursor: null,
          nextPageCursor: null,
          coverageComplete: true,
          timeFilterUnknownReason: null,
        }),
      );
      chronologyGate.resolve(
        jsonResponse({
          events: [{
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            lineNumber: 1,
            excerpt: "obsolete chronology result",
            adjacencyReason: "order",
            uncertainty: [],
            correlationKind: "none",
            correlationId: null,
            originalTimestamp: null,
            normalizedUtc: null,
          }],
          unknownBuckets: [],
          bounded: false,
        }),
      );
      await Promise.all([searchGate.promise, chronologyGate.promise]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("obsolete search result")).toBeNull();
    expect(screen.queryByText("obsolete chronology result")).toBeNull();
    expect(screen.queryByRole("list", { name: "Search matches" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Merged chronology" })).toBeNull();
  });

  it("does not publish responses started for a previous investigation", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const searchGate = deferred<Response>();
    const chronologyGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workbench/search")) return searchGate.promise;
        if (url.includes("/workbench/chronology")) return chronologyGate.promise;
        return baseFetch(input, init);
      }),
    );

    const view = render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Show merged chronology" }));
    view.rerender(<LogWorkbench caseId={CASE_B} canWrite readOnly={false} />);

    await act(async () => {
      searchGate.resolve(jsonResponse({
        matches: [{
          evidenceId: EVIDENCE_A,
          relativePath: "case-a.log",
          rotationFamily: "case-a.log",
          lineNumber: 1,
          byteOffset: 0,
          text: "previous investigation search",
          wrapped: false,
          originalTimestamp: null,
          normalizedUtc: null,
          parseClass: "missing",
          contextBefore: [],
          contextAfter: [],
        }],
        returned: 1,
        bounded: false,
        atLeast: 1,
        nextCursor: null,
        timeFilterUnknownReason: null,
      }));
      chronologyGate.resolve(jsonResponse({
        events: [{
          evidenceId: EVIDENCE_A,
          relativePath: "case-a.log",
          lineNumber: 1,
          excerpt: "previous investigation chronology",
          adjacencyReason: "order",
          uncertainty: [],
          correlationKind: "none",
          correlationId: null,
          originalTimestamp: null,
          normalizedUtc: null,
        }],
        unknownBuckets: [],
        bounded: false,
      }));
      await Promise.all([searchGate.promise, chronologyGate.promise]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByText(/1 of 4 panes open/)).toBeTruthy();
    expect(screen.queryByText("previous investigation search")).toBeNull();
    expect(screen.queryByText("previous investigation chronology")).toBeNull();
  });

  it("does not publish a delayed inventory from a previous investigation", async () => {
    const oldInventory = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/api/cases/${CASE_ID}/workbench`) && !init?.method) {
          return oldInventory.promise;
        }
        if (url.endsWith(`/api/cases/${CASE_B}/workbench`) && !init?.method) {
          return jsonResponse({
            items: [{
              evidenceId: EVIDENCE_B,
              relativePath: "case-b/current.log",
              rotationFamily: "case-b/current.log",
              displayLabel: "current-case-b.log",
              digest: "b".repeat(64),
              intakeBatchId: null,
              privacyClass: "owner_only",
              lineCount: 1,
            }],
            normalizationRevision: 4,
          });
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        if (url.includes("/workbench/page")) {
          return jsonResponse({
            evidenceId: EVIDENCE_B,
            relativePath: "case-b/current.log",
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

    const view = render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    view.rerender(<LogWorkbench caseId={CASE_B} canWrite readOnly={false} />);
    expect((await screen.findAllByText("current-case-b.log")).length).toBeGreaterThan(0);

    await act(async () => {
      oldInventory.resolve(jsonResponse({
        items: [{
          evidenceId: EVIDENCE_A,
          relativePath: "case-a/stale.log",
          rotationFamily: "case-a/stale.log",
          displayLabel: "stale-case-a.log",
          digest: "a".repeat(64),
          intakeBatchId: null,
          privacyClass: "owner_only",
          lineCount: 1,
        }],
        normalizationRevision: 3,
      }));
      await oldInventory.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getAllByText("current-case-b.log").length).toBeGreaterThan(0);
    expect(screen.queryByText("stale-case-a.log")).toBeNull();
  });

  it("does not start an old-case reload after a delayed save finishes", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const saveGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/api/cases/${CASE_ID}/workbench/views`) && init?.method === "POST") {
          return saveGate.promise;
        }
        return baseFetch(input, init);
      }),
    );

    const view = render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
    view.rerender(<LogWorkbench caseId={CASE_B} canWrite readOnly={false} />);
    await screen.findByRole("button", { name: "Search" });

    await act(async () => {
      saveGate.resolve(jsonResponse({ id: "saved-on-a" }));
      await saveGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const oldInventoryReads = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith(`/api/cases/${CASE_ID}/workbench`) && !init?.method,
    );
    expect(oldInventoryReads).toHaveLength(1);
    expect(screen.queryByText(/Saved view .* recorded/)).toBeNull();
  });

  it("does not restart hidden same-case reads after a delayed save finishes", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const saveGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/api/cases/${CASE_ID}/workbench/views`) && init?.method === "POST") {
          return saveGate.promise;
        }
        return baseFetch(input, init);
      }),
    );

    const view = render(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
    view.rerender(
      <LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active={false} />,
    );

    await act(async () => {
      saveGate.resolve(jsonResponse({ id: "saved-while-hidden" }));
      await saveGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const inventoryReads = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith(`/api/cases/${CASE_ID}/workbench`) && !init?.method,
    );
    expect(inventoryReads).toHaveLength(1);
    expect(screen.queryByText(/Saved view .* recorded/)).toBeNull();
  });

  it("clears case-owned views, bookmarks, and review counts before the next case is ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/workbench") && !init?.method) return jsonResponse(inventory());
        const isNextCase = url.includes(`/api/cases/${CASE_B}/`);
        if (url.includes("/workbench/views")) {
          return isNextCase
            ? jsonResponse({ error: "unavailable" }, 503)
            : jsonResponse({ views: [{
                id: "view-a",
                name: "Case A saved view",
                selectedPanes: [EVIDENCE_A],
                query: "timeout",
                mode: "literal",
              }] });
        }
        if (url.includes("/workbench/bookmarks")) {
          return isNextCase
            ? jsonResponse({ error: "unavailable" }, 503)
            : jsonResponse({ bookmarks: [{
                id: "bookmark-a",
                note: "Case A bookmark",
                status: "resolved",
                staleReason: null,
                locator: { evidenceId: EVIDENCE_A, lineNumber: 1 },
                shareSafeToken: "bookmark-a-token",
              }] });
        }
        if (url.includes("/workbench/review-queue")) {
          return isNextCase
            ? jsonResponse({ error: "unavailable" }, 503)
            : jsonResponse({ candidateCount: 2 });
        }
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

    const view = render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    expect(await screen.findByRole("button", { name: "Case A saved view" })).toBeTruthy();
    expect(screen.getByText("Case A bookmark")).toBeTruthy();
    expect(screen.getByText(/2 lines still have a clock/)).toBeTruthy();

    view.rerender(<LogWorkbench caseId={CASE_B} canWrite readOnly={false} />);
    await screen.findByRole("button", { name: "Search" });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Case A saved view" })).toBeNull();
      expect(screen.queryByText("Case A bookmark")).toBeNull();
      expect(screen.queryByText(/2 lines still have a clock/)).toBeNull();
    });
  });

  it("keeps a refreshed pane when an older same-case page response arrives late", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const oldPage = deferred<Response>();
    let pageCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workbench/page")) {
          pageCalls += 1;
          if (pageCalls === 1) return oldPage.promise;
          return jsonResponse({
            evidenceId: EVIDENCE_A,
            relativePath: "gateway/edge.log",
            startLine: 1,
            rows: [{
              evidenceId: EVIDENCE_A,
              relativePath: "gateway/edge.log",
              rotationFamily: "gateway/edge.log",
              lineNumber: 1,
              byteOffset: 0,
              text: "fresh normalized pane row",
              wrapped: false,
              originalTimestamp: null,
              normalizedUtc: "2024-03-10T08:10:00.000Z",
              parseClass: "host_resolved",
              contextBefore: [],
              contextAfter: [],
            }],
            wrappedRowCount: 0,
            nextStartLine: null,
            bounded: false,
          });
        }
        return baseFetch(input, init);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("button", { name: "Search" });
    await waitFor(() => expect(pageCalls).toBe(1));
    window.dispatchEvent(
      new CustomEvent("contextdesk:log-time-changed", { detail: { caseId: CASE_ID } }),
    );
    expect(await screen.findByText("fresh normalized pane row")).toBeTruthy();

    await act(async () => {
      oldPage.resolve(jsonResponse({
        evidenceId: EVIDENCE_A,
        relativePath: "gateway/edge.log",
        startLine: 1,
        rows: [{
          evidenceId: EVIDENCE_A,
          relativePath: "gateway/edge.log",
          rotationFamily: "gateway/edge.log",
          lineNumber: 1,
          byteOffset: 0,
          text: "obsolete normalized pane row",
          wrapped: false,
          originalTimestamp: null,
          normalizedUtc: null,
          parseClass: "missing",
          contextBefore: [],
          contextAfter: [],
        }],
        wrappedRowCount: 0,
        nextStartLine: null,
        bounded: false,
      }));
      await oldPage.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText("fresh normalized pane row")).toBeTruthy();
    expect(screen.queryByText("obsolete normalized pane row")).toBeNull();
  });

  it.each([
    ["query", "Find in logs", "new query"],
    ["match mode", "Match mode", "literal"],
    ["include filter", "Include terms", "required"],
    ["exclude filter", "Exclude terms", "ignored"],
    ["severity filter", "Severity", "error"],
    ["start time", "From (UTC)", "2024-03-10T08:00:00Z"],
    ["end time", "To (UTC)", "2024-03-10T09:00:00Z"],
  ])("invalidates a pending search when the %s changes", async (_name, label, value) => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const searchGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workbench/search")) return searchGate.promise;
        return baseFetch(input, init);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

    await act(async () => {
      searchGate.resolve(jsonResponse({
        matches: [{
          evidenceId: EVIDENCE_A,
          relativePath: "stale.log",
          rotationFamily: "stale.log",
          lineNumber: 1,
          byteOffset: 0,
          text: "stale search control result",
          wrapped: false,
          originalTimestamp: null,
          normalizedUtc: null,
          parseClass: "missing",
          contextBefore: [],
          contextAfter: [],
        }],
        returned: 1,
        bounded: false,
        atLeast: 1,
        nextCursor: null,
        timeFilterUnknownReason: null,
      }));
      await searchGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("stale search control result")).toBeNull();
    expect(screen.queryByText(/Every selected line was searched/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Search matches" })).toBeNull();
  });

  it("invalidates a pending chronology when grouping changes", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const chronologyGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/workbench/chronology")) return chronologyGate.promise;
        return baseFetch(input, init);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show merged chronology" }));
    fireEvent.change(screen.getByLabelText("Chronology grouping"), {
      target: { value: "component" },
    });
    await act(async () => {
      chronologyGate.resolve(jsonResponse({
        events: [{
          evidenceId: EVIDENCE_A,
          relativePath: "stale.log",
          lineNumber: 1,
          excerpt: "stale chronology grouping result",
          adjacencyReason: "order",
          uncertainty: [],
          correlationKind: "none",
          correlationId: null,
          originalTimestamp: null,
          normalizedUtc: null,
        }],
        unknownBuckets: [],
        bounded: false,
      }));
      await chronologyGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("stale chronology grouping result")).toBeNull();
    expect(screen.queryByRole("region", { name: "Merged chronology" })).toBeNull();
  });

  it("does not rebuild an obsolete chronology scope after a delayed pin finishes", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const anchorGate = deferred<Response>();
    let chronologyCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workbench/chronology")) {
          chronologyCalls += 1;
          return jsonResponse({
            events: [{
              evidenceId: EVIDENCE_A,
              relativePath: "gateway/edge.log",
              lineNumber: 1,
              excerpt: "pin this chronology row",
              adjacencyReason: "order",
              uncertainty: [],
              correlationKind: "none",
              correlationId: null,
              originalTimestamp: null,
              normalizedUtc: null,
            }],
            unknownBuckets: [],
            bounded: false,
          });
        }
        if (url.includes("/workbench/anchors") && init?.method === "POST") {
          return anchorGate.promise;
        }
        return baseFetch(input, init);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} active />);
    fireEvent.click(await screen.findByRole("button", { name: "Show merged chronology" }));
    expect(await screen.findByText("pin this chronology row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin as benchmark" }));
    fireEvent.change(screen.getByLabelText("Chronology grouping"), {
      target: { value: "component" },
    });

    await act(async () => {
      anchorGate.resolve(jsonResponse({ id: "anchor-recorded" }));
      await anchorGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(chronologyCalls).toBe(1);
    expect(screen.queryByText("Benchmark pin recorded.")).toBeNull();
    expect(screen.queryByRole("region", { name: "Merged chronology" })).toBeNull();
  });

  it("invalidates pending search and chronology results when the corpus reloads", async () => {
    stubFetch();
    const baseFetch = fetch as ReturnType<typeof vi.fn>;
    const searchGate = deferred<Response>();
    const chronologyGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/workbench/search")) return searchGate.promise;
        if (url.includes("/workbench/chronology")) return chronologyGate.promise;
        return baseFetch(input, init);
      }),
    );

    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Show merged chronology" }));
    window.dispatchEvent(
      new CustomEvent("contextdesk:evidence-changed", { detail: { caseId: CASE_ID } }),
    );
    await act(async () => {
      searchGate.resolve(jsonResponse({
        matches: [], returned: 0, bounded: false, atLeast: 0, nextCursor: null,
        timeFilterUnknownReason: null,
      }));
      chronologyGate.resolve(jsonResponse({ events: [], unknownBuckets: [], bounded: false }));
      await Promise.all([searchGate.promise, chronologyGate.promise]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText(/Every selected line was searched/)).toBeNull();
    expect(screen.queryByText(/Merged chronology built/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Search matches" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Merged chronology" })).toBeNull();
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
    fireEvent.click(
      await screen.findByRole("button", { name: "Show merged chronology" }),
    );
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
    stubSizedWorkbench(30, {
      matches: [{
        evidenceId: EVIDENCE_A,
        relativePath: "hosts/host-0/svc-000.log",
        rotationFamily: "svc-000.log",
        lineNumber: 1,
        byteOffset: 0,
        text: "preserved search result",
        wrapped: false,
        originalTimestamp: null,
        normalizedUtc: null,
        parseClass: "missing",
        contextBefore: [],
        contextAfter: [],
      }],
      returned: 1,
      bounded: false,
      atLeast: 1,
      nextCursor: null,
      nextPageCursor: null,
      coverageComplete: true,
      timeFilterUnknownReason: null,
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("preserved search result")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show svc-004.log in a pane"));
    expect(screen.getByText(/Only 4 files can be open side by side/)).toBeTruthy();
    expect(screen.getByText(/4 of 4 panes open/)).toBeTruthy();
    expect((screen.getByLabelText("Show svc-004.log in a pane") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.getByText("preserved search result")).toBeTruthy();

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
