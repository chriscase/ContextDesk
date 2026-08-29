import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogChronologyPanel } from "./LogChronologyPanel.js";

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CASE_B = "99999999-9999-4999-8999-999999999999";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    source: "gateway/edge.log",
    rawTimestamp: null,
    normalizedInstant: "2024-03-10T07:30:00Z",
    timeState: "resolved",
    timestampProvenance: "explicit_wall",
    orderOnlyReason: null,
    level: "info",
    message: "edge accepted synthetic request",
    ...overrides,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.log_chronology_page.v1",
    caseId: CASE_ID,
    corpusId: "corpus-synthetic-0001",
    corpusRevision: 2,
    search: null,
    sources: [],
    rows: [
      row(),
      row({
        seq: 2,
        source: "worker/batch.log",
        rawTimestamp: "2024-03-10 02:30:00",
        normalizedInstant: null,
        timeState: "order_only",
        timestampProvenance: "unresolved_local",
        orderOnlyReason: "nonexistent_dst_gap",
        level: "warn",
        message: "worker heartbeat retained in order-only evidence",
      }),
    ],
    nextCursor: null,
    totalMatched: 2,
    orderOnlyCount: 1,
    timeQuality: "mixed",
    ...overrides,
  };
}

function stubFetch(responses: unknown[]) {
  const urls: string[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      urls.push(String(input));
      const body = responses[Math.min(index++, responses.length - 1)];
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  return urls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LogChronologyPanel", () => {
  it("shows cross-source resolved rows beside explicit order-only fold/gap state", async () => {
    stubFetch([page()]);
    render(<LogChronologyPanel caseId={CASE_ID} />);

    const table = await screen.findByRole("table");
    expect(within(table).getByText("gateway/edge.log")).toBeTruthy();
    expect(within(table).getByText("worker/batch.log")).toBeTruthy();
    expect(within(table).getByText("2024-03-10T07:30:00Z")).toBeTruthy();
    expect(within(table).getByText("2024-03-10 02:30:00")).toBeTruthy();
    expect(within(table).getByText(/DST gap — local time never happened/i)).toBeTruthy();
    expect(screen.getByText(/no timezone, DST fold, or DST gap is guessed/i)).toBeTruthy();
  });

  it("sends literal search and exact source filters", async () => {
    const urls = stubFetch([page(), page({ rows: [], totalMatched: 0, orderOnlyCount: 0, timeQuality: "order_only" })]);
    render(<LogChronologyPanel caseId={CASE_ID} />);
    await screen.findByRole("table");

    fireEvent.change(screen.getByLabelText("Search log messages"), {
      target: { value: "100%_literal" },
    });
    fireEvent.change(screen.getByLabelText("Filter by source"), {
      target: { value: "worker/batch.log" },
    });

    await waitFor(() => expect(urls.length).toBeGreaterThanOrEqual(2));
    const filtered = new URL(urls.at(-1) as string, "http://localhost");
    expect(filtered.searchParams.get("search")).toBe("100%_literal");
    expect(filtered.searchParams.getAll("sources")).toEqual(["worker/batch.log"]);
  });

  it("uses the opaque cursor to append a stable next page", async () => {
    const first = page({ nextCursor: "opaque-cursor-1" });
    const second = page({
      rows: [row({ seq: 3, source: "worker/batch.log", message: "second page evidence" })],
      nextCursor: null,
      totalMatched: 3,
      orderOnlyCount: 1,
    });
    const urls = stubFetch([first, second]);
    render(<LogChronologyPanel caseId={CASE_ID} />);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: "Load more chronology" }));
    expect(await screen.findByText("second page evidence")).toBeTruthy();
    const next = new URL(urls.at(-1) as string, "http://localhost");
    expect(next.searchParams.get("cursor")).toBe("opaque-cursor-1");
  });

  it("keeps the rendered chronology bounded and free of secret-shaped text", async () => {
    stubFetch([
      page({
        rows: [row({ message: "redacted synthetic marker" })],
      }),
    ]);
    render(<LogChronologyPanel caseId={CASE_ID} />);
    await screen.findByRole("table");
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(document.body.textContent).not.toMatch(/Authorization/i);
    expect(document.body.textContent).not.toMatch(/\/Users\//);
  });

  it("refreshes its read snapshot when the existing timezone surface signals a change", async () => {
    const refreshed = page({
      rows: [row({ message: "fresh chronology after timezone change" })],
      totalMatched: 1,
      orderOnlyCount: 0,
      timeQuality: "wall",
    });
    stubFetch([page(), refreshed]);
    render(<LogChronologyPanel caseId={CASE_ID} />);
    await screen.findByRole("table");

    act(() => {
      window.dispatchEvent(
        new CustomEvent("contextdesk:log-time-changed", { detail: { caseId: CASE_ID } }),
      );
    });
    expect(await screen.findByText("fresh chronology after timezone change")).toBeTruthy();
  });

  it("clears the old chronology while a timezone refresh is pending and keeps it clear on failure", async () => {
    const refreshGate = deferred<Response>();
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads += 1;
        if (reads === 1) return jsonResponse(page());
        return refreshGate.promise;
      }),
    );
    render(<LogChronologyPanel caseId={CASE_ID} />);
    expect(await screen.findByText("edge accepted synthetic request")).toBeTruthy();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("contextdesk:log-time-changed", { detail: { caseId: CASE_ID } }),
      );
    });
    expect(screen.queryByText("edge accepted synthetic request")).toBeNull();
    expect(screen.getByText("Loading chronology…")).toBeTruthy();

    await act(async () => {
      refreshGate.resolve(jsonResponse({ error: "refresh failed" }, 503));
      await refreshGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "refresh failed",
    );
    expect(screen.queryByText("edge accepted synthetic request")).toBeNull();
    expect(screen.queryByText(/revision 2/)).toBeNull();
  });

  it("invalidates a hidden chronology without reloading it until Analyze becomes active", async () => {
    const refreshed = page({
      rows: [row({ message: "fresh chronology after returning to Analyze" })],
      totalMatched: 1,
      orderOnlyCount: 0,
      timeQuality: "wall",
    });
    stubFetch([page(), refreshed]);
    const view = render(<LogChronologyPanel caseId={CASE_ID} active />);
    expect(await screen.findByText("edge accepted synthetic request")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);

    view.rerender(<LogChronologyPanel caseId={CASE_ID} active={false} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("contextdesk:log-time-changed", { detail: { caseId: CASE_ID } }),
      );
    });
    expect(screen.queryByText("edge accepted synthetic request")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    view.rerender(<LogChronologyPanel caseId={CASE_ID} active />);
    expect(await screen.findByText("fresh chronology after returning to Analyze")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not publish a delayed chronology from a previous investigation", async () => {
    const oldCaseLoad = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/api/cases/${CASE_ID}/`)) return oldCaseLoad.promise;
        if (url.includes(`/api/cases/${CASE_B}/`)) {
          return jsonResponse(
            page({
              caseId: CASE_B,
              rows: [row({ source: "case-b/current.log", message: "current case B row" })],
              totalMatched: 1,
              orderOnlyCount: 0,
              timeQuality: "wall",
            }),
          );
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    const view = render(<LogChronologyPanel caseId={CASE_ID} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    view.rerender(<LogChronologyPanel caseId={CASE_B} />);
    expect(await screen.findByText("current case B row")).toBeTruthy();

    await act(async () => {
      oldCaseLoad.resolve(
        jsonResponse(
          page({ rows: [row({ message: "stale case A row" })], totalMatched: 1 }),
        ),
      );
      await oldCaseLoad.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("current case B row")).toBeTruthy();
    expect(screen.queryByText("stale case A row")).toBeNull();
  });
});

/**
 * The panel now renders inside the investigation workspace, so a reply it
 * cannot read must degrade to an error rather than throwing during render and
 * taking the whole stage down with it.
 */
describe("LogChronologyPanel resilience", () => {
  it("reports a reply it cannot read instead of crashing the stage", async () => {
    stubFetch([{ rows: [], corpusRevision: 2 }]);
    render(<LogChronologyPanel caseId={CASE_ID} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read/);
  });

  it("does not read the corpus while its stage is mounted but hidden", async () => {
    const urls = stubFetch([page()]);
    const view = render(<LogChronologyPanel caseId={CASE_ID} active={false} />);
    await waitFor(() => expect(urls).toEqual([]));
    view.rerender(<LogChronologyPanel caseId={CASE_ID} active />);
    await waitFor(() => expect(urls.length).toBe(1));
  });

  it("does not query the corpus once per keystroke while a filter is typed", async () => {
    vi.useFakeTimers();
    try {
      const urls = stubFetch([page()]);
      render(<LogChronologyPanel caseId={CASE_ID} />);
      await vi.advanceTimersByTimeAsync(300);
      const afterFirstLoad = urls.length;
      const search = screen.getByLabelText("Search log messages");
      for (const value of ["t", "ti", "tim", "time", "timeo"]) {
        fireEvent.change(search, { target: { value } });
        await vi.advanceTimersByTimeAsync(40);
      }
      expect(urls.length).toBe(afterFirstLoad);
      await vi.advanceTimersByTimeAsync(300);
      expect(urls.length).toBe(afterFirstLoad + 1);
      expect(urls.at(-1)).toContain("search=timeo");
    } finally {
      vi.useRealTimers();
    }
  });
});
