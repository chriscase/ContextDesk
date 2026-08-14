import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TurnProgressTimeline } from "./TurnProgressTimeline";

describe("TurnProgressTimeline", () => {
  it("shows concise elapsed activity and keeps opaque diagnostics expandable", () => {
    render(
      <TurnProgressTimeline
        live
        events={[
          {
            category: "phase",
            stage: "retrieving_evidence",
            phase: "started",
            label: "Retrieving bounded evidence",
            elapsedMs: 125,
          },
          {
            category: "multi_model",
            stage: "reviewer",
            phase: "started",
            label: "Reviewing candidate findings",
            detail: "reviewing 2 candidate findings",
            candidateId: "opaque-candidate-7",
            elapsedMs: 1_250,
          },
        ]}
      />,
    );

    const timeline = screen.getByTestId("turn-progress-timeline");
    expect(timeline.hasAttribute("open")).toBe(true);
    expect(within(timeline).getByText("+125 ms")).toBeTruthy();
    expect(within(timeline).getByText("+1.3 s")).toBeTruthy();
    expect(within(timeline).getByText("Reviewing candidate findings")).toBeTruthy();
    const candidate = within(timeline).getByText("opaque-candidate-7");
    expect(candidate.closest("details")?.hasAttribute("open")).toBe(false);

    fireEvent.click(within(timeline).getByText("Diagnostics"));
    expect(candidate.closest("details")?.hasAttribute("open")).toBe(true);
    expect(within(timeline).getByText("reviewing 2 candidate findings")).toBeTruthy();
  });

  it("collapses by default after the turn settles", () => {
    render(
      <TurnProgressTimeline
        live={false}
        events={[
          {
            category: "turn",
            stage: "turn",
            phase: "completed",
            label: "Saving session",
            elapsedMs: 20,
          },
        ]}
      />,
    );
    expect(screen.getByTestId("turn-progress-timeline").hasAttribute("open")).toBe(false);
  });
});
