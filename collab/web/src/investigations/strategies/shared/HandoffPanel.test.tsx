import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffPanel, type HandoffPanelProps } from "./HandoffPanel.js";
import {
  composeHandoffBody,
  type HandoffContributionRecord,
  type HandoffCreateInput,
} from "./handoff.js";

type ForbiddenHandoffProp =
  | "applyAction"
  | "applyLifecycle"
  | "updateSituation"
  | "onOpenCase"
  | "onNavigate"
  | "onOpenAdvancedTools";
type UnexpectedHandoffProp = Extract<keyof HandoffPanelProps, ForbiddenHandoffProp>;
const noForbiddenHandoffProps: [UnexpectedHandoffProp] extends [never] ? true : never = true;

function commandInput(
  command: { readonly mock: { readonly calls: readonly unknown[][] } },
  index: number,
): HandoffCreateInput {
  const call = command.mock.calls[index];
  const input = call?.[0];
  if (input === undefined) throw new Error(`missing createContribution call ${index}`);
  return input as HandoffCreateInput;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function record(
  overrides: Partial<HandoffContributionRecord> & Pick<HandoffContributionRecord, "id" | "kind">,
): HandoffContributionRecord {
  return {
    caseId: "case-1",
    revision: 1,
    body: `${overrides.kind} body`,
    tombstoned: false,
    authorUsername: "alice",
    createdAt: "2026-09-03T08:00:00.000Z",
    ...overrides,
  };
}

function mount(overrides: Partial<HandoffPanelProps> = {}) {
  const props: HandoffPanelProps = {
    investigationId: "case-1",
    investigation: { id: "case-1", status: "monitoring", legalHold: false },
    contributions: { status: "ready", value: [] },
    createContribution: vi.fn(async () => ({ status: "succeeded" as const })),
    refreshContributions: vi.fn(),
    ...overrides,
  };
  const view = render(<HandoffPanel {...props} />);
  return { ...view, props };
}

afterEach(() => cleanup());

describe("shared handoff panel", () => {
  it("exposes no lifecycle, situation, or navigation props", () => {
    expect(noForbiddenHandoffProps).toBe(true);
    const applyAction = vi.fn();
    const updateSituation = vi.fn();
    const smuggled = {
      investigationId: "case-1",
      investigation: { id: "case-1", status: "open", legalHold: true },
      contributions: { status: "ready" as const, value: [] },
      createContribution: vi.fn(async () => ({ status: "succeeded" as const })),
      refreshContributions: vi.fn(),
      applyAction,
      updateSituation,
    };
    render(<HandoffPanel {...(smuggled as HandoffPanelProps)} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /archive|restore|promote/i })).toBeNull();
    expect(applyAction).not.toHaveBeenCalled();
    expect(updateSituation).not.toHaveBeenCalled();
  });

  it("shows a busy status while loading and does not invent empty facts", () => {
    mount({
      investigation: null,
      contributions: { status: "loading" },
    });

    expect(screen.getByText("Loading recorded handoff facts…")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Handoff" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByText("Waiting for recorded facts.").length).toBeGreaterThan(0);
    expect(screen.queryByText("No handoff has been recorded yet.")).toBeNull();
    expect(screen.getByText("Current state").closest("section")?.textContent).toContain("Not recorded");
    expect(document.body.textContent).not.toMatch(/\b(priority|SLA|assignment|progress)\b/i);
  });

  it("renders empty recorded facts without treating them as a failed load", () => {
    const refreshContributions = vi.fn();
    mount({
      contributions: { status: "ready", value: [] },
      refreshContributions,
    });

    expect(screen.getByRole("heading", { name: "What happened" }).parentElement?.textContent)
      .toContain("Not recorded");
    expect(screen.getByRole("heading", { name: "Next action" }).parentElement?.textContent)
      .toContain("Not recorded");
    expect(screen.getByText("No handoff has been recorded yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(refreshContributions).not.toHaveBeenCalled();
  });

  it("distinguishes a failed load from empty and retries through the supplied callback", () => {
    const refreshContributions = vi.fn();
    mount({
      contributions: { status: "failed", error: "contributions unavailable" },
      refreshContributions,
    });

    expect(screen.getByRole("alert").textContent).toContain("contributions unavailable");
    expect(screen.getAllByText("Recorded facts are unavailable until this load succeeds.").length).toBe(2);
    expect(screen.queryByText("No handoff has been recorded yet.")).toBeNull();
    expect(screen.getByText("monitoring")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshContributions).toHaveBeenCalledTimes(1);
  });

  it("keeps previous facts visible when a refresh fails", () => {
    const refreshContributions = vi.fn();
    mount({
      contributions: {
        status: "failed",
        error: "refresh failed",
        previous: [
          record({
            id: "handoff-1",
            kind: "handoff",
            body: "Overnight stall remains.",
            createdAt: "2026-09-03T09:00:00.000Z",
          }),
          record({
            id: "action-1",
            kind: "action",
            body: "Recheck the pool at 07:00.",
          }),
        ],
      },
      refreshContributions,
    });

    expect(screen.getByRole("heading", { name: "What happened" }).parentElement?.textContent)
      .toContain("Overnight stall remains.");
    expect(screen.getByRole("heading", { name: "Next action" }).parentElement?.textContent)
      .toContain("Recheck the pool at 07:00.");
    expect(screen.getByRole("alert").textContent).toContain("Previously loaded facts remain visible");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refreshContributions).toHaveBeenCalledTimes(1);
  });

  it("hides the form when writing is unavailable", () => {
    mount({ createContribution: null });

    expect(screen.getByText("Handoff writing unavailable")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record handoff" })).toBeNull();
  });

  it("records one handoff, labels the body, and clears the draft after success", async () => {
    const createContribution = vi.fn(async () => ({ status: "succeeded" as const }));
    mount({ createContribution });

    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "  Queue time remains high.  " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Next action (optional)" }), {
      target: { value: "  Recheck the pool.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record handoff" }));

    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(1));
    const input = commandInput(createContribution, 0);
    expect(input).toEqual({
      kind: "handoff",
      body: composeHandoffBody("Queue time remains high.", "Recheck the pool."),
      privacyClass: "share_safe",
      idempotencyKey: expect.stringMatching(/^handoff-/),
    });
    expect(Object.keys(input).sort()).toEqual([
      "body",
      "idempotencyKey",
      "kind",
      "privacyClass",
    ]);
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: "Next action (optional)" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Handoff recorded")).toBeTruthy();
  });

  it("reuses one idempotency key while the draft is unchanged", async () => {
    const createContribution = vi.fn(async () => ({
      status: "failed" as const,
      error: { kind: "conflict" },
    }));
    mount({ createContribution });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Keep this key." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record handoff" }));
    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Record handoff" }));
    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(2));

    const first = commandInput(createContribution, 0).idempotencyKey;
    const second = commandInput(createContribution, 1).idempotencyKey;
    expect(first).toMatch(/^handoff-/);
    expect(second).toBe(first);
  });

  it("prevents duplicate in-flight submits", async () => {
    const deferred = createDeferred<{ status: "succeeded" }>();
    const createContribution = vi.fn(() => deferred.promise);
    mount({ createContribution });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Only once." },
    });
    const form = screen.getByRole("form", { name: "Record a handoff" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createContribution).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Recording handoff…" }).getAttribute("disabled")).not.toBeNull();

    await act(async () => {
      deferred.resolve({ status: "succeeded" });
      await deferred.promise;
    });
  });

  it.each([
    ["failed", { status: "failed" as const, error: { kind: "validation" } }, /could not be accepted/],
    ["conflict", { status: "failed" as const, error: { kind: "conflict" } }, /record changed/],
    ["ignored", { status: "ignored" as const, reason: "busy" }, /already in progress/],
  ] as const)("retains the draft after a %s result", async (_label, outcome, copy) => {
    const createContribution = vi.fn(async () => outcome);
    mount({ createContribution });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Keep this draft." },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Record a handoff" }));

    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("Keep this draft.");
    expect(screen.getByText(copy)).toBeTruthy();
  });

  it("asks the operator to review the record after an uncertain result", async () => {
    const createContribution = vi.fn(async () => ({
      status: "failed" as const,
      error: { kind: "unavailable" },
    }));
    mount({ createContribution });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "May already be recorded." },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Record a handoff" }));

    await waitFor(() => expect(screen.getByText("Handoff outcome unknown")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/review the current record before retrying/i);
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("May already be recorded.");
  });
});
