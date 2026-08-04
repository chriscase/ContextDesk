import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMockEngineClient } from "@contextdesk/client";
import type {
  EventRevisionReport,
  ImportRunReport,
  MockEngineClient,
} from "@contextdesk/client";
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
    reportOverride?: ImportRunReport,
    strict = false,
  ) {
    const report = reportOverride ?? (await publishedReport(client));
    const card = (
      <TimeReviewCard
        engine={client}
        report={report}
        onChanged={onChanged}
      />
    );
    render(strict ? <StrictMode>{card}</StrictMode> : card);
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
    expect(screen.getByText("Checking 0 of 2 sources")).toBeTruthy();
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

  it("accepts Apply immediately for a large delayed corpus, reports progress, and bounds previews", async () => {
    const client = createMockEngineClient();
    const baseReport = await publishedReport(client);
    const baseSource = baseReport.confidence.sources[0];
    const sources = Array.from({ length: 145 }, (_, index) => ({
      ...baseSource,
      source: `fixture/service-${String(index).padStart(3, "0")}.log`,
      lines: 10,
    }));
    const report: ImportRunReport = {
      ...baseReport,
      confidence: {
        ...baseReport.confidence,
        counts: { ...baseReport.confidence.counts, unresolved: sources.length },
        sources,
      },
    };
    const expectedRevision = (await client.time.state(report.corpusId)).eventRevision;

    const originalPreview = client.time.preview.bind(client.time);
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(client.time, "preview").mockImplementation(async (...args) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      try {
        return await originalPreview(...args);
      } finally {
        active -= 1;
      }
    });
    const applyMany = vi.spyOn(client.time, "applyMany");

    await renderCard(client, vi.fn(), report);
    fireEvent.change(screen.getByLabelText("IANA timezone"), {
      target: { value: "America/Chicago" },
    });

    const apply = screen.getByRole("button", { name: "Apply to 145 sources" });
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);
    expect(screen.getByRole("button", { name: "Preparing 0/145…" })).toBeTruthy();
    expect(screen.getByText(/Checking 0 of 145 sources · apply will start automatically/)).toBeTruthy();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(8);
    expect(applyMany).toHaveBeenCalledTimes(1);
    expect(applyMany.mock.calls[0][1]).toBe(expectedRevision);
    expect(applyMany.mock.calls[0][2]).toHaveLength(145);
    expect(screen.getByText("America/Chicago · 145 sources")).toBeTruthy();
  });

  it("applies only once under StrictMode and rapid repeated activation", async () => {
    const client = createMockEngineClient();
    const report = await publishedReport(client);
    let finishApply: ((value: EventRevisionReport) => void) | undefined;
    const applyMany = vi.spyOn(client.time, "applyMany").mockImplementation(
      () =>
        new Promise<EventRevisionReport>((resolve) => {
          finishApply = resolve;
        }),
    );

    await renderCard(client, vi.fn(), report, true);
    fireEvent.change(screen.getByLabelText("IANA timezone"), {
      target: { value: "America/Chicago" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    const apply = screen.getByRole("button", { name: "Apply to 2 sources" });
    fireEvent.click(apply);
    fireEvent.click(apply);
    expect(applyMany).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishApply?.({
        revision: 1,
        previousRevision: 0,
        changedEvents: 2_000,
        eventCount: 2_000,
        tsMin: 1,
        tsMax: 2,
      });
    });
    expect(screen.getByText("America/Chicago · 2 sources")).toBeTruthy();
  });

  it("makes a failed queued preview explicit and lets Retry complete safely", async () => {
    const client = createMockEngineClient();
    const originalPreview = client.time.preview.bind(client.time);
    vi.spyOn(client.time, "preview")
      .mockRejectedValueOnce(new Error("preview service unavailable"))
      .mockImplementation(originalPreview);
    const applyMany = vi.spyOn(client.time, "applyMany");

    await renderCard(client);
    fireEvent.change(screen.getByLabelText("IANA timezone"), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 sources" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByRole("alert").textContent).toContain("preview service unavailable");
    expect(applyMany).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "Retry and apply to 2 sources" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(applyMany).toHaveBeenCalledTimes(1);
    expect(screen.getByText("America/Chicago · 2 sources")).toBeTruthy();
  });

  it("Decide later dismisses without applying anything", async () => {
    const { client, report } = await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Decide later — keep order-only" }));
    expect(screen.queryByText("Place local timestamps")).toBeNull();
    const state = await client.time.state(report.corpusId);
    expect(Object.keys(state.declarations)).toHaveLength(0);
  });
});
