import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { defaultMockPreview } from "@contextdesk/client";
import { EvidenceSelector } from "./EvidenceSelector";
import {
  INITIAL_IMPORT_FLOW_STATE,
  importFlowReducer,
  preselectedIdentities,
  type ImportFlowState,
} from "./importFlowState";

function Harness() {
  const report = defaultMockPreview();
  const initial: ImportFlowState = {
    ...INITIAL_IMPORT_FLOW_STATE,
    stage: "selector",
    report,
    selected: preselectedIdentities(report),
  };
  const [state, dispatch] = useReducer(importFlowReducer, initial);
  return (
    <EvidenceSelector report={state.report!} selected={state.selected} dispatch={dispatch} />
  );
}

function grid(): HTMLElement {
  return screen.getByRole("treegrid", { name: "Discovered items" });
}

describe("EvidenceSelector keyboard and focus", () => {
  it("Space toggles the focused leaf and containers via tri-state checkbox", () => {
    render(<Harness />);
    const treegrid = grid();
    treegrid.focus();
    // First row is the api/ container; move to its first leaf.
    fireEvent.keyDown(treegrid, { key: "ArrowDown" });
    fireEvent.keyDown(treegrid, { key: " " });
    const gateway = within(treegrid).getByRole("checkbox", {
      name: /api\/api-gateway\.log/,
    }) as HTMLInputElement;
    expect(gateway.checked).toBe(false);
    // Space on the container row now selects all selectable descendants.
    fireEvent.keyDown(treegrid, { key: "ArrowUp" });
    fireEvent.keyDown(treegrid, { key: " " });
    expect(
      (
        within(treegrid).getByRole("checkbox", {
          name: /api\/api-gateway\.log/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("container checkbox announces mixed state accessibly", () => {
    render(<Harness />);
    const treegrid = grid();
    // Deselect one of the two api/ leaves directly.
    fireEvent.click(
      within(treegrid).getByRole("checkbox", { name: /api\/payments\.jsonl/ }),
    );
    const container = within(treegrid).getByRole("checkbox", {
      name: /api\/ — partially selected/,
    }) as HTMLInputElement;
    expect(container.indeterminate).toBe(true);
  });

  it("blocked rows expose a disabled, labelled checkbox — visible, never selectable", () => {
    render(<Harness />);
    const blocked = within(grid()).getByRole("checkbox", {
      name: /inner\.zip.*not selectable/,
    }) as HTMLInputElement;
    expect(blocked.disabled).toBe(true);
    expect(
      within(grid()).getByText("Nested deeper than 3 archives — not expanded"),
    ).toBeTruthy();
  });

  it("explains XML parser limits while keeping the supporting row disabled", () => {
    const report = defaultMockPreview();
    report.items = [
      {
        ...report.items[0],
        identity: "attachments/diagnostic-report.xml",
        basename: "diagnostic-report.xml",
        status: "supporting",
        role: "attachment",
        selected: false,
        reasons: ["xml_event_parsing_unsupported"],
      },
    ];

    render(<EvidenceSelector report={report} selected={new Set()} dispatch={() => undefined} />);
    const source = within(grid()).getByRole("checkbox", {
      name: /diagnostic-report\.xml.*not selectable/,
    }) as HTMLInputElement;
    expect(source.disabled).toBe(true);
    expect(
      screen.getByText(/XML event parsing is not supported yet/),
    ).toBeTruthy();
  });

  it("explains source-quality and HTML parser limits on supporting rows", () => {
    const report = defaultMockPreview();
    report.items = [
      {
        ...report.items[0],
        identity: "attachments/probe-output.txt",
        basename: "probe-output.txt",
        status: "supporting",
        role: "attachment",
        selected: false,
        reasons: ["insufficient_event_evidence"],
      },
      {
        ...report.items[0],
        identity: "attachments/status-page.html",
        basename: "status-page.html",
        status: "supporting",
        role: "attachment",
        selected: false,
        reasons: ["html_event_parsing_unsupported"],
      },
    ];

    render(<EvidenceSelector report={report} selected={new Set()} dispatch={() => undefined} />);
    const probe = within(grid()).getByRole("checkbox", {
      name: /probe-output\.txt.*not selectable/,
    }) as HTMLInputElement;
    const html = within(grid()).getByRole("checkbox", {
      name: /status-page\.html.*not selectable/,
    }) as HTMLInputElement;
    expect(probe.disabled).toBe(true);
    expect(html.disabled).toBe(true);
    expect(
      screen.getByText(/Not enough repeated event records for automatic log import/),
    ).toBeTruthy();
    expect(screen.getByText(/HTML event parsing is not supported yet/)).toBeTruthy();
  });

  it("collapse and expand with arrow keys hide members but keep the container", () => {
    render(<Harness />);
    const treegrid = grid();
    treegrid.focus();
    // Row 0 is api/ container: collapse it.
    fireEvent.keyDown(treegrid, { key: "ArrowLeft" });
    expect(
      within(treegrid).queryByRole("checkbox", { name: /api\/api-gateway\.log/ }),
    ).toBeNull();
    fireEvent.keyDown(treegrid, { key: "ArrowRight" });
    expect(
      within(treegrid).getByRole("checkbox", { name: /api\/api-gateway\.log/ }),
    ).toBeTruthy();
  });

  it("status filters narrow rows without mutating selection", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Blocked 1/ }));
    const rows = within(grid()).getAllByRole("row");
    // Only the blocked leaf and its containers remain.
    expect(
      within(grid()).queryByRole("checkbox", { name: /api\/api-gateway\.log/ }),
    ).toBeNull();
    expect(rows.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Blocked 1/ }));
    const gateway = within(grid()).getByRole("checkbox", {
      name: /api\/api-gateway\.log/,
    }) as HTMLInputElement;
    expect(gateway.checked).toBe(true);
  });

  it("renders archive identities as segmented breadcrumbs", () => {
    render(<Harness />);
    const archiveRow = within(grid()).getByText("logs/app.log");
    expect(archiveRow.closest(".import-selector__name--archive")).toBeTruthy();
  });

  it("summary announces discovered and selected counts", () => {
    render(<Harness />);
    expect(screen.getByText(/8 discovered · 4 selected/)).toBeTruthy();
  });
});

it("shows supporting evidence as inert text without executing markup", () => {
  const report = defaultMockPreview();
  const item = report.items.find((entry) => entry.identity)!;
  item.status = "supporting";
  item.selected = false;
  item.representative = '<img src="https://invalid.example/asset" onerror="alert(1)"> readable evidence';
  render(<EvidenceSelector report={report} selected={new Set()} dispatch={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: `Inspect readable evidence from ${item.identity}` }));
  const region = screen.getByRole("region", { name: "Readable evidence preview" });
  expect(region.textContent).toContain("readable evidence");
  expect(region.querySelector("img")).toBeNull();
  expect(region.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close evidence preview" }));
  expect(screen.queryByRole("region", { name: "Readable evidence preview" })).toBeNull();
});

it("loads bounded evidence on demand and distinguishes unverified stylesheet visibility", async () => {
  const report = defaultMockPreview();
  const item = report.items[0];
  item.status = "supporting"; item.reasons = ["html_event_parsing_unsupported"];
  render(<EvidenceSelector report={report} selected={new Set()} dispatch={() => {}}
    onInspect={async (identity) => {
      expect(identity).toBe(item.identity);
      return { text: "", truncated: true, reason: "visibility_unverified_stylesheet" };
    }} />);
  fireEvent.click(screen.getByRole("button", { name: `Inspect readable evidence from ${item.identity}` }));
  expect(await screen.findByText(/Readable text unavailable: stylesheet-dependent visibility/)).toBeTruthy();
  expect(screen.queryByText(/Complete bounded visible text/)).toBeNull();
});

it("renders host inspected text literally with explicit truncation", async () => {
  const report = defaultMockPreview();
  report.items[0].status = "supporting"; report.items[0].reasons = ["html_event_parsing_unsupported"];
  render(<EvidenceSelector report={report} selected={new Set()} dispatch={() => {}}
    onInspect={async () => ({ text: "<script>never execute</script> retained text", truncated: true, reason: "ambiguous_structure" })} />);
  fireEvent.click(screen.getByRole("button", { name: `Inspect readable evidence from ${report.items[0].identity}` }));
  expect(await screen.findByText(/Truncated at the safe text limit/)).toBeTruthy();
  const region = screen.getByRole("region", { name: "Readable evidence preview" });
  expect(region.textContent).toContain("<script>never execute</script>");
  expect(region.querySelector("script")).toBeNull();
});

it("uses the representative without calling HTML host inspection for ordinary rows", () => {
  const report = defaultMockPreview();
  report.items[0].representative = "ordinary bounded log excerpt";
  let calls = 0;
  render(<EvidenceSelector report={report} selected={new Set()} dispatch={() => {}}
    onInspect={async () => { calls++; throw new Error("must not call"); }} />);
  fireEvent.click(screen.getByRole("button", { name: `Inspect readable evidence from ${report.items[0].identity}` }));
  expect(screen.getByText("ordinary bounded log excerpt")).toBeTruthy();
  expect(calls).toBe(0);
});
