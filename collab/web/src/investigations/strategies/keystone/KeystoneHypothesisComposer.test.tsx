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
    scopeKey: "analyst-a:case-a",
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

  it("drops a private draft when write authority disappears before it returns", () => {
    const command = succeededCommand();
    const mounted = mount({ createContribution: command });
    fireEvent.change(hypothesisField(), { target: { value: "Do not restore this draft." } });

    mounted.rerenderComposer({ createContribution: null });
    expect(screen.getByText("Hypothesis writing unavailable")).toBeTruthy();
    expect(screen.queryByDisplayValue("Do not restore this draft.")).toBeNull();

    mounted.rerenderComposer({ createContribution: command });
    expect(hypothesisField().value).toBe("");
    expect(screen.queryByText("Hypothesis recorded")).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it("fences an in-flight success when write authority disappears", async () => {
    const deferred: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const command: CreateContribution = vi.fn(() => deferred.promise);
    const onSuccess = vi.fn();
    const mounted = mount({ createContribution: command, onSuccess });
    fireEvent.change(hypothesisField(), { target: { value: "Pending before authority loss." } });
    fireEvent.submit(hypothesisForm());
    expect(command).toHaveBeenCalledTimes(1);

    mounted.rerenderComposer({ createContribution: null });
    expect(screen.getByText("Hypothesis writing unavailable")).toBeTruthy();

    await act(async () => {
      deferred.resolve({ status: "succeeded", value: authoritativeContribution() });
      await deferred.promise;
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText("Hypothesis recorded")).toBeNull();
    expect(screen.queryByDisplayValue("Pending before authority loss.")).toBeNull();
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
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      kind: "hypothesis",
      body,
      hypothesisLinks: [
        { kind: "artifact", id: "artifact-log-1" },
        { kind: "artifact", id: "artifact-trace-2" },
      ],
      idempotencyKey: expect.stringMatching(/^keystone-hypothesis-/),
    }));
    expect(Object.keys(vi.mocked(command).mock.calls[0]![0]).sort()).toEqual([
      "body",
      "hypothesisLinks",
      "idempotencyKey",
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
      expect(screen.getByRole("alert").textContent).toContain("could not be accepted");
    } else {
      expect(screen.getByRole("status").textContent).toContain(
        outcome.reason === "stale" ? "view changed" : "draft remains available",
      );
    }
  });

  it("reuses one idempotency key after an ambiguous response loss and rotates after success", async () => {
    const durableByKey = new Map<string, ContributionV1>();
    const responsesToLose = new Set([1, 4]);
    let callCount = 0;
    const command: CreateContribution = vi.fn(async (input) => {
      callCount += 1;
      const key = input.idempotencyKey;
      if (key === undefined) throw new Error("missing duplicate-prevention key");
      const durable = durableByKey.get(key) ?? authoritativeContribution();
      durableByKey.set(key, durable);
      if (responsesToLose.has(callCount)) {
        throw new Error("response lost after commit");
      }
      return { status: "succeeded" as const, value: durable };
    });
    const mounted = mount({ createContribution: command });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "One durable hypothesis despite a lost response." } });

    fireEvent.submit(hypothesisForm());
    expect(await screen.findByText("Hypothesis outcome unknown")).toBeTruthy();
    mounted.rerenderComposer({
      mutationState: { status: "failed", error: { kind: "network" } },
    });
    expect(screen.getByRole("alert").textContent).toContain("may have recorded");
    expect(field.value).toBe("One durable hypothesis despite a lost response.");
    expect(durableByKey.size).toBe(1);

    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(field.value).toBe(""));
    expect(command).toHaveBeenCalledTimes(2);
    const firstKey = vi.mocked(command).mock.calls[0]?.[0].idempotencyKey;
    const retryKey = vi.mocked(command).mock.calls[1]?.[0].idempotencyKey;
    expect(firstKey).toMatch(/^keystone-hypothesis-/);
    expect(retryKey).toBe(firstKey);
    expect(durableByKey.size).toBe(1);

    mounted.rerenderComposer({ mutationState: IDLE });
    fireEvent.change(field, { target: { value: "One durable hypothesis despite a lost response." } });
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(field.value).toBe(""));
    const postSuccessKey = vi.mocked(command).mock.calls[2]?.[0].idempotencyKey;
    expect(postSuccessKey).toMatch(/^keystone-hypothesis-/);
    expect(postSuccessKey).not.toBe(firstKey);
    expect(durableByKey.size).toBe(2);

    fireEvent.change(field, { target: { value: "A second hypothesis with another lost response." } });
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(4));
    mounted.rerenderComposer({
      mutationState: { status: "failed", error: { kind: "network" } },
    });
    expect(await screen.findByText("Hypothesis outcome unknown")).toBeTruthy();
    const ambiguousKey = vi.mocked(command).mock.calls[3]?.[0].idempotencyKey;

    fireEvent.change(field, { target: { value: "A deliberately new hypothesis intent." } });
    expect(screen.queryByText("Hypothesis outcome unknown")).toBeNull();
    expect(screen.queryByText(/retrying this unchanged draft/iu)).toBeNull();
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(field.value).toBe(""));
    const nextKey = vi.mocked(command).mock.calls[4]?.[0].idempotencyKey;
    expect(nextKey).toMatch(/^keystone-hypothesis-/);
    expect(nextKey).not.toBe(ambiguousKey);
    expect(durableByKey.size).toBe(4);
  });

  it("rotates an ambiguous retry key after the user explicitly clears and restores the draft", async () => {
    const command: CreateContribution = vi.fn(async () => ({
      status: "ignored" as const,
      reason: "not_ready" as const,
    }));
    const mounted = mount({ createContribution: command });
    const field = hypothesisField();
    const body = "Restore this text only as a new intent after clearing.";
    fireEvent.change(field, { target: { value: body } });
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));

    mounted.rerenderComposer({
      mutationState: { status: "failed", error: { kind: "network" } },
    });
    expect(await screen.findByText("Hypothesis outcome unknown")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("may have recorded");
    const firstKey = vi.mocked(command).mock.calls[0]?.[0].idempotencyKey;

    fireEvent.click(screen.getByRole("button", { name: "Clear draft" }));
    mounted.rerenderComposer({ mutationState: IDLE });
    fireEvent.change(field, { target: { value: body } });
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));

    const restoredKey = vi.mocked(command).mock.calls[1]?.[0].idempotencyKey;
    expect(restoredKey).toMatch(/^keystone-hypothesis-/);
    expect(restoredKey).not.toBe(firstKey);
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
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      kind: "hypothesis",
      body: "Use only the evidence selected now.",
      hypothesisLinks: [{ kind: "artifact", id: "artifact-current" }],
      idempotencyKey: expect.stringMatching(/^keystone-hypothesis-/),
    }));
    expect(JSON.stringify(vi.mocked(command).mock.calls)).not.toContain("artifact-old");
    expect(screen.queryByText("old.log")).toBeNull();
  });

  it("excludes empty and duplicate artifact IDs while preserving first-seen order", async () => {
    const command = succeededCommand();
    mount({
      createContribution: command,
      selectedEvidence: [
        { id: "", name: "empty" },
        { id: "artifact-second", name: "second.log" },
        { id: "artifact-first", name: "first.log" },
        { id: "artifact-second", name: "duplicate.log" },
        { id: "", name: "another empty" },
      ],
    });
    fireEvent.change(hypothesisField(), { target: { value: "Preserve citation order." } });
    fireEvent.submit(hypothesisForm());

    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      kind: "hypothesis",
      body: "Preserve citation order.",
      hypothesisLinks: [
        { kind: "artifact", id: "artifact-second" },
        { kind: "artifact", id: "artifact-first" },
      ],
      idempotencyKey: expect.stringMatching(/^keystone-hypothesis-/),
    }));
  });

  it("uses Meta+Enter but never submits a composing Enter chord", async () => {
    const command = succeededCommand();
    mount({ createContribution: command });
    const field = hypothesisField();
    fireEvent.change(field, { target: { value: "Keyboard submission remains explicit." } });

    fireEvent.keyDown(field, {
      key: "Enter",
      metaKey: true,
      isComposing: true,
    });
    expect(command).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  });

  it("fences draft and feedback before a new identity-investigation scope is shown", async () => {
    const commandA = succeededCommand();
    const commandB = succeededCommand();
    const mounted = mount({
      scopeKey: "analyst-a:case-a",
      createContribution: commandA,
    });
    fireEvent.change(hypothesisField(), { target: { value: "Case A private draft" } });
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(screen.getByText("Hypothesis recorded")).toBeTruthy());

    mounted.rerenderComposer({
      scopeKey: "analyst-b:case-b",
      createContribution: commandB,
      selectedEvidence: [{ id: "artifact-b", name: "case-b.log" }],
    });

    expect(hypothesisField().value).toBe("");
    expect(screen.queryByText("Case A private draft")).toBeNull();
    expect(screen.queryByText("Hypothesis recorded")).toBeNull();
    fireEvent.submit(hypothesisForm());
    expect(commandB).not.toHaveBeenCalled();
  });

  it("ignores an old-scope completion and submits the new scope with its command and evidence", async () => {
    const deferredA: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const commandA: CreateContribution = vi.fn(() => deferredA.promise);
    const commandB = succeededCommand();
    const onSuccessA = vi.fn();
    const mounted = mount({
      scopeKey: "analyst-a:case-a",
      createContribution: commandA,
      selectedEvidence: [{ id: "artifact-a", name: "case-a.log" }],
      onSuccess: onSuccessA,
    });
    fireEvent.change(hypothesisField(), { target: { value: "Case A in flight" } });
    fireEvent.submit(hypothesisForm());
    expect(commandA).toHaveBeenCalledTimes(1);

    mounted.rerenderComposer({
      scopeKey: "analyst-b:case-b",
      createContribution: commandB,
      selectedEvidence: [{ id: "artifact-b", name: "case-b.log" }],
      onSuccess: vi.fn(),
    });
    const fieldB = hypothesisField();
    fireEvent.change(fieldB, { target: { value: "Case B current draft" } });
    expect(screen.queryByText("Recording hypothesis…")).toBeNull();
    expect(screen.getByRole("button", { name: "Record hypothesis" }).getAttribute("disabled")).toBeNull();

    await act(async () => {
      deferredA.resolve({ status: "succeeded", value: authoritativeContribution() });
      await deferredA.promise;
    });

    expect(fieldB.value).toBe("Case B current draft");
    expect(onSuccessA).not.toHaveBeenCalled();
    expect(screen.queryByText("Hypothesis recorded")).toBeNull();

    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(commandB).toHaveBeenCalledTimes(1));
    expect(commandB).toHaveBeenCalledWith(expect.objectContaining({
      kind: "hypothesis",
      body: "Case B current draft",
      hypothesisLinks: [{ kind: "artifact", id: "artifact-b" }],
      idempotencyKey: expect.stringMatching(/^keystone-hypothesis-/),
    }));
    expect(JSON.stringify(vi.mocked(commandB).mock.calls)).not.toContain("artifact-a");
  });

  it("invalidates a pending success callback when the composer unmounts", async () => {
    const deferred: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const command: CreateContribution = vi.fn(() => deferred.promise);
    const onSuccess = vi.fn();
    const mounted = mount({ createContribution: command, onSuccess });
    fireEvent.change(hypothesisField(), { target: { value: "Pending during unmount." } });
    fireEvent.submit(hypothesisForm());

    mounted.unmount();
    await act(async () => {
      deferred.resolve({ status: "succeeded", value: authoritativeContribution() });
      await deferred.promise;
    });

    expect(onSuccess).not.toHaveBeenCalled();
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

  it("keeps the body when evidence changes during a pending success and gives that new intent a fresh key", async () => {
    const deferred: Deferred<Awaited<ReturnType<CreateContribution>>> = createDeferred();
    const command: CreateContribution = vi.fn(() => deferred.promise);
    const mounted = mount({
      createContribution: command,
      selectedEvidence: [{ id: "artifact-a", name: "a.log" }],
    });
    const field = hypothesisField();
    const body = "The same words cite a different evidence set.";
    fireEvent.change(field, { target: { value: body } });
    fireEvent.submit(hypothesisForm());
    const firstKey = vi.mocked(command).mock.calls[0]?.[0].idempotencyKey;

    mounted.rerenderComposer({
      selectedEvidence: [{ id: "artifact-b", name: "b.log" }],
    });
    await act(async () => {
      deferred.resolve({ status: "succeeded", value: authoritativeContribution() });
      await deferred.promise;
    });

    await waitFor(() => expect(field.value).toBe(body));
    fireEvent.submit(hypothesisForm());
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    const secondCall = vi.mocked(command).mock.calls[1]?.[0];
    expect(secondCall).toEqual(expect.objectContaining({
      body,
      hypothesisLinks: [{ kind: "artifact", id: "artifact-b" }],
      idempotencyKey: expect.stringMatching(/^keystone-hypothesis-/),
    }));
    expect(secondCall?.idempotencyKey).not.toBe(firstKey);
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

  it("maps a submitted public mutation failure to bounded alert copy without rendering detail", async () => {
    const privateDetail = "private lifecycle refusal detail must not render";
    const command: CreateContribution = vi.fn(async () => ({
      status: "failed" as const,
      error: {
        kind: "lifecycle_refused" as const,
        status: 409 as const,
        action: "archive" as const,
        reason: "legal_hold" as const,
        detail: privateDetail,
      },
    }));
    mount({
      createContribution: command,
    });
    fireEvent.change(hypothesisField(), {
      target: { value: "A bounded failure should keep this draft." },
    });
    fireEvent.submit(hypothesisForm());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("does not currently allow this contribution");
    expect(document.body.textContent).not.toContain(privateDetail);
  });
});
