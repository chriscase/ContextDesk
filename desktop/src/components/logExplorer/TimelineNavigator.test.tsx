import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../../lib/host";
import { TimelineNavigator } from "./TimelineNavigator";

vi.mock("../../lib/host", () => ({
  hostLogSharedTimelineSummary: vi.fn(),
  hostLogQueryEvents: vi.fn(),
}));

const summary: host.SharedTimelineSummaryDto = {
  timeQuality: "wall",
  spanFrom: 1_700_000_000,
  spanTo: 1_700_000_040,
  bucketWidth: 10,
  bucketCount: 4,
  totalMatched: 42,
  buckets: [
    { index: 0, start: 1_700_000_000, end: 1_700_000_010 },
    { index: 1, start: 1_700_000_010, end: 1_700_000_020 },
    { index: 2, start: 1_700_000_020, end: 1_700_000_030 },
    { index: 3, start: 1_700_000_030, end: 1_700_000_040 },
  ],
  counts: [30, 0, 0, 12],
  severitySeries: [
    { severity: "error", counts: [0, 0, 0, 12] },
    { severity: "warn", counts: [0, 0, 0, 0] },
    { severity: "info", counts: [30, 0, 0, 0] },
    { severity: "debug", counts: [0, 0, 0, 0] },
    { severity: "other", counts: [0, 0, 0, 0] },
  ],
  lanes: [],
};

const target: host.ExplorerEventDto = {
  seq: 77,
  ts: 1_700_000_031,
  timeQuality: "wall",
  level: "error",
  service: null,
  host: null,
  templateId: 1,
  traceId: null,
  message: "target event",
  source: "api.log",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("TimelineNavigator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue(summary);
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue({
      events: [target],
      nextCursor: null,
      totalMatched: 1,
      timeQuality: "wall",
    });
  });

  it("is visible by default, collapses accessibly, and does no work while closed", async () => {
    const { rerender } = render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
        "c1",
        { levels: ["error"] },
        [],
        96,
      ),
    );
    expect(screen.getAllByTestId(/^timeline-bucket-/)).toHaveLength(4);
    expect(screen.getByText(/42 matching events summarized/)).toBeTruthy();
    const toggle = screen.getByTestId("timeline-navigator-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse timeline");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand timeline");
    expect(screen.getByText("Collapsed · no timeline work")).toBeTruthy();
    const callsWhileOpen = vi.mocked(host.hostLogSharedTimelineSummary).mock
      .calls.length;
    rerender(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["warning"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(
      callsWhileOpen,
    );

    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(
        callsWhileOpen + 1,
      ),
    );
  });

  it("closes on Escape and restores focus to the disclosure", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    scrubber.focus();
    fireEvent.keyDown(scrubber, { key: "Escape" });
    expect(
      screen
        .getByTestId("timeline-navigator-toggle")
        .getAttribute("aria-expanded"),
    ).toBe("false");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("timeline-navigator-toggle"),
      ),
    );
  });

  it("does not duplicate the global summary query for one visible lane", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ sources: ["api.log"] }}
        residentEvents={[]}
        lanes={[{ id: "lane-1", label: "API", sources: ["api.log"] }]}
        onSeekSeq={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(1),
    );
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
      "c1",
      { sources: ["api.log"] },
      [],
      96,
    );
    expect(screen.queryByTestId("timeline-lane-coverage")).toBeNull();
  });

  it("does not broaden an empty visible-lane source intersection", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ sources: [] }}
        emptySourceScope
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    expect(
      screen.getByText("No events match the visible lane sources"),
    ).toBeTruthy();
    expect(host.hostLogSharedTimelineSummary).not.toHaveBeenCalled();
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
  });

  it("seeks one bounded bucket page then delegates stable neighborhood loading", async () => {
    const onSeekSeq = vi.fn(async () => {});
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ sources: ["api.log"] }}
        residentEvents={[target]}
        onSeekSeq={onSeekSeq}
      />,
    );
    await screen.findByTestId("timeline-bucket-3");
    fireEvent.click(screen.getByTestId("timeline-bucket-3"));

    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          sources: ["api.log"],
          timeFrom: 1_700_000_030,
          timeTo: 1_700_000_040,
          limit: 1,
        }),
      ),
    );
    expect(onSeekSeq).toHaveBeenCalledWith(77, target);
    expect(screen.getByText(/Moved to seq 77/)).toBeTruthy();
    expect(screen.getByTestId("timeline-bucket-3").className).toContain(
      "resident",
    );
  });

  it("previews range dragging without querying until the position is committed", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const range = await screen.findByLabelText("Timeline position");
    fireEvent.change(range, { target: { value: "3" } });
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    fireEvent.pointerUp(range, { target: { value: "3" } });
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1),
    );
  });

  it("materializes zero buckets and exposes stacked canonical levels", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      ...summary,
      counts: [30, 0, 0, 0],
      severitySeries: [
        { severity: "error", counts: [4, 0, 0, 0] },
        { severity: "warn", counts: [3, 0, 0, 0] },
        { severity: "info", counts: [12, 0, 0, 0] },
        { severity: "debug", counts: [6, 0, 0, 0] },
        { severity: "other", counts: [5, 0, 0, 0] },
      ],
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[target]}
        onSeekSeq={vi.fn()}
      />,
    );
    const first = await screen.findByTestId("timeline-bucket-0");
    expect(first.querySelectorAll(".timeline-navigator__stack i")).toHaveLength(
      5,
    );
    expect(first.getAttribute("aria-label")).toContain("Other 5");
    expect(screen.getByTestId("timeline-bucket-1").className).toContain(
      "timeline-navigator__bucket--empty",
    );
    expect(screen.getAllByTestId(/^timeline-bucket-/)).toHaveLength(4);
    expect(screen.getByTestId("timeline-resident-range")).toBeTruthy();
  });

  it("commits keyboard seeks only after a navigation key is released", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    fireEvent.change(scrubber, { target: { value: "3" } });
    fireEvent.keyDown(scrubber, { key: "End" });
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    fireEvent.keyUp(scrubber, { key: "End" });
    await waitFor(() =>
      expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1),
    );
    expect(
      await screen.findByTestId("timeline-committed-position"),
    ).toBeTruthy();
  });

  it("uses concise UTC labels while retaining exact bucket details", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    expect(scrubber.getAttribute("aria-valuetext")).toMatch(
      /^\d{2}:\d{2}:\d{2}Z · 30 events · wall clock$/,
    );
    expect(scrubber.getAttribute("title")).toContain("2023-");
  });

  it("labels order-only summaries as order rather than calendar time", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      ...summary,
      timeQuality: "order_only",
      spanFrom: 1,
      spanTo: 41,
      buckets: [
        { index: 0, start: 1, end: 11 },
        { index: 1, start: 11, end: 21 },
        { index: 2, start: 21, end: 31 },
        { index: 3, start: 31, end: 41 },
      ],
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    const scrubber = await screen.findByLabelText("Timeline position");
    expect(scrubber.getAttribute("title")).toBe("order 1–10");
    expect(scrubber.getAttribute("aria-valuetext")).toContain(
      "order only (not calendar time)",
    );
  });

  it("shows bounded per-lane coverage without upgrading an order-only lane", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue({
      ...summary,
      lanes: [
        {
          laneIndex: 0,
          sourceCount: 1,
          timeQuality: "wall",
          totalMatched: 30,
          counts: [30, 0, 0, 0],
        },
        {
          laneIndex: 1,
          sourceCount: 1,
          timeQuality: "order_only",
          totalMatched: 12,
          counts: [0, 0, 0, 12],
        },
      ],
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        lanes={[
          { id: "lane-0", label: "API", sources: ["api.log"] },
          { id: "lane-1", label: "Worker", sources: ["worker.log"] },
        ]}
        onSeekSeq={vi.fn()}
      />,
    );
    const coverage = await screen.findByTestId("timeline-lane-coverage");
    expect(within(coverage).getByText("API")).toBeTruthy();
    expect(within(coverage).getByText("Worker")).toBeTruthy();
    expect(within(coverage).getByText("wall clock")).toBeTruthy();
    expect(
      within(coverage).getByText("order only (not calendar time)"),
    ).toBeTruthy();
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledTimes(1);
    expect(host.hostLogSharedTimelineSummary).toHaveBeenCalledWith(
      "c1",
      { levels: ["error"] },
      [{ sources: ["api.log"] }, { sources: ["worker.log"] }],
      96,
    );
    expect(coverage.querySelectorAll("i")).toHaveLength(8);
  });

  it("ignores a stale summary after filters change", async () => {
    const old = deferred<host.SharedTimelineSummaryDto>();
    vi.mocked(host.hostLogSharedTimelineSummary)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({ ...summary, totalMatched: 7 });
    const { rerender } = render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["info"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    rerender(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/7 matching events summarized/),
    ).toBeTruthy();
    old.resolve({ ...summary, totalMatched: 999 });
    await Promise.resolve();
    expect(screen.queryByText(/999 matching events/)).toBeNull();
  });

  it("ignores a stale seek and reports an empty sparse bucket honestly", async () => {
    const old = deferred<host.EventPageDto>();
    const newerTarget = { ...target, seq: 88, ts: 1_700_000_031 };
    vi.mocked(host.hostLogQueryEvents)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce({
        events: [newerTarget],
        nextCursor: null,
        totalMatched: 1,
        timeQuality: "wall",
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: null,
        totalMatched: 0,
        timeQuality: "wall",
      });
    const onSeekSeq = vi.fn(async () => {});
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={onSeekSeq}
      />,
    );
    await screen.findByTestId("timeline-bucket-0");
    fireEvent.click(screen.getByTestId("timeline-bucket-0"));
    fireEvent.click(screen.getByTestId("timeline-bucket-3"));
    await waitFor(() =>
      expect(onSeekSeq).toHaveBeenCalledWith(88, newerTarget),
    );
    old.resolve({
      events: [target],
      nextCursor: null,
      totalMatched: 1,
      timeQuality: "wall",
    });
    await Promise.resolve();
    expect(onSeekSeq).not.toHaveBeenCalledWith(77, target);

    fireEvent.click(screen.getByTestId("timeline-bucket-2"));
    expect(await screen.findByText(/No event in/)).toBeTruthy();
  });

  it("shows summary and seek failures as visible errors", async () => {
    vi.mocked(host.hostLogSharedTimelineSummary).mockRejectedValueOnce(
      new Error("summary unavailable"),
    );
    const { unmount } = render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "summary unavailable",
    );
    unmount();

    vi.mocked(host.hostLogSharedTimelineSummary).mockResolvedValue(summary);
    vi.mocked(host.hostLogQueryEvents).mockRejectedValueOnce(
      new Error("seek unavailable"),
    );
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByTestId("timeline-bucket-0"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "seek unavailable",
    );
  });
});
