import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HumanAssessmentsPanel,
  type HumanAssessmentCitationChoice,
  type HumanAssessmentCreateInput,
  type HumanAssessmentRecord,
  type HumanAssessmentsPanelProps,
} from "./HumanAssessmentsPanel.js";

type ForbiddenPanelProp =
  | "applyAction"
  | "queryExternalRunJudgments"
  | "createExternalRunJudgment"
  | "onCorroborate"
  | "onNavigate";
type UnexpectedPanelProp = Extract<keyof HumanAssessmentsPanelProps, ForbiddenPanelProp>;
const noForbiddenProps: [UnexpectedPanelProp] extends [never] ? true : never = true;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function commandInput(
  command: { readonly mock: { readonly calls: readonly unknown[][] } },
  index: number,
): HumanAssessmentCreateInput {
  const call = command.mock.calls[index];
  const input = call?.[0];
  if (input === undefined) throw new Error(`missing createAssessment call ${index}`);
  return input as HumanAssessmentCreateInput;
}

function record(
  overrides: Partial<HumanAssessmentRecord> & Pick<HumanAssessmentRecord, "seq">,
): HumanAssessmentRecord {
  return {
    value: "insufficient_evidence",
    actorUsername: "alice",
    recordedAt: "2026-09-09T12:00:00.000Z",
    rationale: null,
    links: [],
    ...overrides,
  };
}

const artifactChoice: HumanAssessmentCitationChoice = {
  kind: "artifact",
  id: "44444444-4444-4444-8444-444444444444",
  label: "checkout-timeout.log",
};
const noteChoice: HumanAssessmentCitationChoice = {
  kind: "contribution",
  id: "contribution-investigator-note",
  label: "note: Queue time rises immediately after the connection-pool rollout.",
};

function mount(overrides: Partial<HumanAssessmentsPanelProps> = {}) {
  const props: HumanAssessmentsPanelProps = {
    resource: { status: "ready", value: [] },
    citationChoices: [artifactChoice, noteChoice],
    createAssessment: vi.fn(async () => ({ status: "succeeded" as const })),
    refresh: vi.fn(),
    ...overrides,
  };
  const view = render(<HumanAssessmentsPanel {...props} />);
  return { ...view, props };
}

afterEach(() => cleanup());

describe("shared human assessments panel", () => {
  it("exposes no runtime, navigation, or imported-run authority props", () => {
    expect(noForbiddenProps).toBe(true);
  });

  it("labels the section, badge, and migration note without treating an assessment as a verdict", () => {
    mount();
    const region = screen.getByRole("region", { name: "Human assessments" });
    expect(region.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByText("Append-only record")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Recorded human readings of this imported output. An assessment is not a correctness verdict.",
    );
    expect(document.body.textContent).toContain("Save review above");
    expect(document.body.textContent).toContain("do not change that status");
  });

  it("keeps idle distinct from empty and does not invent an empty history", () => {
    mount({ resource: { status: "idle" } });
    expect(screen.getByText("Waiting for recorded human assessments.")).toBeTruthy();
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
    expect(screen.getByRole("region", { name: "Human assessments" }).getAttribute("aria-busy")).toBe("true");
  });

  it("shows a busy loading status without claiming the history is empty", () => {
    mount({ resource: { status: "loading" } });
    expect(screen.getByText("Loading recorded human assessments…")).toBeTruthy();
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
    expect(screen.getByRole("region", { name: "Human assessments" }).getAttribute("aria-busy")).toBe("true");
  });

  it("renders an empty ready history without treating it as a failed load", () => {
    const refresh = vi.fn();
    mount({ resource: { status: "ready", value: [] }, refresh });
    expect(screen.getByText("No human assessment has been recorded yet.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps previous assessments visible while a refresh is in flight", () => {
    mount({
      resource: {
        status: "loading",
        previous: [record({ seq: 1, rationale: "Earlier reading." })],
      },
    });
    expect(screen.getByText("Earlier reading.")).toBeTruthy();
    expect(screen.getByText("Refreshing recorded human assessments…")).toBeTruthy();
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
  });

  it("distinguishes a failed load from empty and retries through the supplied callback", () => {
    const refresh = vi.fn();
    mount({
      resource: { status: "failed", error: "unavailable" },
      refresh,
    });
    expect(screen.getByRole("alert").textContent).toContain("could not be loaded right now");
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading assessments" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers no retry on a 404 and does not claim the history is empty", () => {
    mount({ resource: { status: "failed", error: "not_found" } });
    expect(screen.getByRole("alert").textContent).toContain("no longer available in the current scope");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record assessment" })).toBeNull();
  });

  it("offers no local retry or write after auth loss", () => {
    mount({ resource: { status: "failed", error: "auth_lost" } });
    expect(screen.getByRole("alert").textContent).toContain("Sign in again before loading assessments");
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record assessment" })).toBeNull();
    expect(screen.getByText(/Local retry is not available/)).toBeTruthy();
  });

  it("keeps previous assessments visible when a refresh fails", () => {
    const refresh = vi.fn();
    mount({
      resource: {
        status: "failed",
        error: "unavailable",
        previous: [record({ seq: 1, rationale: "Still visible." })],
      },
      refresh,
    });
    expect(screen.getByText("Still visible.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Previously loaded assessments remain visible");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading assessments" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("hides the form when writing is unavailable and keeps the record browsable", () => {
    mount({
      createAssessment: null,
      resource: { status: "ready", value: [record({ seq: 1, actorUsername: "lead" })] },
    });
    expect(screen.getByText("Assessment writing unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record assessment" })).toBeNull();
    expect(document.querySelector(".strategy-kit__human-assessments-meta")?.textContent)
      .toContain("lead");
  });

  it("uses a fieldset, labelled checkboxes, and a described rationale field", () => {
    mount();
    expect(screen.getByRole("group", { name: "Assessment" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Corroborates" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Contradicts" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Insufficient evidence" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "checkout-timeout.log" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: noteChoice.label })).toBeTruthy();
    const rationale = screen.getByRole("textbox", { name: "Rationale (optional)" });
    const describedBy = rationale.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy.split(" ")[0] ?? "")?.textContent).toMatch(/Maximum 4000/);
    expect(document.getElementById(describedBy.split(" ")[1] ?? "")?.textContent).toBe("0 / 4000");
  });

  it("requires a citation for corroborates and contradicts and allows none for insufficient evidence", async () => {
    const createAssessment = vi.fn(async () => ({ status: "succeeded" as const }));
    const view = mount({ createAssessment });
    fireEvent.click(screen.getByRole("radio", { name: "Corroborates" }));
    expect((screen.getByRole("button", { name: "Record assessment" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "checkout-timeout.log" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(1));
    expect(commandInput(createAssessment, 0).judgment).toBe("corroborates");
    expect(commandInput(createAssessment, 0).links).toEqual([artifactChoice]);

    view.rerender(<HumanAssessmentsPanel
      {...view.props}
      resource={{ status: "ready", value: [record({ seq: 1, value: "corroborates" })] }}
    />);
    await waitFor(() => expect(
      (screen.getByRole("radio", { name: "Insufficient evidence" }) as HTMLInputElement).disabled,
    ).toBe(false));

    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(2));
    expect(commandInput(createAssessment, 1).judgment).toBe("insufficient_evidence");
    expect(commandInput(createAssessment, 1).links).toEqual([]);
    expect(commandInput(createAssessment, 1).rationale).toBeNull();
  });

  it("caps citations at 64 and rationale at 4000", () => {
    const choices = Array.from({ length: 65 }, (_, index) => ({
      kind: "artifact" as const,
      id: `artifact-${index}`,
      label: `file-${index}.log`,
    }));
    mount({ citationChoices: choices });
    const citationCheckboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    for (let index = 0; index < 64; index += 1) {
      fireEvent.click(citationCheckboxes[index]!);
    }
    const extra = citationCheckboxes[64]!;
    expect(extra.disabled).toBe(true);
    expect(screen.getByText(/Select at most 64/)).toBeTruthy();

    const rationale = screen.getByRole("textbox", { name: "Rationale (optional)" }) as HTMLTextAreaElement;
    expect(rationale.maxLength).toBe(4000);
    fireEvent.change(rationale, { target: { value: "x".repeat(4000) } });
    expect(rationale.value).toHaveLength(4000);
    expect(screen.getByText("4000 / 4000")).toBeTruthy();
  });

  it("renders ordered history with actor, time, rationale fallback, and generic snapshot links", () => {
    mount({
      resource: {
        status: "ready",
        value: [
          record({
            seq: 2,
            value: "contradicts",
            actorUsername: "bob",
            recordedAt: "2026-09-09T13:00:00.000Z",
            rationale: "Second reading.",
            links: [{ kind: "snapshot", id: "snap-1", label: "Snapshot" }],
          }),
          record({
            seq: 1,
            value: "corroborates",
            actorUsername: "alice",
            recordedAt: "2026-09-09T12:00:00.000Z",
            rationale: null,
            links: [{ kind: "artifact", id: artifactChoice.id, label: artifactChoice.label }],
          }),
        ],
      },
    });
    const items = document.querySelectorAll(".strategy-kit__human-assessments-item");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Corroborates");
    expect(items[0]?.textContent).toContain("alice");
    expect(items[0]?.textContent).toContain("No rationale recorded");
    expect(items[0]?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-09-09T12:00:00.000Z");
    expect(items[1]?.textContent).toContain("Contradicts");
    expect(items[1]?.textContent).toContain("bob");
    expect(items[1]?.textContent).toContain("Second reading.");
    expect(items[1]?.textContent).toContain("Snapshot");
  });

  it.each([
    ["links_required", /needs at least one citation/],
    ["case_archived", /investigation is archived/],
    ["privacy_mismatch", /privacy boundary/],
    ["idempotency_intent_mismatch", /no longer matches the original assessment/],
    ["judgment_limit_reached", /recorded assessment limit/],
  ] as const)("maps %s without exposing private detail", async (error, copy) => {
    const createAssessment = vi.fn(async () => ({ status: "failed" as const, error }));
    mount({ createAssessment });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(copy);
    expect(document.body.textContent).not.toContain("internal");
    expect(document.body.textContent).not.toContain("stack");
    expect((screen.getByRole("radio", { name: "Insufficient evidence" }) as HTMLInputElement).checked).toBe(true);
  });

  it.each([
    "auth_lost",
    "not_found",
    "case_archived",
    "judgment_limit_reached",
  ] as const)("fails closed after terminal write failure %s", async (error) => {
    const createAssessment = vi.fn(async () => ({ status: "failed" as const, error }));
    mount({ createAssessment });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("radio", { name: "Insufficient evidence" }).matches(":disabled")).toBe(true);
    expect((screen.getByRole("textbox", { name: "Rationale (optional)" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Record assessment" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it.each([
    "commit_outcome_unknown",
    "conflict",
    "auth_lost",
    "not_found",
    "case_archived",
    "judgment_limit_reached",
  ] as const)("fails closed for mutation-only %s state", (error) => {
    mount({ mutation: { status: "failed", error } });
    expect(screen.getByRole("radio", { name: "Insufficient evidence" }).matches(":disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "Record assessment" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("group", { name: "Assessment submission problem" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry unchanged assessment" })).toBeNull();
  });

  it("mints a new request key when a definitive failure is edited into a new intent", async () => {
    const createAssessment = vi.fn()
      .mockResolvedValueOnce({ status: "failed" as const, error: "validation" as const })
      .mockResolvedValueOnce({ status: "succeeded" as const });
    mount({ createAssessment });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(1));
    const firstKey = commandInput(createAssessment, 0).idempotencyKey;

    fireEvent.change(screen.getByRole("textbox", { name: "Rationale (optional)" }), {
      target: { value: "A materially revised assessment." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(2));
    expect(commandInput(createAssessment, 1).idempotencyKey).not.toBe(firstKey);
  });

  it("preserves the draft and key after conflict and never auto-posts", async () => {
    const createAssessment = vi.fn(async () => ({ status: "failed" as const, error: "conflict" as const }));
    const refresh = vi.fn();
    const view = mount({ createAssessment, refresh });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rationale (optional)" }), {
      target: { value: "Keep this draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(1));
    const firstKey = commandInput(createAssessment, 0).idempotencyKey;
    expect(screen.getByRole("alert").textContent).toMatch(/Another assessment was recorded first/);
    expect((screen.getByRole("textbox", { name: "Rationale (optional)" }) as HTMLTextAreaElement).value)
      .toBe("Keep this draft.");
    expect(createAssessment).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Retry unchanged assessment" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh recorded assessments" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Retry unchanged assessment" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<HumanAssessmentsPanel
      {...view.props}
      resource={{ status: "loading", previous: [] }}
    />);
    view.rerender(<HumanAssessmentsPanel
      {...view.props}
      resource={{ status: "ready", value: [] }}
    />);
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Retry unchanged assessment" }) as HTMLButtonElement).disabled,
    ).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry unchanged assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(2));
    expect(commandInput(createAssessment, 1).idempotencyKey).toBe(firstKey);
    expect(commandInput(createAssessment, 1).rationale).toBe("Keep this draft.");
  });

  it("freezes an unknown 503 outcome and retries the exact payload only after refresh", async () => {
    const createAssessment = vi.fn(async () => ({
      status: "failed" as const,
      error: "commit_outcome_unknown" as const,
    }));
    const refresh = vi.fn();
    const view = mount({ createAssessment, refresh });
    fireEvent.click(screen.getByRole("radio", { name: "Corroborates" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "checkout-timeout.log" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rationale (optional)" }), {
      target: { value: "May already be recorded." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(screen.getByText("Assessment outcome unknown")).toBeTruthy());
    const first = commandInput(createAssessment, 0);
    expect(screen.getByRole("radio", { name: "Corroborates" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "checkout-timeout.log" }).matches(":disabled")).toBe(true);
    expect((screen.getByRole("textbox", { name: "Rationale (optional)" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Retry unchanged assessment" }) as HTMLButtonElement).disabled).toBe(true);
    expect(createAssessment).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh recorded assessments" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Retry unchanged assessment" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<HumanAssessmentsPanel
      {...view.props}
      resource={{ status: "loading", previous: [] }}
    />);
    view.rerender(<HumanAssessmentsPanel
      {...view.props}
      resource={{ status: "ready", value: [] }}
    />);
    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Retry unchanged assessment" }) as HTMLButtonElement).disabled,
    ).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Retry unchanged assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(2));
    expect(commandInput(createAssessment, 1)).toEqual(first);
  });

  it("does not auto-retry an unknown outcome", async () => {
    const createAssessment = vi.fn(async () => ({
      status: "failed" as const,
      error: "commit_outcome_unknown" as const,
    }));
    const { rerender, props } = mount({ createAssessment });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(1));
    rerender(<HumanAssessmentsPanel {...props} mutation={{ status: "failed", error: "commit_outcome_unknown" }} />);
    expect(createAssessment).toHaveBeenCalledTimes(1);
  });

  it("clears the form, mints a new key, and announces success once", async () => {
    const createAssessment = vi.fn(async () => ({ status: "succeeded" as const }));
    const refresh = vi.fn();
    const view = mount({ createAssessment, refresh });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rationale (optional)" }), {
      target: { value: "  First reading.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(
      screen.getByText("The assessment was recorded. Updating the recorded history…"),
    ).toBeTruthy());
    const firstKey = commandInput(createAssessment, 0).idempotencyKey;
    expect(commandInput(createAssessment, 0).rationale).toBe("First reading.");
    expect((screen.getByRole("textbox", { name: "Rationale (optional)" }) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByRole("radio", { name: "Insufficient evidence" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("No human assessment has been recorded yet.")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: "Insufficient evidence" }).matches(":disabled")).toBe(true);

    view.rerender(<HumanAssessmentsPanel
      {...view.props}
      resource={{ status: "ready", value: [record({ seq: 1 })] }}
    />);
    await waitFor(() => expect(
      screen.getByText("The assessment was recorded."),
    ).toBeTruthy());
    expect((screen.getByRole("radio", { name: "Insufficient evidence" }) as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    await waitFor(() => expect(createAssessment).toHaveBeenCalledTimes(2));
    expect(commandInput(createAssessment, 1).idempotencyKey).not.toBe(firstKey);
  });

  it("focuses a mutation failure once and does not steal focus on ordinary load or refresh", async () => {
    const createAssessment = vi.fn(async () => ({ status: "failed" as const, error: "validation" as const }));
    const view = mount({ resource: { status: "loading" } });
    expect(document.activeElement).not.toBe(screen.queryByRole("alert"));

    view.rerender(<HumanAssessmentsPanel
      resource={{ status: "ready", value: [] }}
      citationChoices={[artifactChoice, noteChoice]}
      createAssessment={createAssessment}
      refresh={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Record assessment" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.closest("[tabindex]") === document.activeElement
      || document.activeElement === alert
      || alert.parentElement === document.activeElement).toBe(true));
    const focused = document.activeElement;
    view.rerender(<HumanAssessmentsPanel
      resource={{ status: "loading", previous: [] }}
      citationChoices={[artifactChoice, noteChoice]}
      createAssessment={createAssessment}
      refresh={vi.fn()}
      mutation={{ status: "failed", error: "validation" }}
    />);
    expect(document.activeElement).toBe(focused);
  });

  it("prevents duplicate in-flight submits", async () => {
    const deferred = createDeferred<{ status: "succeeded" }>();
    const createAssessment = vi.fn(() => deferred.promise);
    mount({ createAssessment });
    fireEvent.click(screen.getByRole("radio", { name: "Insufficient evidence" }));
    const form = screen.getByRole("form", { name: "Record an assessment" });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createAssessment).toHaveBeenCalledTimes(1);
    await act(async () => {
      deferred.resolve({ status: "succeeded" });
      await deferred.promise;
    });
  });
});
