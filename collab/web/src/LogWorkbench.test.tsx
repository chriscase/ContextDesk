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
        });
      }
      if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
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
    await waitFor(() => expect(screen.getAllByText(/1 matches/).length).toBeGreaterThan(0));
    expect(screen.getByRole("list", { name: "Search matches" }).textContent).toMatch(
      /upstream timeout/,
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
