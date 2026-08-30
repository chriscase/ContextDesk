import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContributionV1,
  InvestigationRuntimeCommands,
  MutationState,
} from "../../runtime/public.js";
import {
  createDeferred,
  makeContributionList,
  type Deferred,
} from "../../runtime/testkit/index.js";
import {
  KeystoneHypothesisComposer,
  type KeystoneHypothesisComposerProps,
  type KeystoneHypothesisEvidence,
} from "./KeystoneHypothesisComposer.js";

type CreateContribution = NonNullable<
  InvestigationRuntimeCommands["createContribution"]
>;

const IDLE: MutationState<ContributionV1> = { status: "idle" };
const EVIDENCE: readonly KeystoneHypothesisEvidence[] = [
  { id: "artifact-log-1", name: "checkout-timeout.log" },
  { id: "artifact-trace-2", name: "gateway-trace.json" },
];

function authoritativeContribution(): ContributionV1 {
  const contribution = makeContributionList().contributions[0];
  if (contribution === undefined) throw new Error("contribution fixture is empty");
  return contribution;
}

function succeededCommand(contribution = authoritativeContribution()): CreateContribution {
  return vi.fn(async () => ({ status: "succeeded" as const, value: contribution }));
}

function mount(overrides: Partial<KeystoneHypothesisComposerProps> = {}) {
  let props: KeystoneHypothesisComposerProps = {
    selectedEvidence: EVIDENCE,
    createContribution: succeededCommand(),
    mutationState: IDLE,
    ...overrides,
  };
  const view = render(<KeystoneHypothesisComposer {...props} />);
  return {
    ...view,
    rerenderComposer(next: Partial<KeystoneHypothesisComposerProps>) {
      props = { ...props, ...next };
      view.rerender(<KeystoneHypothesisComposer {...props} />);
    },
  };
}

function hypothesisField(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Hypothesis" }) as HTMLTextAreaElement;
}

function hypothesisForm(): HTMLFormElement {
  return screen.getByRole("form", {
    name: "Draft an evidence-linked hypothesis",
  }) as HTMLFormElement;
}

afterEach(() => cleanup());

describe("Keystone K2 evidence-linked hypothesis composer", () => {
  it("hides writing controls when the public command is unavailable", () => {
    mount({ createContribution: null });

    expect(screen.getByText("Hypothesis writing unavailable")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Record hypothesis" })).toBeNull();
  });

  it("writes nothing for a blank body or without required selected evidence", () => {
    const command = succeededCommand();
    const mounted = mount({ createContribution: command });
    const field = hypothesisField();

    fireEvent.change(field, { target: { value: "   \n" } });
    fireEvent.submit(hypothesisForm());
    expect(command).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);

    mounted.rerenderComposer({ selectedEvidence: [] });
    fireEvent.change(field, { target: { value: "Queue time rises after the rollout." } });
    fireEvent.submit(hypothesisForm());
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

    expect(command).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record hypothesis" }).getAttribute("disabled")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Select at least one evidence artifact");
  });

  it("sends exactly one field-bounded hypothesis and clears only after authoritative success", async () => {
    const deferred: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const command: CreateContribution = vi.fn(() => deferred.promise);
    const onSuccess = vi.fn();
    mount({ createContribution: command, onSuccess });
    const field = hypothesisField();
    const body = "  Queue time rises after the rollout.  ";

    fireEvent.change(field, { target: { value: body } });
    fireEvent.click(screen.getByRole("button", { name: "Record hypothesis" }));

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith({
      kind: "hypothesis",
      body,
      hypothesisLinks: [
        { kind: "artifact", id: "artifact-log-1" },
        { kind: "artifact", id: "artifact-trace-2" },
      ],
    });
    expect(Object.keys(vi.mocked(command).mock.calls[0]![0]).sort()).toEqual([
      "body",
      "hypothesisLinks",
      "kind",
    ]);
    expect(field.value).toBe(body);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/privacy/iu)).toBeNull();
    expect(screen.queryByLabelText(/priority|status/iu)).toBeNull();

    const contribution = authoritativeContribution();
    await act(async () => {
      deferred.resolve({ status: "succeeded", value: contribution });
      await deferred.promise;
    });

    await waitFor(() => expect(field.value).toBe(""));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(contribution);
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole("status").textContent).toContain("Recorded with 2 evidence citations");
  });

  it("suppresses duplicate submits locally and disables submit for either local or public running state", async () => {
    const deferred: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const command: CreateContribution = vi.fn(() => deferred.promise);
    const mounted = mount({ createContribution: command });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "Only one write may start." } });

    fireEvent.submit(hypothesisForm());
    fireEvent.submit(hypothesisForm());
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Recording hypothesis…" }).getAttribute("disabled")).not.toBeNull();

    await act(async () => {
      deferred.resolve({ status: "ignored", reason: "stale" });
      await deferred.promise;
    });
    mounted.rerenderComposer({ mutationState: { status: "running" } });
    fireEvent.submit(hypothesisForm());

    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Recording hypothesis…" }).getAttribute("disabled")).not.toBeNull();
  });

  it.each([
    ["failed", { status: "failed", error: { kind: "validation", status: 400 } }],
    ["stale", { status: "ignored", reason: "stale" }],
    ["busy", { status: "ignored", reason: "busy" }],
    ["not ready", { status: "ignored", reason: "not_ready" }],
  ] as const)("retains the draft after a %s command outcome", async (_label, outcome) => {
    const command: CreateContribution = vi.fn(async () => outcome);
    const onSuccess = vi.fn();
    mount({ createContribution: command, onSuccess });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "Keep this draft on a non-success outcome." } });

    fireEvent.submit(hypothesisForm());

    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Recording the hypothesis once…")).toBeNull());
    expect(field.value).toBe("Keep this draft on a non-success outcome.");
    expect(onSuccess).not.toHaveBeenCalled();
    if (outcome.status === "failed") {
      expect(screen.getByRole("alert").textContent).toContain("could not be recorded");
    } else {
      expect(screen.getByRole("status").textContent).toContain(
        outcome.reason === "stale" ? "view changed" : "draft remains available",
      );
    }
  });

  it("derives links from the current working set and never retains removed target IDs", async () => {
    const command = succeededCommand();
    const mounted = mount({
      createContribution: command,
      selectedEvidence: [{ id: "artifact-old", name: "old.log" }],
    });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "Use only the evidence selected now." } });
    mounted.rerenderComposer({
      selectedEvidence: [{ id: "artifact-current", name: "current.log" }],
    });

    fireEvent.keyDown(field, { key: "Enter" });
    expect(command).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command).toHaveBeenCalledWith({
      kind: "hypothesis",
      body: "Use only the evidence selected now.",
      hypothesisLinks: [{ kind: "artifact", id: "artifact-current" }],
    });
    expect(JSON.stringify(vi.mocked(command).mock.calls)).not.toContain("artifact-old");
    expect(screen.queryByText("old.log")).toBeNull();
  });

  it("keeps newer typing when an earlier authoritative success arrives", async () => {
    const deferred: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const command: CreateContribution = vi.fn(() => deferred.promise);
    mount({ createContribution: command });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "Submitted draft" } });
    fireEvent.submit(hypothesisForm());
    fireEvent.change(field, { target: { value: "Newer local draft" } });

    await act(async () => {
      deferred.resolve({ status: "succeeded", value: authoritativeContribution() });
      await deferred.promise;
    });

    await waitFor(() => expect(field.value).toBe("Newer local draft"));
  });

  it("clears a draft only on the explicit clear action and restores input focus", () => {
    const command = succeededCommand();
    mount({ createContribution: command });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "Discard this local draft." } });

    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));

    expect(field.value).toBe("");
    expect(document.activeElement).toBe(field);
    expect(command).not.toHaveBeenCalled();
  });

  it("maps public mutation failures to bounded alert copy without rendering detail", () => {
    const privateDetail = "private lifecycle refusal detail must not render";
    mount({
      mutationState: {
        status: "failed",
        error: {
          kind: "lifecycle_refused",
          status: 409,
          action: "archive",
          reason: "legal_hold",
          detail: privateDetail,
        },
      },
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("does not currently allow this contribution");
    expect(document.body.textContent).not.toContain(privateDetail);
  });
});
