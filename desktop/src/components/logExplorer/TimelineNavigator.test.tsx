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
  hostLogTimelineSummary: vi.fn(),
  hostLogQueryEvents: vi.fn(),
}));

const summary: host.TimelineSummaryDto = {
  timeQuality: "wall",
  spanFrom: 1_700_000_000,
  spanTo: 1_700_000_040,
  bucketWidth: 10,
  bucketCount: 4,
  totalMatched: 42,
  buckets: [
    {
      index: 0,
      start: 1_700_000_000,
      end: 1_700_000_010,
      count: 30,
      byLevel: { info: 30 },
    },
    {
      index: 3,
      start: 1_700_000_030,
      end: 1_700_000_040,
      count: 12,
      byLevel: { error: 12 },
    },
  ],
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
    vi.mocked(host.hostLogTimelineSummary).mockResolvedValue(summary);
    vi.mocked(host.hostLogQueryEvents).mockResolvedValue({
      events: [target],
      nextCursor: null,
      totalMatched: 1,
      timeQuality: "wall",
    });
  });

  it("does no timeline work until opened and renders only fixed summary slots", async () => {
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{ levels: ["error"] }}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );

    expect(host.hostLogTimelineSummary).not.toHaveBeenCalled();
    expect(screen.getByText("closed · no timeline work")).toBeTruthy();

    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
    await waitFor(() =>
      expect(host.hostLogTimelineSummary).toHaveBeenCalledWith(
        "c1",
        { levels: ["error"] },
        96,
      ),
    );
    expect(screen.getAllByTestId(/^timeline-bucket-/)).toHaveLength(4);
    expect(screen.getByText(/42 matching events summarized/)).toBeTruthy();
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
    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
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
    expect(onSeekSeq).toHaveBeenCalledWith(77);
    expect(screen.getByText(/Moved to seq 77/)).toBeTruthy();
    expect(
      screen.getByTestId("timeline-bucket-3").className,
    ).toContain("resident");
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
    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
    const range = await screen.findByLabelText("Timeline position");
    fireEvent.change(range, { target: { value: "3" } });
    expect(host.hostLogQueryEvents).not.toHaveBeenCalled();
    fireEvent.pointerUp(range, { target: { value: "3" } });
    await waitFor(() => expect(host.hostLogQueryEvents).toHaveBeenCalledTimes(1));
  });

  it("labels order-only summaries as order rather than calendar time", async () => {
    vi.mocked(host.hostLogTimelineSummary).mockResolvedValue({
      ...summary,
      timeQuality: "order_only",
      spanFrom: 1,
      spanTo: 41,
    });
    render(
      <TimelineNavigator
        corpusId="c1"
        filter={{}}
        residentEvents={[]}
        onSeekSeq={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
    expect(await screen.findByText(/order 1–10/)).toBeTruthy();
    expect(screen.getByText(/order only \(not calendar time\)/)).toBeTruthy();
  });

  it("shows bounded per-lane coverage without upgrading an order-only lane", async () => {
    vi.mocked(host.hostLogTimelineSummary).mockImplementation(
      async (_corpusId, filter) => ({
        ...summary,
        timeQuality:
          filter?.sources?.[0] === "worker.log" ? "order_only" : "wall",
      }),
    );
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
    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
    const coverage = await screen.findByTestId("timeline-lane-coverage");
    expect(within(coverage).getByText("API")).toBeTruthy();
    expect(within(coverage).getByText("Worker")).toBeTruthy();
    expect(within(coverage).getByText("wall clock")).toBeTruthy();
    expect(
      within(coverage).getByText("order only (not calendar time)"),
    ).toBeTruthy();
    expect(host.hostLogTimelineSummary).toHaveBeenCalledTimes(3);
    expect(coverage.querySelectorAll("i")).toHaveLength(8);
  });

  it("ignores a stale summary after filters change", async () => {
    const old = deferred<host.TimelineSummaryDto>();
    vi.mocked(host.hostLogTimelineSummary)
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
    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
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
    fireEvent.click(screen.getByTestId("timeline-navigator-toggle"));
    await screen.findByTestId("timeline-bucket-0");
    fireEvent.click(screen.getByTestId("timeline-bucket-0"));
    fireEvent.click(screen.getByTestId("timeline-bucket-3"));
    await waitFor(() => expect(onSeekSeq).toHaveBeenCalledWith(88));
    old.resolve({
      events: [target],
      nextCursor: null,
      totalMatched: 1,
      timeQuality: "wall",
    });
    await Promise.resolve();
    expect(onSeekSeq).not.toHaveBeenCalledWith(77);

    fireEvent.click(screen.getByTestId("timeline-bucket-2"));
    expect(await screen.findByText(/No event in/)).toBeTruthy();
  });
});
