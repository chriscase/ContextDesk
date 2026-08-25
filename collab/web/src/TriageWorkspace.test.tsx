import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const sampleRun: RunRow = {
  id: "r1",
  sourceId: "s1",
  outputText: "The retry loop looks unbounded",
  corroborationState: "unverified",
  evidenceVisibility: "unknown",
  snapshotBinding: null,
  importerUsername: "alice",
  operatorUsername: "alice",
  promptText: null,
  promptCompleteness: "unknown",
};

const sampleRuns: RunRow[] = [sampleRun];

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
    expect(screen.getByText("Notes, observations, and next steps")).toBeTruthy();
    expect(screen.getByText("Paste analysis from another tool")).toBeTruthy();

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
    expect(screen.getByRole("option", { name: "Fixture chat assistant" })).toBeTruthy();
    expect(screen.getByText(/Remove passwords, tokens/i)).toBeTruthy();
    expect(screen.getByText(/I redacted secrets before save/)).toBeTruthy();
  });

  it("keeps optional identity and provenance fields behind closed disclosures", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const advanced = document.querySelectorAll<HTMLDetailsElement>(
      ".triage-capture__paths form .triage-advanced",
    );
    expect(advanced.length).toBe(2);
    for (const details of advanced) expect(details.open).toBe(false);

    for (const name of ["outputText", "sourceId"]) {
      const field = document.querySelector(`[name="${name}"]`) as HTMLElement;
      expect(field.closest("details")).toBeNull();
    }
    for (const name of ["operatorUsername", "operatorId", "evidenceVisibility", "visibilityNote", "snapshotBinding"]) {
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
    fireEvent.change(screen.getByRole("combobox", { name: "Supporting record" }), {
      target: { value: "n1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    expect(props.onCorroborate).toHaveBeenCalledWith("r1", "corroborated", "n1");
  });
});

describe("triage workspace guidance and provenance", () => {
  it("focuses the exact typed contribution from a shareable activity route", async () => {
    const scrollIntoView = vi.fn();
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<TriageWorkspace {...makeProps({
        routeFocus: {
          section: "triage-capture",
          item: "n1",
          itemKind: "contribution",
          lane: null,
          experiment: null,
        },
      })} />);
      const item = screen.getByText("Queue depth spiked at 14:02").closest("li") as HTMLElement;
      await waitFor(() => expect(document.activeElement).toBe(item));
      expect(item.closest("details")?.open).toBe(true);
      expect(item.dataset.routeItem).toBe("n1");
      expect(item.dataset.routeKind).toBe("contribution");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
    }
  });

  it("renders a human-readable activity narrative and keeps raw audit identities closed", () => {
    render(<TriageWorkspace {...makeProps()} />);
    expect(screen.getByRole("heading", { name: "The investigation was opened" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A human note was recorded" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The investigation was opened" }).closest("li")?.textContent)
      .toContain("by alice");
    expect(screen.getByRole("heading", { name: "A human note was recorded" }).closest("li")?.textContent)
      .toContain("by alice");
    expect(screen.getByText(/adds human-attributed context to the shared investigation record/)).toBeTruthy();
    const auditDetails = screen.getAllByText("Raw audit details").map((summary) =>
      summary.closest("details") as HTMLDetailsElement,
    );
    expect(auditDetails.every((details) => details.open === false)).toBe(true);
    expect(auditDetails[1]?.textContent).toContain("n1");
    expect(auditDetails[1]?.textContent).toContain("contribution_created");
  });

  it("does not repeat the shell's stage navigation inside Capture", () => {
    render(<TriageWorkspace {...makeProps()} />);
    expect(screen.queryByRole("navigation", { name: "Triage steps" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Capture evidence and observations" })).toBeTruthy();
  });

  it("keeps the empty Capture state focused on the three ways to add material", () => {
    render(<TriageWorkspace {...makeProps({ contributions: [], runs: [], events: [] })} />);
    expect(screen.getByText("Notes, observations, and next steps")).toBeTruthy();
    expect(screen.getByText("Paste analysis from another tool")).toBeTruthy();
    expect(screen.queryByText("start here")).toBeNull();
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

  it("collapses a long audit history by default while keeping a short new-case history open", () => {
    const longEvents = Array.from({ length: 6 }, (_, index) => ({
      ...sampleEvents[0]!,
      seq: index + 1,
    }));
    const view = render(<TriageWorkspace {...makeProps({ events: longEvents })} />);
    expect((screen.getByText("Case timeline · 6 events").closest("details") as HTMLDetailsElement).open).toBe(false);
    view.rerender(<TriageWorkspace {...makeProps({ events: sampleEvents })} />);
    expect((screen.getByText("Case timeline · 2 events").closest("details") as HTMLDetailsElement).open).toBe(true);
  });

  it("never claims the AI decides, wins, or verifies", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("AI decides");
    expect(text).not.toContain("AI winner");
    expect(text).toContain("until a person checks it against the evidence");
  });

  it("keeps capture guidance source-neutral with no AI-universal or signature claims", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Output from another AI");
    expect(text).not.toContain("signed evidence package");
    expect(text).toContain("a chat answer, diagnostic report, or other analysis");
    expect(text).toContain("Remove passwords, tokens, and other secrets before saving");
  });
});

describe("imported-run source attribution", () => {
  function importedCard(): HTMLElement {
    return document.querySelector(".imported-run") as HTMLElement;
  }

  it("shows recognizable source metadata and keeps the exact id in technical details", () => {
    render(<TriageWorkspace {...makeProps()} />);
    const card = importedCard();
    const primary = card.querySelector(":scope > .catalog__meta") as HTMLElement;
    expect(primary.textContent).toContain("From Fixture chat assistant");
    expect(primary.textContent).not.toContain("s1");
    const technical = card.querySelector("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    expect(technical.textContent).toContain("Recorded source ID: s1");
  });

  it("shows a source whose recorded kind is unknown as unknown, not a guess", () => {
    render(
      <TriageWorkspace
        {...makeProps({
          sources: [{ id: "s9", name: "Unattributed paste", kind: "unknown" }],
          runs: [{ ...sampleRun, sourceId: "s9" }],
        })}
      />,
    );
    const card = importedCard();
    const primary = card.querySelector(":scope > .catalog__meta") as HTMLElement;
    expect(primary.textContent).toContain("From Unattributed paste");
    expect(primary.textContent).not.toContain("s9");
    expect(card.querySelector("details")?.textContent).toContain("Recorded source ID: s9");
  });

  it("renders an unmatched source id verbatim with catalog-metadata-unavailable wording", () => {
    render(
      <TriageWorkspace
        {...makeProps({ runs: [{ ...sampleRun, sourceId: "src-gone-042" }] })}
      />,
    );
    const card = importedCard();
    const primary = card.querySelector(":scope > .catalog__meta") as HTMLElement;
    expect(primary.textContent).toContain("Recorded source metadata unavailable");
    expect(primary.textContent).not.toContain("src-gone-042");
    expect(primary.textContent).not.toContain("Fixture chat assistant");
    expect(card.querySelector("details")?.textContent).toContain("Recorded source ID: src-gone-042");
  });
});

describe("retired-source-safe manual intake", () => {
  const activeSource = {
    id: "s1",
    name: "Fixture chat assistant",
    kind: "external-tool",
    lifecycle: "active",
  };
  const retiredSource = {
    id: "s2",
    name: "Legacy scanner",
    kind: "external-tool",
    lifecycle: "retired",
  };

  function sourceChooser(): HTMLSelectElement {
    return screen.getByRole("combobox", { name: "External run source" }) as HTMLSelectElement;
  }

  it("offers active sources in the new-intake chooser and excludes retired ones", () => {
    render(<TriageWorkspace {...makeProps({ sources: [activeSource, retiredSource] })} />);
    expect(
      screen.getByRole("option", { name: "Fixture chat assistant" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Legacy scanner (external-tool)" })).toBeNull();
    const chooser = sourceChooser();
    fireEvent.change(chooser, { target: { value: "s1" } });
    expect(chooser.value).toBe("s1");
  });

  it("keeps a source without a recorded lifecycle selectable rather than guessing retired", () => {
    render(<TriageWorkspace {...makeProps()} />);
    expect(
      screen.getByRole("option", { name: "Fixture chat assistant" }),
    ).toBeTruthy();
    expect(screen.queryByText(/All registered sources are retired/)).toBeNull();
  });

  it("resolves a historical imported run's retired source name and kind from the catalog", () => {
    render(
      <TriageWorkspace
        {...makeProps({
          sources: [retiredSource],
          runs: [{ ...sampleRun, sourceId: "s2" }],
        })}
      />,
    );
    const card = document.querySelector(".imported-run") as HTMLElement;
    const primary = card.querySelector(":scope > .catalog__meta") as HTMLElement;
    expect(primary.textContent).toContain("From Legacy scanner");
    expect(primary.textContent).not.toContain("s2");
    expect(card.querySelector("details")?.textContent).toContain("Recorded source ID: s2");
    expect(card.textContent).not.toContain("Recorded source metadata unavailable");
    expect(screen.queryByRole("option", { name: "Legacy scanner" })).toBeNull();
  });

  it("gives honest, actionable guidance when every registered source is retired", () => {
    render(<TriageWorkspace {...makeProps({ sources: [retiredSource] })} />);
    const hint = screen.getByText(/All attribution labels are retired/);
    expect(hint.textContent).toContain("A case lead can add an available label in Attribution");
    expect(hint.textContent).toContain("older imports keep their original attribution");
    expect(screen.queryByText(/No attribution labels are available yet/)).toBeNull();
    const selectable = Array.from(sourceChooser().options).filter((option) => !option.disabled);
    expect(selectable.length).toBe(0);
  });

  it("keeps the register-a-source guidance when no sources exist at all", () => {
    render(<TriageWorkspace {...makeProps({ sources: [] })} />);
    expect(screen.getByText(/No attribution labels are available yet/)).toBeTruthy();
    expect(screen.queryByText(/All attribution labels are retired/)).toBeNull();
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
