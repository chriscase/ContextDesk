import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogTimeReviewPanel } from "./LogTimeReviewPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const CASE_B = "99999999-9999-4999-8999-999999999999";
const FINGERPRINT = "a".repeat(64);

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

function sourceStatus(overrides: Record<string, unknown> = {}) {
  return {
    source: "worker/batch.log",
    unresolvedLocalRecords: 5,
    resolvedLocalRecords: 0,
    explicitWallClockRecords: 0,
    otherOrderOnlyRecords: 0,
    declaration: null,
    ...overrides,
  };
}

function stateBody(overrides: Record<string, unknown> = {}, dependents: unknown[] = []) {
  return {
    state: {
      caseId: CASE_ID,
      corpusId: "corpus-synthetic-0001",
      corpusRevision: 1,
      builtAt: "2024-03-11T12:00:00Z",
      privacyClass: "owner_only",
      sources: [sourceStatus()],
      reviewOutstanding: true,
      undoableRevision: null,
      ...overrides,
    },
    dependents,
  };
}

const PREVIEW = {
  schemaId: "cd-collab.log_time_preview.v1",
  caseId: CASE_ID,
  corpusId: "corpus-synthetic-0001",
  corpusRevision: 1,
  declarationFingerprint: FINGERPRINT,
  source: "worker/batch.log",
  ianaTimezone: "America/Chicago",
  affectedRecords: 4,
  existingWallClockRecords: 0,
  unchangedOrderOnlyRecords: 0,
  firstResolvedInstant: "2024-03-10T07:30:00Z",
  lastResolvedInstant: "2024-03-10T08:20:00Z",
  dstGapCount: 1,
  dstFoldCount: 0,
  unsupportedTimestampCount: 0,
  zoneAbbreviationMismatchCount: 0,
  outOfRangeCount: 0,
  samples: [
    {
      ordinal: 3,
      outcome: "resolved",
      rawTimestamp: "2024-03-10 01:30:00",
      normalizedInstant: "2024-03-10T07:30:00Z",
      utcOffsetSeconds: -21600,
      unresolvedReason: null,
      excerpt: "batch worker starting scheduled sweep",
    },
    {
      ordinal: 5,
      outcome: "unresolved",
      rawTimestamp: "2024-03-10 02:30:00",
      normalizedInstant: null,
      utcOffsetSeconds: null,
      unresolvedReason: "nonexistent_dst_gap",
      excerpt: "batch worker heartbeat late",
    },
  ],
};

const ALL_FOLD_PREVIEW = {
  ...PREVIEW,
  affectedRecords: 0,
  firstResolvedInstant: null,
  lastResolvedInstant: null,
  dstGapCount: 0,
  dstFoldCount: 2,
  samples: PREVIEW.samples.map((sample) => ({
    ...sample,
    outcome: "unresolved" as const,
    normalizedInstant: null,
    utcOffsetSeconds: null,
    unresolvedReason: "ambiguous_dst_fold",
  })),
};

/** Route fetches by URL suffix; records every request for assertions. */
function stubFetch(
  handlers: Record<string, (body: Record<string, unknown>) => unknown>,
  calls: { url: string; body: Record<string, unknown> }[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      for (const [suffix, handler] of Object.entries(handlers)) {
        if (url.endsWith(suffix)) {
          const result = handler(body);
          if (result instanceof Error) {
            return { ok: false, status: 409, json: async () => ({ error: result.message }) };
          }
          return { ok: true, status: 200, json: async () => result };
        }
      }
      return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
    }),
  );
  return calls;
}

function panel(props: Partial<{ canWrite: boolean; readOnly: boolean }> = {}) {
  return (
    <LogTimeReviewPanel
      caseId={CASE_ID}
      canWrite={props.canWrite ?? true}
      readOnly={props.readOnly ?? false}
    />
  );
}

describe("LogTimeReviewPanel", () => {
  it("explains when the trusted timestamp host is not configured", async () => {
    stubFetch({});
    render(panel());

    expect(
      await screen.findByText(/timezone review needs the trusted ContextDesk timestamp host/i),
    ).toBeTruthy();
    expect(screen.getByText(/stay in file order and keep their time unresolved/i)).toBeTruthy();
    expect(screen.getByText(/ContextDesk will not guess/i)).toBeTruthy();
  });

  it("says plainly that a timezone is missing and that nothing will be guessed", async () => {
    stubFetch({ "/log-time": () => stateBody() });
    render(panel());

    expect(
      await screen.findByText(/records a clock time but not which timezone/i),
    ).toBeTruthy();
    expect(screen.getByText(/ContextDesk will not guess/i)).toBeTruthy();
    expect(screen.getByText(/5 lines still in file order only/i)).toBeTruthy();
  });

  it("keeps a large timezone review searchable without rendering every file at once", async () => {
    const sources = Array.from({ length: 30 }, (_, index) =>
      sourceStatus({ source: `worker/source-${String(index).padStart(2, "0")}.log` }),
    );
    stubFetch({ "/log-time": () => stateBody({ sources }) });
    render(panel());

    expect(await screen.findByText("worker/source-11.log")).toBeTruthy();
    expect(screen.queryByText("worker/source-12.log")).toBeNull();
    expect(screen.getByText("30 of 30 files match")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show 12 more" }));
    expect(screen.getByText("worker/source-23.log")).toBeTruthy();
    expect(screen.queryByText("worker/source-24.log")).toBeNull();

    fireEvent.change(screen.getByLabelText("Find a log file"), {
      target: { value: "source-29" },
    });
    expect(screen.getByText("worker/source-29.log")).toBeTruthy();
    expect(screen.getByText("1 of 30 files match")).toBeTruthy();
  });

  it("keeps a 300-file timezone review bounded until the operator filters", async () => {
    const sources = Array.from({ length: 300 }, (_, index) =>
      sourceStatus({ source: `worker/source-${String(index).padStart(3, "0")}.log` }),
    );
    stubFetch({ "/log-time": () => stateBody({ sources }) });
    render(panel());

    expect(await screen.findByText("worker/source-011.log")).toBeTruthy();
    expect(screen.queryByText("worker/source-012.log")).toBeNull();
    expect(screen.getByText("300 of 300 files match")).toBeTruthy();
    expect(screen.getByText(/Showing 12 of 300 matching files/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Find a log file"), {
      target: { value: "source-299" },
    });
    expect(screen.getByText("worker/source-299.log")).toBeTruthy();
    expect(screen.getByText("1 of 300 files match")).toBeTruthy();
    expect(screen.queryByText("worker/source-000.log")).toBeNull();
  });

  it("offers no timezone until a person types one", async () => {
    stubFetch({ "/log-time": () => stateBody() });
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    const input = screen.getByLabelText(/which timezone was this file written in/i);
    expect((input as HTMLInputElement).value).toBe("");
    expect(
      screen.getByRole("button", { name: /show me what this would do/i }),
    ).toHaveProperty("disabled", true);
  });

  it("shows raw and normalized timestamps side by side, including the DST gap", async () => {
    stubFetch({
      "/log-time/preview": () => PREVIEW,
      "/log-time": () => stateBody(),
    });
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));

    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // Header plus the two sampled lines.
    expect(rows).toHaveLength(3);
    const [, resolvedRow, unresolvedRow] = rows as [HTMLElement, HTMLElement, HTMLElement];

    expect(within(resolvedRow).getByText("2024-03-10 01:30:00")).toBeTruthy();
    expect(within(resolvedRow).getByText("2024-03-10T07:30:00Z")).toBeTruthy();
    expect(within(resolvedRow).getByText(/UTC−06:00/)).toBeTruthy();
    expect(
      within(resolvedRow).getByText(/batch worker starting scheduled sweep/),
    ).toBeTruthy();

    expect(within(unresolvedRow).getByText("2024-03-10 02:30:00")).toBeTruthy();
    expect(
      within(unresolvedRow).getByText(/clocks jumped forward past it/i),
    ).toBeTruthy();
  });

  it("explains the DST gap in plain language before anything is applied", async () => {
    stubFetch({ "/log-time/preview": () => PREVIEW, "/log-time": () => stateBody() });
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));

    expect(
      await screen.findByText(/fall in the hour this zone skips when clocks go forward/i),
    ).toBeTruthy();
    expect(screen.getByText(/those lines keep file order instead/i)).toBeTruthy();
  });

  it("does not offer an empty revision when every timestamp remains ambiguous", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubFetch(
      {
        "/log-time/preview": () => ALL_FOLD_PREVIEW,
        "/log-time/apply": () => ({ schemaId: "cd-collab.log_time_outcome.v1" }),
        "/log-time": () => stateBody(),
      },
      calls,
    );
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));

    expect(
      await screen.findByText(/nothing can be given an exact time with this choice/i),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "What America/Chicago would do" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /apply America\/Chicago to this file/i }),
    ).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/log-time/apply"))).toBe(false);
  });

  it("turns the server's internal sentinel into an actionable operator message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/log-time")) {
          return { ok: true, status: 200, json: async () => stateBody() };
        }
        return { ok: false, status: 400, json: async () => ({ error: "invalid" }) };
      }),
    );
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));

    expect(
      await screen.findByText("That timezone could not be previewed."),
    ).toBeTruthy();
    expect(screen.queryByText(/^invalid$/i)).toBeNull();
  });

  it("sends the exact previewed fingerprint and revision when applying", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const onTimeChanged = vi.fn();
    window.addEventListener("contextdesk:log-time-changed", onTimeChanged);
    stubFetch(
      {
        "/log-time/preview": () => PREVIEW,
        "/log-time/apply": () => ({ schemaId: "cd-collab.log_time_outcome.v1" }),
        "/log-time": () => stateBody(),
      },
      calls,
    );
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /apply America\/Chicago to this file/i }),
    );

    await waitFor(() => {
      expect(calls.some((call) => call.url.endsWith("/log-time/apply"))).toBe(true);
    });
    const apply = calls.find((call) => call.url.endsWith("/log-time/apply"));
    expect(apply?.body.declarationFingerprint).toBe(FINGERPRINT);
    expect(apply?.body.expectedRevision).toBe(1);
    expect(apply?.body.ianaTimezone).toBe("America/Chicago");
    expect(onTimeChanged).toHaveBeenCalledTimes(1);
    expect((onTimeChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      caseId: CASE_ID,
      notice: "America/Chicago applied to worker/batch.log. 4 lines now have an exact time.",
    });
    window.removeEventListener("contextdesk:log-time-changed", onTimeChanged);
  });

  it("synchronizes both mounted timezone panels after one panel changes the case", async () => {
    let stateReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/log-time/preview")) return jsonResponse(PREVIEW);
        if (url.endsWith("/log-time/apply")) {
          return jsonResponse({ schemaId: "cd-collab.log_time_outcome.v1" });
        }
        if (url.endsWith("/log-time")) {
          stateReads += 1;
          return jsonResponse(
            stateReads <= 2
              ? stateBody()
              : stateBody({
                  corpusRevision: 2,
                  reviewOutstanding: false,
                  sources: [
                    sourceStatus({
                      unresolvedLocalRecords: 0,
                      resolvedLocalRecords: 4,
                      declaration: {
                        source: "worker/batch.log",
                        ianaTimezone: "America/Chicago",
                        basis: "user_declared",
                        declaredAt: 1710093600,
                        appliedRevision: 2,
                        declarationFingerprint: FINGERPRINT,
                        declaredBy: "analyst-synthetic-01",
                      },
                    }),
                  ],
                }),
          );
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(
      <>
        <div data-testid="capture-time-review">{panel()}</div>
        <div data-testid="analyze-time-review">{panel()}</div>
      </>,
    );
    const capture = within(screen.getByTestId("capture-time-review"));
    fireEvent.click(await capture.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(capture.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(capture.getByRole("button", { name: /show me what this would do/i }));
    fireEvent.click(
      await capture.findByRole("button", { name: /apply America\/Chicago to this file/i }),
    );

    await waitFor(() => {
      expect(screen.getAllByText(/revision 2/)).toHaveLength(2);
      expect(screen.getAllByText(/4 lines placed at an exact time/)).toHaveLength(2);
    });
    expect(stateReads).toBe(4);
  });

  it("does not let a delayed write update or reload a later investigation", async () => {
    const applyGate = deferred<Response>();
    const caseBLoad = deferred<Response>();
    const onTimeChanged = vi.fn();
    window.addEventListener("contextdesk:log-time-changed", onTimeChanged);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/api/cases/${CASE_ID}/log-time/preview`)) {
          return jsonResponse(PREVIEW);
        }
        if (url.includes(`/api/cases/${CASE_ID}/log-time/apply`)) {
          return applyGate.promise;
        }
        if (url.endsWith(`/api/cases/${CASE_ID}/log-time`)) {
          return jsonResponse(stateBody());
        }
        if (url.endsWith(`/api/cases/${CASE_B}/log-time`)) {
          return caseBLoad.promise;
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    const view = render(panel());
    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: /apply America\/Chicago to this file/i }),
    );

    view.rerender(
      <LogTimeReviewPanel caseId={CASE_B} canWrite readOnly={false} />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/5 lines still in file order only/i)).toBeNull();
      expect(screen.getByText(/Loading time review/i)).toBeTruthy();
    });

    await act(async () => {
      applyGate.resolve(jsonResponse({ schemaId: "cd-collab.log_time_outcome.v1" }));
      await applyGate.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    const oldCaseLoads = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([input]) => String(input).endsWith(`/api/cases/${CASE_ID}/log-time`),
    );
    expect(oldCaseLoads).toHaveLength(1);
    expect(onTimeChanged).not.toHaveBeenCalled();
    expect(screen.queryByText(/America\/Chicago applied/i)).toBeNull();

    await act(async () => {
      caseBLoad.resolve(
        jsonResponse(
          stateBody({
            caseId: CASE_B,
            sources: [sourceStatus({ source: "case-b/current.log" })],
          }),
        ),
      );
      await caseBLoad.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText("case-b/current.log")).toBeTruthy();
    window.removeEventListener("contextdesk:log-time-changed", onTimeChanged);
  });

  it("shows how a declared timezone was decided, including its fingerprint", async () => {
    stubFetch({
      "/log-time": () =>
        stateBody({
          corpusRevision: 2,
          reviewOutstanding: false,
          sources: [
            sourceStatus({
              unresolvedLocalRecords: 0,
              resolvedLocalRecords: 4,
              declaration: {
                source: "worker/batch.log",
                ianaTimezone: "America/Chicago",
                basis: "user_declared",
                declaredAt: 1710093600,
                appliedRevision: 2,
                declarationFingerprint: FINGERPRINT,
                declaredBy: "analyst-synthetic-01",
              },
            }),
          ],
        }),
    });
    render(panel());

    fireEvent.click(await screen.findByText(/how this timezone was decided/i));
    expect(screen.getByText("analyst-synthetic-01")).toBeTruthy();
    expect(screen.getByText(/A person chose this zone here/i)).toBeTruthy();
    expect(screen.getByText(`${FINGERPRINT.slice(0, 16)}…`)).toBeTruthy();
  });

  it("distinguishes a saved default from an in-the-moment choice", async () => {
    stubFetch({
      "/log-time": () =>
        stateBody({
          corpusRevision: 2,
          reviewOutstanding: false,
          sources: [
            sourceStatus({
              unresolvedLocalRecords: 0,
              resolvedLocalRecords: 4,
              declaration: {
                source: "worker/batch.log",
                ianaTimezone: "America/Chicago",
                basis: "configured_default",
                declaredAt: 1710093600,
                appliedRevision: 2,
                declarationFingerprint: FINGERPRINT,
                declaredBy: "analyst-synthetic-01",
              },
            }),
          ],
        }),
    });
    render(panel());

    fireEvent.click(await screen.findByText(/how this timezone was decided/i));
    expect(screen.getByText(/not chosen in the moment/i)).toBeTruthy();
  });

  it("discloses that a snapshot reads differently and a run is no longer current", async () => {
    stubFetch({
      "/log-time": () =>
        stateBody({ corpusRevision: 2, undoableRevision: 1 }, [
          {
            kind: "snapshot",
            id: "snapshot-synthetic-0001",
            disposition: "revised",
            reason: "The files themselves have not changed; any timing needs a fresh look.",
            observedRevision: 1,
          },
          {
            kind: "triage_run",
            id: "run-synthetic-0001",
            disposition: "invalidated",
            reason: "Its conclusions are no longer current.",
            observedRevision: 1,
          },
        ]),
    });
    render(panel());

    expect(await screen.findByText(/reads differently now/i)).toBeTruthy();
    // The chip and the explanation both say it, which is the point: the label
    // is scannable and the sentence below it is the reason.
    expect(screen.getAllByText(/no longer current/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Evidence set snapshot-synthetic-0001/)).toBeTruthy();
    expect(screen.getByText(/Run run-synthetic-0001/)).toBeTruthy();
  });

  it("offers undo only once there is a revision to step back from", async () => {
    stubFetch({ "/log-time": () => stateBody() });
    render(panel());
    await screen.findByText(/records a clock time/i);
    expect(screen.queryByRole("button", { name: /undo the last time change/i })).toBeNull();

    cleanup();
    stubFetch({ "/log-time": () => stateBody({ corpusRevision: 2, undoableRevision: 1 }) });
    render(panel());
    expect(
      await screen.findByRole("button", { name: /undo the last time change/i }),
    ).toBeTruthy();
  });

  it("surfaces a conflict and re-reads instead of retrying blind", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    stubFetch(
      {
        "/log-time/preview": () =>
          new Error("stale timezone preview: expected revision 1, current 3"),
        "/log-time": () => stateBody(),
      },
      calls,
    );
    render(panel());

    fireEvent.click(await screen.findByRole("button", { name: /declare a timezone/i }));
    fireEvent.change(screen.getByLabelText(/which timezone was this file written in/i), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(screen.getByRole("button", { name: /show me what this would do/i }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "stale timezone preview: expected revision 1, current 3",
    );
    await waitFor(() => {
      expect(calls.filter((call) => call.url.endsWith("/log-time")).length).toBeGreaterThan(1);
    });
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers a reviewer with read-only access no way to change the reading", async () => {
    stubFetch({ "/log-time": () => stateBody() });
    render(panel({ canWrite: false }));

    await screen.findByText(/records a clock time/i);
    expect(screen.queryByRole("button", { name: /declare a timezone/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove this timezone/i })).toBeNull();
  });

  it("explains when this deployment has no log-time pipeline", async () => {
    // The routes are unregistered without a configured host binary. Keep that
    // absence quiet, but leave a useful explanation at the destination of the
    // Workbench's timestamp-review handoff.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "not_found" }),
      })),
    );
    render(panel());

    expect(
      await screen.findByText(/timezone review needs the trusted ContextDesk timestamp host/i),
    ).toBeTruthy();
    expect(screen.queryByText(/not_found/i)).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("invites building the corpus when the case has none yet", async () => {
    stubFetch({
      "/log-time": () =>
        stateBody({
          corpusId: null,
          corpusRevision: 0,
          builtAt: null,
          sources: [],
          reviewOutstanding: false,
        }),
    });
    render(panel());

    expect(
      await screen.findByRole("button", { name: /build the log corpus/i }),
    ).toBeTruthy();
  });
});
