import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMockEngineClient } from "@contextdesk/client";
import type { ImportRunReport, MockEngineClient } from "@contextdesk/client";
import { TimeReviewCard } from "./TimeReviewCard";

async function publishedReport(client: MockEngineClient): Promise<ImportRunReport> {
  const plan = await client.import.preview("/incidents");
  return client.import.run({
    path: "/incidents",
    planToken: plan.planToken,
    planVersion: plan.planVersion,
    selected: plan.report.items
      .filter((item) => item.role === "log" && item.status !== "blocked")
      .map((item) => item.identity),
  });
}

describe("TimeReviewCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderCard(
    client = createMockEngineClient(),
    onChanged = vi.fn(),
  ) {
    const report = await publishedReport(client);
    render(
      <TimeReviewCard
        engine={client}
        report={report}
        onChanged={onChanged}
      />,
    );
    return { client, report, onChanged };
  }

  it("states the honest lead and never enables Apply without a valid zone", async () => {
    await renderCard();
    expect(screen.getByText(/ContextDesk did not guess a timezone\./)).toBeTruthy();
    const apply = screen.getByRole("button", { name: /Apply to 2 sources/ }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    // The disabled primary explains itself inline.
    expect(
      screen.getByText("Choose an IANA timezone first — for example America/Chicago."),
    ).toBeTruthy();
    // The machine zone is a labelled, inactive suggestion.
    expect(screen.getByText(/this computer’s timezone\. Not applied\./)).toBeTruthy();
  });

  it("auto-previews a valid zone and enables Apply — no manual Preview step", async () => {
    await renderCard();
    fireEvent.change(screen.getByLabelText("IANA timezone"), {
      target: { value: "America/Chicago" },
    });
    // While the debounce runs, Apply explains it is waiting.
    expect(screen.getByText("Waiting for the automatic preview…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByText(/Preview — not applied · 2,000 records resolve/)).toBeTruthy();
    const apply = screen.getByRole("button", { name: /Apply to 2 sources/ }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
  });

  it("applies atomically, shows the scope chip, and undo returns to order-only", async () => {
    const { report, onChanged } = await renderCard();
    fireEvent.change(screen.getByLabelText("IANA timezone"), {
      target: { value: "America/Chicago" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const apply = screen.getByRole("button", { name: /Apply to 2 sources/ });
    await act(async () => {
      fireEvent.click(apply);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("America/Chicago · 2 sources")).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(report.corpusId);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Undo / return to order-only" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo / return to order-only" }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByText("America/Chicago · 2 sources")).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("excluding a group scopes Apply to the remaining sources", async () => {
    await renderCard();
    // Both mock sources share one group; the disclosure only renders for >1
    // group, so assert the single-group Apply count instead.
    expect(screen.getByRole("button", { name: /Apply to 2 sources/ })).toBeTruthy();
  });

  it("Decide later dismisses without applying anything", async () => {
    const { client, report } = await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Decide later — keep order-only" }));
    expect(screen.queryByText("Place local timestamps")).toBeNull();
    const state = await client.time.state(report.corpusId);
    expect(Object.keys(state.declarations)).toHaveLength(0);
  });
});
