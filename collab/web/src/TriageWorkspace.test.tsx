import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import {
  TriageAnchor,
  TriageStepSection,
  TriageWorkspace,
  type ContributionView,
  type RunRow,
  type TimelineEvent,
} from "./TriageWorkspace.js";

afterEach(() => {
  cleanup();
});

const sampleEvents: TimelineEvent[] = [
  {
    seq: 1,
    kind: "case_created",
    actorUsername: "alice",
    serverTime: "2026-08-15T00:00:00.000Z",
    payload: "{}",
  },
  {
    seq: 2,
    kind: "contribution_created",
    actorUsername: "alice",
    targetId: "n1",
    serverTime: "2026-08-15T00:01:00.000Z",
    payload: '{"kind":"note"}',
  },
];

const sampleContributions: ContributionView[] = [
  {
    id: "n1",
    kind: "note",
    body: "Queue depth spiked at 14:02",
    privacyClass: "owner_only",
    tombstoned: false,
  },
];

const sampleRuns: RunRow[] = [
  {
    id: "r1",
    outputText: "The retry loop looks unbounded",
    corroborationState: "unverified",
    evidenceVisibility: "unknown",
    snapshotBinding: null,
    importerUsername: "alice",
    operatorUsername: "alice",
    promptText: null,
    promptCompleteness: "unknown",
  },
];

function makeProps(overrides?: Partial<Parameters<typeof TriageWorkspace>[0]>) {
  return {
    canWrite: true,
    readOnly: false,
    sources: [{ id: "s1", name: "Fixture chat assistant", kind: "external-tool" }],
    events: sampleEvents,
    contributions: sampleContributions,
    runs: sampleRuns,
    importError: null,
    onAddNote: vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault()),
    onImportRun: vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault()),
    onCorroborate: vi.fn(),
    ...overrides,
  };
}

describe("triage workspace capture paths", () => {
  it("renders both first-class capture paths with every existing payload field", () => {
    render(<TriageWorkspace {...makeProps()} />);
    expect(screen.getByText("Your own findings")).toBeTruthy();
    expect(screen.getByText("Output from another AI")).toBeTruthy();

    const noteKind = screen.getByRole("combobox", { name: "Timeline entry kind" });
    expect((noteKind as HTMLSelectElement).value).toBe("note");
    const privacy = screen.getByRole("combobox", { name: "Timeline entry visibility" });
    expect((privacy as HTMLSelectElement).value).toBe("owner_only");
    expect(screen.getByRole("textbox", { name: "Timeline entry body" })).toBeTruthy();

    for (const name of [
      "outputText",
      "promptText",
      "sourceId",
      "operatorUsername",
      "operatorId",
      "evidenceVisibility",
      "visibilityNote",
      "snapshotBinding",
      "redacted",
    ]) {
      expect(document.querySelector(`[name="${name}"]`)).toBeTruthy();
    }
    const visibility = document.querySelector(
      'select[name="evidenceVisibility"]',
    ) as HTMLSelectElement;
    expect(visibility.value).toBe("unknown");
    expect(screen.getByRole("option", { name: "Fixture chat assistant (external-tool)" })).toBeTruthy();
    expect(screen.getByText(/mask them before saving/i)).toBeTruthy();
    expect(screen.getByText(/I redacted secrets before save/)).toBeTruthy();
  });

  it("keeps advanced provenance fields behind closed disclosure and required fields outside it", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const advanced = document.querySelectorAll<HTMLDetailsElement>(".triage-advanced");
    expect(advanced.length).toBe(2);
    for (const details of advanced) expect(details.open).toBe(false);

    for (const name of ["outputText", "sourceId", "operatorUsername", "operatorId"]) {
      const field = document.querySelector(`[name="${name}"]`) as HTMLElement;
      expect(field.closest("details")).toBeNull();
    }
    for (const name of ["evidenceVisibility", "visibilityNote", "snapshotBinding"]) {
      const field = document.querySelector(`[name="${name}"]`) as HTMLElement;
      expect(field.closest("details")).toBeTruthy();
    }
    const privacy = document.querySelector('select[name="privacyClass"]') as HTMLElement;
    expect(privacy.closest("details")).toBeTruthy();
  });

  it("submits capture forms through the provided handlers", () => {
    const props = makeProps();
    render(<TriageWorkspace {...props} />);
    const noteForm = screen
      .getByRole("button", { name: "Add to timeline" })
      .closest("form") as HTMLFormElement;
    fireEvent.submit(noteForm);
    expect(props.onAddNote).toHaveBeenCalledTimes(1);

    const importForm = screen
      .getByRole("button", { name: "Import external run" })
      .closest("form") as HTMLFormElement;
    fireEvent.submit(importForm);
    expect(props.onImportRun).toHaveBeenCalledTimes(1);
  });

  it("shows the import error next to the import form and keeps typed values", () => {
    const props = makeProps();
    const view = render(<TriageWorkspace {...props} />);
    const output = document.querySelector('textarea[name="outputText"]') as HTMLTextAreaElement;
    fireEvent.change(output, { target: { value: "half-finished paste" } });
    view.rerender(
      <TriageWorkspace
        {...props}
        importError="External run could not be imported. Review the fields and try again."
      />,
    );
    expect((screen.getByRole("alert")).textContent).toBe(
      "External run could not be imported. Review the fields and try again.",
    );
    expect(output.value).toBe("half-finished paste");
  });

  it("passes human corroboration through to the handler", () => {
    const props = makeProps();
    render(<TriageWorkspace {...props} />);
    expect(screen.getByText("Unverified imported run")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Evidence or contribution id"), {
      target: { value: "n1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record human judgment" }));
    expect(props.onCorroborate).toHaveBeenCalledWith("r1", "corroborated", "n1");
  });
});

describe("triage workspace guidance and provenance", () => {
  it("renders the step rail with anchors for all four steps", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const rail = screen.getByRole("navigation", { name: "Triage steps" });
    const hrefs = Array.from(rail.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#triage-capture", "#triage-analyze", "#triage-compare", "#triage-decide"]);
    expect(screen.queryByText("start here")).toBeNull();
    expect(screen.getByText("2 recorded items")).toBeTruthy();
  });

  it("suggests starting with capture only when nothing is recorded yet", () => {
    render(<TriageWorkspace {...makeProps({ contributions: [], runs: [], events: [] })} />);
    expect(screen.getByText("start here")).toBeTruthy();
    expect(screen.getByText("0 recorded items")).toBeTruthy();
  });

  it("labels the three provenance classes and tags human entries on the timeline", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const legend = screen.getByRole("list", { name: "Provenance classes" });
    expect(legend.textContent).toContain("human-authored");
    expect(legend.textContent).toContain("imported · unverified");
    expect(legend.textContent).toContain("ContextDesk model run");

    expect(screen.getByText("1 human entry · 1 imported run")).toBeTruthy();
    expect(screen.getByText("Queue depth spiked at 14:02")).toBeTruthy();
    const contributionItem = screen
      .getByText("Queue depth spiked at 14:02")
      .closest(".timeline__item") as HTMLElement;
    expect(contributionItem.textContent).toContain("human-authored");
  });

  it("labels imported-run mirror contributions as imported, never human-authored", () => {
    const mirrorEvents: TimelineEvent[] = [
      ...sampleEvents,
      {
        seq: 3,
        kind: "contribution_created",
        actorUsername: "demo",
        targetId: "x1",
        serverTime: "2026-08-15T00:02:00.000Z",
        payload: '{"kind":"external_run"}',
      },
    ];
    const mirrorContributions: ContributionView[] = [
      ...sampleContributions,
      {
        id: "x1",
        kind: "external_run",
        body: "Imported external run (021c67dd7b21)",
        privacyClass: "owner_only",
        tombstoned: false,
      },
    ];
    render(
      <TriageWorkspace
        {...makeProps({ events: mirrorEvents, contributions: mirrorContributions })}
      />,
    );
    const item = screen
      .getByText("Imported external run (021c67dd7b21)")
      .closest(".timeline__item") as HTMLElement;
    expect(item.textContent).toContain("imported output");
    expect(item.textContent).not.toContain("human-authored");
    expect(screen.getByText("1 human entry · 1 imported run")).toBeTruthy();
  });

  it("keeps the timeline region focusable for keyboard scrolling", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const region = screen.getByRole("region", { name: "Case timeline events" });
    expect(region.tabIndex).toBe(0);
    const capture = document.querySelector("#triage-capture") as HTMLElement;
    expect(capture.tabIndex).toBe(-1);
  });

  it("never claims the AI decides, wins, or verifies", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("never rewrite your material or declare a winner");
    expect(text).toContain("unverified until a person corroborates");
  });
});

describe("triage workspace permissions", () => {
  it("hides all mutation controls in static read-only mode but keeps the record browsable", () => {
    render(<TriageWorkspace {...makeProps({ canWrite: false, readOnly: true })} />);
    for (const label of ["Add to timeline", "Import external run", "Record human judgment"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(document.querySelector("form")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Static read-only view");
    expect(screen.getByText("Unverified imported run")).toBeTruthy();
    expect(screen.getByText("Queue depth spiked at 14:02")).toBeTruthy();
  });

  it("explains missing write access to signed-in viewers", () => {
    render(<TriageWorkspace {...makeProps({ canWrite: false, readOnly: false })} />);
    expect(document.querySelector("form")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "review the case record but not add to it",
    );
  });
});

describe("step and anchor wrappers", () => {
  it("renders a labeled, focusable step section", () => {
    render(
      <TriageStepSection id="triage-demo" step={2} title="Analyze" lede="Freeze first.">
        <p>panel goes here</p>
      </TriageStepSection>,
    );
    const section = document.querySelector("#triage-demo") as HTMLElement;
    expect(section.tabIndex).toBe(-1);
    expect(section.getAttribute("aria-labelledby")).toBe("triage-demo-title");
    expect(screen.getByRole("heading", { name: "Analyze" })).toBeTruthy();
    expect(screen.getByText("panel goes here")).toBeTruthy();
  });

  it("renders a labeled, focusable panel anchor", () => {
    render(
      <TriageAnchor id="triage-lane-runner" label="AI lane runner">
        <p>runner</p>
      </TriageAnchor>,
    );
    const anchor = screen.getByRole("region", { name: "AI lane runner" });
    expect(anchor.id).toBe("triage-lane-runner");
    expect(anchor.tabIndex).toBe(-1);
    expect(screen.getByText("runner")).toBeTruthy();
  });
});
