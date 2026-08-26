/**
 * The log workbench file chooser at three, thirty, and three hundred files.
 *
 * One investigation imports three files and another imports three hundred, and
 * the same chooser has to stay honest in both. These tests pin the properties
 * that make that true: the small case stays a plain list, the large case stays
 * bounded and still reaches every file, a full pane set refuses the next file
 * out loud instead of evicting one, and nothing on screen ever grows a raw
 * evidence id.
 *
 * Every fixture here is generated, deterministic, and synthetic — no captured
 * log, path, or identifier from any real system.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogWorkbench, chooserStatus, fileMatchesFilter } from "./LogWorkbench.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const MAX_PANES = 4;
/** Mirrors FILE_PAGE in LogWorkbench.tsx: the rows one page keeps resident. */
const FILE_PAGE = 25;

/** Folder shapes, including two nested ones, so path filtering is provable. */
const FOLDERS = ["gateway", "worker/batch", "mailer", "scheduler/nightly", "edge/pop-01"];

function syntheticId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function label(index: number): string {
  return `service-${String(index).padStart(3, "0")}.log`;
}

function folder(index: number): string {
  return FOLDERS[index % FOLDERS.length] as string;
}

/** `count` files, generated the same way on every run. */
function syntheticInventory(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    evidenceId: syntheticId(index),
    relativePath: `${folder(index)}/${label(index)}`,
    rotationFamily: `${folder(index)}/${label(index)}`,
    displayLabel: label(index),
    digest: index.toString(16).padStart(64, "0"),
    intakeBatchId: null,
    privacyClass: "owner_only",
    lineCount: 12,
  }));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubInventory(count: number, options: { views?: unknown[] } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/workbench") && !init?.method) {
        return jsonResponse({
          items: syntheticInventory(count),
          normalizationRevision: 1,
        });
      }
      if (url.includes("/workbench/views")) return jsonResponse({ views: options.views ?? [] });
      if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
      if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
      if (url.includes("/workbench/page")) {
        return jsonResponse({
          evidenceId: syntheticId(0),
          relativePath: `${folder(0)}/${label(0)}`,
          startLine: 1,
          rows: [
            {
              evidenceId: syntheticId(0),
              relativePath: `${folder(0)}/${label(0)}`,
              rotationFamily: `${folder(0)}/${label(0)}`,
              lineNumber: 1,
              byteOffset: 0,
              text: "2024-03-10T08:00:00Z INFO synthetic line",
              wrapped: false,
              originalTimestamp: "2024-03-10T08:00:00Z",
              normalizedUtc: "2024-03-10T08:00:00.000Z",
              parseClass: "iso8601",
              contextBefore: [],
              contextAfter: [],
            },
          ],
          wrappedRowCount: 0,
          nextStartLine: null,
          bounded: false,
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    }),
  );
}

async function mount(count: number, options: { views?: unknown[] } = {}) {
  stubInventory(count, options);
  render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
  await screen.findByRole("heading", { name: "Log workbench" });
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
}

/** The chooser rows actually in the DOM — the bound these tests care about. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-workbench-file]"));
}

function rowLabels(): string[] {
  return rows().map((row) => row.querySelector("strong")?.textContent ?? "");
}

function statusText(): string {
  return document.querySelector("[data-workbench-file-status]")?.textContent ?? "";
}

function noticeText(): string {
  return document.querySelector(".log-workbench__live")?.textContent ?? "";
}

function filterInput(): HTMLInputElement {
  return screen.getByLabelText("Filter by name or folder") as HTMLInputElement;
}

function typeFilter(value: string) {
  fireEvent.change(filterInput(), { target: { value } });
}

function checkbox(index: number): HTMLInputElement {
  return screen.getByLabelText(`Show ${label(index)} in a pane`) as HTMLInputElement;
}

describe("Log workbench chooser — three files stay calm", () => {
  it("offers a plain list with no filter, pager, or bulk action", async () => {
    await mount(3);
    expect(rowLabels()).toEqual(["service-000.log", "service-001.log", "service-002.log"]);
    expect(screen.queryByLabelText("Filter by name or folder")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select visible" })).toBeNull();
    expect(screen.queryByRole("group", { name: "File list pages" })).toBeNull();
    expect(statusText()).toBe("3 files. No file is open yet.");
  });

  it("still offers Clear selection once a file is open", async () => {
    await mount(3);
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
    fireEvent.click(checkbox(1));
    expect(checkbox(1).checked).toBe(true);
    expect(statusText()).toBe("3 files. 1 of 4 panes in use.");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(checkbox(1).checked).toBe(false);
    expect(noticeText()).toContain("Cleared the file selection.");
  });
});

describe("Log workbench chooser — thirty files stay findable", () => {
  it("filters by a nested folder path and states how much it hid", async () => {
    await mount(30);
    expect(rows()).toHaveLength(FILE_PAGE);
    typeFilter("scheduler/nightly");
    // indices 3, 8, 13, 18, 23, 28 land in scheduler/nightly
    expect(rowLabels()).toEqual([
      "service-003.log",
      "service-008.log",
      "service-013.log",
      "service-018.log",
      "service-023.log",
      "service-028.log",
    ]);
    expect(statusText()).toBe("6 of 30 files match this filter. No file is open yet.");
  });

  it("filters by file name", async () => {
    await mount(30);
    typeFilter("service-007");
    expect(rowLabels()).toEqual(["service-007.log"]);
    expect(statusText()).toBe("1 of 30 files matches this filter. No file is open yet.");
  });

  it("never matches a raw evidence id or digest, and says so when nothing matches", async () => {
    await mount(30);
    typeFilter(syntheticId(7));
    expect(rows()).toHaveLength(0);
    expect(statusText()).toBe(
      "No file matches this filter. This investigation has 30 files. No file is open yet.",
    );
    expect(
      screen.getByText(/The filter\s+reads file names and the folders they arrived in/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(filterInput().value).toBe("");
    expect(rows()).toHaveLength(FILE_PAGE);
  });

  it("keeps a checked file checked and listed while a filter excludes it", async () => {
    await mount(30);
    fireEvent.click(checkbox(0));
    expect(checkbox(0).checked).toBe(true);
    typeFilter("scheduler/nightly");
    // service-000 is in gateway/, so the filter excludes it — but a pane the
    // reader opened must stay closable, so the row is listed and still checked.
    expect(checkbox(0).checked).toBe(true);
    expect(rowLabels()).toContain("service-000.log");
    expect(statusText()).toBe(
      "6 of 30 files match this filter. 1 open file is listed too, so you can close it. 1 of 4 panes in use.",
    );
    typeFilter("");
    expect(checkbox(0).checked).toBe(true);
    expect(statusText()).toBe("Showing 1–25 of 30 files. 1 of 4 panes in use.");
  });

  it("refuses a fifth pane out loud without replacing one already open", async () => {
    await mount(30);
    for (const index of [0, 1, 2, 3]) fireEvent.click(checkbox(index));
    expect([0, 1, 2, 3].map((index) => checkbox(index).checked)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(statusText()).toContain("4 of 4 panes in use — the maximum.");
    const limit = document.getElementById("log-workbench-pane-limit");
    expect(limit?.textContent).toContain("4 panes is the maximum");
    expect(checkbox(4).getAttribute("aria-disabled")).toBe("true");
    expect(checkbox(4).getAttribute("aria-describedby")).toBe("log-workbench-pane-limit");
    // The blocked control stays reachable, so a keyboard reader can hear why.
    expect(checkbox(4).disabled).toBe(false);

    fireEvent.click(checkbox(4));
    expect(checkbox(4).checked).toBe(false);
    expect([0, 1, 2, 3].map((index) => checkbox(index).checked)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(noticeText()).toContain("“service-004.log” did not open");
    expect(noticeText()).toContain("nothing already open was closed");
  });

  it("selects visible files up to the pane limit and reports what did not fit", async () => {
    await mount(30);
    typeFilter("scheduler/nightly");
    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect([3, 8, 13, 18].map((index) => checkbox(index).checked)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(checkbox(23).checked).toBe(false);
    expect(checkbox(28).checked).toBe(false);
    expect(noticeText()).toContain("Opened 4 more files.");
    expect(noticeText()).toContain("2 listed files did not fit");
    expect(noticeText()).toContain("nothing already open was closed");
  });

  it("adds nothing and says why when Select visible runs at the pane limit", async () => {
    await mount(30);
    for (const index of [0, 1, 2, 3]) fireEvent.click(checkbox(index));
    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(checkbox(4).checked).toBe(false);
    expect(noticeText()).toContain("Nothing was opened: 4 panes are already open");
  });
});

describe("Log workbench chooser — three hundred files stay bounded", () => {
  it("keeps resident rows bounded and states which slice is on screen", async () => {
    await mount(300);
    expect(rows()).toHaveLength(FILE_PAGE);
    expect(rows().length).toBeLessThanOrEqual(FILE_PAGE + MAX_PANES);
    expect(statusText()).toBe("Showing 1–25 of 300 files. No file is open yet.");
    expect(rowLabels()[0]).toBe("service-000.log");
    expect(rowLabels().at(-1)).toBe("service-024.log");
  });

  it("stays bounded with four panes open", async () => {
    await mount(300);
    for (const index of [0, 1, 2, 3]) fireEvent.click(checkbox(index));
    expect(rows().length).toBeLessThanOrEqual(FILE_PAGE + MAX_PANES);
    fireEvent.click(screen.getByRole("button", { name: "More files" }));
    // The four open files are pinned onto a page that does not contain them.
    expect(rows()).toHaveLength(FILE_PAGE + MAX_PANES);
    expect([0, 1, 2, 3].map((index) => checkbox(index).checked)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("reaches a file on the last page through the pager", async () => {
    await mount(300);
    const pager = screen.getByRole("group", { name: "File list pages" });
    expect(pager.textContent).toContain("Page 1 of 12");
    expect(screen.getByRole("button", { name: "Previous files" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "More files" }));
    expect(pager.textContent).toContain("Page 2 of 12");
    expect(rowLabels()[0]).toBe("service-025.log");
    expect(statusText()).toBe("Showing 26–50 of 300 files. No file is open yet.");
    fireEvent.click(screen.getByRole("button", { name: "Previous files" }));
    expect(rowLabels()[0]).toBe("service-000.log");
  });

  it("reaches any file through the filter, including the last one", async () => {
    await mount(300);
    typeFilter("service-299");
    expect(rowLabels()).toEqual(["service-299.log"]);
    fireEvent.click(checkbox(299));
    expect(checkbox(299).checked).toBe(true);
  });

  it("resets to the first page when the filter changes", async () => {
    await mount(300);
    fireEvent.click(screen.getByRole("button", { name: "More files" }));
    expect(rowLabels()[0]).toBe("service-025.log");
    typeFilter("edge/pop-01");
    expect(rowLabels()[0]).toBe("service-004.log");
    expect(statusText()).toContain("60 of 300 files match this filter. Showing 1–25.");
  });

  it("keeps every rendered technical identity closed behind its own disclosure", async () => {
    await mount(300);
    const disclosures = Array.from(
      document.querySelectorAll<HTMLDetailsElement>("details.log-workbench__file-details"),
    );
    expect(disclosures).toHaveLength(FILE_PAGE);
    expect(disclosures.every((details) => details.open)).toBe(false);
    expect(disclosures.some((details) => details.open)).toBe(false);
    for (const [index, row] of rows().entries()) {
      const details = row.querySelector("details.log-workbench__file-details");
      // The id is reachable, and only from inside the disclosure — the row's
      // primary copy names the file the way a person does.
      expect(details?.textContent).toContain(syntheticId(index));
      const primary = row.querySelector(".log-workbench__file-copy")?.textContent ?? "";
      expect(primary).not.toContain(syntheticId(index));
      expect(primary).not.toContain(index.toString(16).padStart(64, "0"));
    }
  });
});

describe("Log workbench chooser — keyboard and saved views", () => {
  it("drives filter, selection, and paging from focusable native controls", async () => {
    await mount(300);
    const filter = filterInput();
    filter.focus();
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "scheduler/nightly" } });

    const first = checkbox(3);
    first.focus();
    expect(document.activeElement).toBe(first);
    // Space on a focused checkbox dispatches a click; the row opens a pane.
    fireEvent.click(first);
    expect(first.checked).toBe(true);

    const summary = rows()[0]?.querySelector<HTMLElement>(
      "details.log-workbench__file-details > summary",
    );
    expect(summary).toBeTruthy();
    summary?.focus();
    expect(document.activeElement).toBe(summary);

    fireEvent.change(filterInput(), { target: { value: "" } });
    const next = screen.getByRole("button", { name: "More files" });
    next.focus();
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(rowLabels()).toContain("service-025.log");
    // Paging never drops what the keyboard already opened.
    expect(checkbox(3).checked).toBe(true);
  });

  it("applies a saved view and clears a filter that would hide its files", async () => {
    await mount(30, {
      views: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Nightly sweep",
          selectedPanes: [syntheticId(1), syntheticId(2)],
          query: "timeout",
          mode: "literal",
          filters: { includeTerms: [], excludeTerms: [], severity: null },
          sort: "time_asc",
          grouping: "file",
          display: { syncScroll: true },
        },
      ],
    });
    typeFilter("scheduler/nightly");
    expect(rowLabels()).not.toContain("service-001.log");
    fireEvent.click(screen.getByRole("button", { name: "Nightly sweep" }));
    expect(filterInput().value).toBe("");
    expect(checkbox(1).checked).toBe(true);
    expect(checkbox(2).checked).toBe(true);
    expect(statusText()).toBe("Showing 1–25 of 30 files. 2 of 4 panes in use.");
  });
});

describe("Log workbench chooser — inventory states", () => {
  it("names the empty investigation instead of showing an empty list", async () => {
    stubInventory(0);
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    await screen.findByRole("heading", { name: "Log workbench" });
    await waitFor(() =>
      expect(screen.getByText(/This investigation has no imported logs yet/)).toBeTruthy(),
    );
    expect(rows()).toHaveLength(0);
  });

  it("announces the load and offers a retry when the inventory fails", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/workbench")) {
          calls += 1;
          if (calls === 1) return jsonResponse({ error: "inventory_unavailable" }, 500);
          return jsonResponse({ items: syntheticInventory(3), normalizationRevision: 1 });
        }
        if (url.includes("/workbench/views")) return jsonResponse({ views: [] });
        if (url.includes("/workbench/bookmarks")) return jsonResponse({ bookmarks: [] });
        if (url.includes("/workbench/review-queue")) return jsonResponse({ candidateCount: 0 });
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );
    render(<LogWorkbench caseId={CASE_ID} canWrite readOnly={false} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("inventory_unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });
});

describe("chooser projections", () => {
  it("reads only the human name and the path", () => {
    const item = { displayLabel: "edge.log", relativePath: "gateway/pop-01/edge.log" };
    expect(fileMatchesFilter(item, "")).toBe(true);
    expect(fileMatchesFilter(item, "  ")).toBe(true);
    expect(fileMatchesFilter(item, "EDGE")).toBe(true);
    expect(fileMatchesFilter(item, "pop-01")).toBe(true);
    expect(fileMatchesFilter(item, "gateway/pop-01")).toBe(true);
    // Both tokens must land, so a second word narrows rather than widens.
    expect(fileMatchesFilter(item, "gateway edge")).toBe(true);
    expect(fileMatchesFilter(item, "gateway worker")).toBe(false);
    // Nothing the record is addressed by is filterable, so nothing pastes one
    // onto the screen.
    expect(fileMatchesFilter(item, syntheticId(4))).toBe(false);
    expect(fileMatchesFilter(item, "a".repeat(64))).toBe(false);
  });

  it("states the slice, the hidden remainder, and the pane limit", () => {
    expect(
      chooserStatus({
        total: 3,
        matching: 3,
        filtered: false,
        from: 1,
        to: 3,
        pinned: 0,
        selected: 0,
        maxPanes: 4,
      }),
    ).toBe("3 files. No file is open yet.");
    expect(
      chooserStatus({
        total: 300,
        matching: 300,
        filtered: false,
        from: 1,
        to: 25,
        pinned: 0,
        selected: 2,
        maxPanes: 4,
      }),
    ).toBe("Showing 1–25 of 300 files. 2 of 4 panes in use.");
    expect(
      chooserStatus({
        total: 300,
        matching: 60,
        filtered: true,
        from: 1,
        to: 25,
        pinned: 1,
        selected: 4,
        maxPanes: 4,
      }),
    ).toBe(
      "60 of 300 files match this filter. Showing 1–25. 1 open file is listed too, so you can close it. 4 of 4 panes in use — the maximum. Clear one to open another.",
    );
    expect(
      chooserStatus({
        total: 30,
        matching: 0,
        filtered: true,
        from: 0,
        to: 0,
        pinned: 0,
        selected: 0,
        maxPanes: 4,
      }),
    ).toBe("No file matches this filter. This investigation has 30 files. No file is open yet.");
  });
});

/**
 * jsdom runs no layout engine, so the measured 390px proof lives in the
 * Playwright journey (`specs/26-log-workbench.spec.ts`), which reads real
 * geometry. What is deterministic here is the stylesheet contract that journey
 * depends on: nothing in the chooser may set a width the phone cannot hold,
 * and every control it adds keeps a 44px-equivalent target.
 */
describe("Log workbench chooser stylesheet contract", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "styles", "log-workbench.css"),
    "utf8",
  );

  function block(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `${selector} is missing from log-workbench.css`).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  }

  it("keeps 44px-equivalent targets on every control the chooser adds", () => {
    for (const selector of [
      ".log-workbench .log-workbench__file-filter > input",
      ".log-workbench .log-workbench__file-action",
      ".log-workbench__file > .log-workbench__file-details > summary",
    ]) {
      expect(block(selector)).toContain("min-height: 2.75rem");
    }
    // 2.75rem at the 16px root is 44px; the row itself is the checkbox target.
    expect(block(".log-workbench__file")).toContain("min-height: 2.75rem");
  });

  it("contains the chooser inside a 390px viewport", () => {
    const containment = block(
      ".log-workbench__files,\n.log-workbench__file,\n.log-workbench__file-tools,\n.log-workbench__file-pager",
    );
    expect(containment).toContain("max-width: 100%");
    expect(containment).toContain("min-width: 0");
    expect(block(".log-workbench__file-tools")).toContain("flex-wrap: wrap");
    expect(block(".log-workbench__file-pager")).toContain("flex-wrap: wrap");
    expect(block(".log-workbench__file-filter")).toContain("min-width: 0");
    expect(block(".log-workbench__file-copy > small")).toContain("overflow-wrap: anywhere");
    expect(block(".log-workbench__file-empty > p")).toContain("overflow-wrap: anywhere");
  });

  it("gives every chooser control a visible focus ring", () => {
    const focus = block(
      ".log-workbench .log-workbench__file-filter > input:focus-visible,\n"
        + ".log-workbench .log-workbench__file-action:focus-visible,\n"
        + ".log-workbench .log-workbench__file > input:focus-visible,\n"
        + ".log-workbench .log-workbench__file > .log-workbench__file-details > summary:focus-visible",
    );
    expect(focus).toContain("outline: 2px solid var(--accent)");
  });

  it("draws the chooser from theme tokens rather than fixed colours", () => {
    for (const selector of [
      ".log-workbench .log-workbench__file-filter > input",
      ".log-workbench .log-workbench__file-action",
      ".log-workbench__files-status",
      ".log-workbench__file-limit",
    ]) {
      const rule = block(selector);
      expect(rule).toMatch(/var\(--/);
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
