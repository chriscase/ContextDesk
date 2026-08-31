import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CaseV1,
  CommandOutcome,
  MutationState,
} from "../../runtime/public.js";
import {
  createDeferred,
  makePopulatedCase,
  makeSparseImportedCase,
} from "../../runtime/testkit/index.js";
import {
  KeystoneSituationEditor,
  type KeystoneSituationEditorProps,
} from "./KeystoneSituationEditor.js";

const IDLE: MutationState<CaseV1> = { status: "idle" };
type UpdateSituation = NonNullable<KeystoneSituationEditorProps["updateSituation"]>;

function mountEditor(overrides: Partial<KeystoneSituationEditorProps> = {}) {
  let props: KeystoneSituationEditorProps = {
    identityKey: "identity-alice",
    investigation: makePopulatedCase(),
    updateSituation: vi.fn<UpdateSituation>(async () => ({
      status: "ignored",
      reason: "not_ready",
    })),
    mutation: IDLE,
    ...overrides,
  };
  const view = render(<KeystoneSituationEditor {...props} />);
  return {
    unmount: view.unmount,
    rerender(next: Partial<KeystoneSituationEditorProps>) {
      props = { ...props, ...next };
      view.rerender(<KeystoneSituationEditor {...props} />);
    },
  };
}

function enterEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Edit situation" }));
  return screen.getByRole("form", { name: "Edit recorded situation" });
}

afterEach(() => cleanup());

describe("Keystone K2 situation correction", () => {
  it("is view-first and truthfully read-only when the command seam is null", () => {
    const investigation = makePopulatedCase();
    mountEditor({ investigation, updateSituation: null });

    expect(screen.getByRole("heading", { name: "Recorded situation" })).toBeTruthy();
    expect(screen.getByText(investigation.problemStatement)).toBeTruthy();
    expect(screen.getByText(investigation.affectedParties)).toBeTruthy();
    expect(screen.getByText(investigation.openQuestions[0]!)).toBeTruthy();
    expect(screen.getByText(investigation.investigationContext!.build)).toBeTruthy();
    expect(screen.getByText(/editing is unavailable/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit situation" })).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByText(investigation.title)).toBeNull();
    expect(screen.queryByText(investigation.status)).toBeNull();
    expect(screen.queryByText(investigation.severity)).toBeNull();
  });

  it("does not write an unchanged draft and focuses the first native field on entry", () => {
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "ignored",
      reason: "not_ready",
    }));
    mountEditor({ updateSituation });

    const form = enterEditor();
    const firstField = screen.getByLabelText("Problem statement");
    expect(document.activeElement).toBe(firstField);
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.submit(form);
    expect(updateSituation).not.toHaveBeenCalled();
  });

  it("drops an open draft immediately when the command seam becomes read-only", () => {
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "ignored",
      reason: "not_ready",
    }));
    const mounted = mountEditor({ updateSituation });
    enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "PRIVATE REVOKED DRAFT" },
    });

    mounted.rerender({ updateSituation: null });
    expect(document.body.textContent).not.toContain("PRIVATE REVOKED DRAFT");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit situation" })).toBeNull();
    expect(screen.getByText(/editing is unavailable/i)).toBeTruthy();
    expect(updateSituation).not.toHaveBeenCalled();
  });

  it("sends one exact partial command and exits onto the authoritative success result", async () => {
    const investigation = makePopulatedCase();
    const accepted: CaseV1 = {
      ...investigation,
      impact: "Server-confirmed impact after correction.",
      scope: "Server-confirmed rollout boundary.",
      situationVersion: investigation.situationVersion + 1,
    };
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "succeeded",
      value: accepted,
    }));
    const onSuccess = vi.fn();
    mountEditor({ investigation, updateSituation, onSuccess });

    enterEditor();
    fireEvent.change(screen.getByLabelText("Impact"), {
      target: { value: "Draft impact correction." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Server-confirmed impact after correction.")).toBeTruthy();
    expect(screen.getByText("Server-confirmed rollout boundary.")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect(updateSituation).toHaveBeenCalledWith({ impact: "Draft impact correction." });
    const submitted = updateSituation.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(submitted)).toEqual(["impact"]);
    for (const forbidden of [
      "title",
      "severity",
      "status",
      "occurredAt",
      "occurredAtPrecision",
      "occurredAtZone",
      "participants",
      "legalHold",
      "retentionClass",
      "expectedVersion",
    ]) {
      expect(submitted).not.toHaveProperty(forbidden);
    }
    expect(onSuccess).toHaveBeenCalledWith(accepted);
    expect(screen.getByRole("status").textContent).toContain("Situation changes recorded");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit situation" }));
  });

  it("normalizes edited questions and preserves explicit empty/null erasures on conflict", async () => {
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "failed",
      error: { kind: "conflict", status: 409 },
    }));
    mountEditor({ updateSituation });
    enterEditor();

    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Open questions"), {
      target: { value: "  Is the queue still rising?  \r\n\nDid retries stop?   \n" },
    });
    for (const label of [
      "Product or software",
      "Version",
      "Build",
      "Component",
      "Environment",
      "Customer, team, or organization",
    ]) {
      fireEvent.change(screen.getByLabelText(label), {
        target: { value: label === "Product or software" ? "   " : "" },
      });
    }
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent)
      .toMatch(/changed before this save completed/i);
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect(updateSituation).toHaveBeenCalledWith({
      scope: "",
      openQuestions: ["Is the queue still rising?", "Did retries stop?"],
      investigationContext: null,
    });
    expect((screen.getByLabelText("Scope") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Open questions") as HTMLTextAreaElement).value)
      .toBe("  Is the queue still rising?  \n\nDid retries stop?   \n");
    expect(screen.getByRole("form", { name: "Edit recorded situation" })).toBeTruthy();
  });

  it("blocks conflict retry until an explicit newer-record rebase and then sends only the rebased diff", async () => {
    const investigation = makePopulatedCase();
    const sharedProblem = "A teammate recorded this same corrected problem.";
    const localImpact = "My retained impact correction.";
    const localBuild = "local-build-2026.02.03.6";
    const latest: CaseV1 = {
      ...investigation,
      problemStatement: sharedProblem,
      affectedParties: "Newer recorded affected systems.",
      scope: "Newer recorded rollout scope.",
      openQuestions: ["What does the refreshed trace show?"],
      investigationContext: {
        ...investigation.investigationContext!,
        build: "teammate-build-2026.02.03.5",
        environment: "canary",
      },
      situationVersion: investigation.situationVersion + 1,
    };
    const accepted: CaseV1 = {
      ...latest,
      impact: localImpact,
      investigationContext: {
        ...latest.investigationContext!,
        build: localBuild,
      },
      situationVersion: latest.situationVersion + 1,
    };
    let attempt = 0;
    const updateSituation = vi.fn<UpdateSituation>(async () => {
      attempt += 1;
      return attempt === 1
        ? { status: "failed", error: { kind: "conflict", status: 409 } }
        : { status: "succeeded", value: accepted };
    });
    const mounted = mountEditor({ investigation, updateSituation });
    const form = enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: sharedProblem },
    });
    fireEvent.change(screen.getByLabelText("Impact"), {
      target: { value: localImpact },
    });
    fireEvent.change(screen.getByLabelText("Build"), {
      target: { value: localBuild },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/save is blocked/i);
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect(updateSituation).toHaveBeenLastCalledWith({
      problemStatement: sharedProblem,
      impact: localImpact,
      investigationContext: {
        ...investigation.investigationContext!,
        build: localBuild,
      },
    });
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.submit(form);
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/awaiting the latest recorded situation/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /rebase my draft/i })).toBeNull();
    expect((screen.getByLabelText("Impact") as HTMLTextAreaElement).value).toBe(localImpact);

    mounted.rerender({ investigation: latest });
    expect(screen.getByText("Newer recorded affected systems.")).toBeTruthy();
    expect(screen.getByText("Newer recorded rollout scope.")).toBeTruthy();
    expect(screen.getByText("What does the refreshed trace show?")).toBeTruthy();
    expect(screen.getByText("teammate-build-2026.02.03.5")).toBeTruthy();
    expect(screen.getByText("canary")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled)
      .toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /rebase my draft/i }));
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Problem statement") as HTMLTextAreaElement).value)
      .toBe(sharedProblem);
    expect((screen.getByLabelText("Impact") as HTMLTextAreaElement).value).toBe(localImpact);
    expect((screen.getByLabelText("Affected people or systems") as HTMLTextAreaElement).value)
      .toBe("Newer recorded affected systems.");
    expect((screen.getByLabelText("Scope") as HTMLTextAreaElement).value)
      .toBe("Newer recorded rollout scope.");
    expect((screen.getByLabelText("Open questions") as HTMLTextAreaElement).value)
      .toBe("What does the refreshed trace show?");
    expect((screen.getByLabelText("Build") as HTMLInputElement).value).toBe(localBuild);
    expect((screen.getByLabelText("Environment") as HTMLInputElement).value).toBe("canary");
    expect(document.activeElement).toBe(screen.getByLabelText("Problem statement"));
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled)
      .toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(localImpact)).toBeTruthy();
    expect(updateSituation).toHaveBeenCalledTimes(2);
    expect(updateSituation).toHaveBeenLastCalledWith({
      impact: localImpact,
      investigationContext: {
        ...latest.investigationContext!,
        build: localBuild,
      },
    });
  });

  it("guards rebase while a save is pending and unlocks when its original conflict settles", async () => {
    const investigation = makePopulatedCase();
    const latest: CaseV1 = {
      ...investigation,
      scope: "Newer scope published during the pending save.",
      situationVersion: investigation.situationVersion + 1,
    };
    const deferred = createDeferred<CommandOutcome<CaseV1>>();
    const updateSituation = vi.fn<UpdateSituation>(() => deferred.promise);
    const mounted = mountEditor({ investigation, updateSituation });
    enterEditor();
    fireEvent.change(screen.getByLabelText("Impact"), {
      target: { value: "Retained while the original save is pending." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    mounted.rerender({ investigation: latest });
    const rebase = screen.getByRole("button", { name: /rebase my draft/i });
    expect((rebase as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(rebase);
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Scope") as HTMLTextAreaElement).value)
      .toBe(investigation.scope);

    await act(async () => {
      deferred.resolve({ status: "failed", error: { kind: "conflict", status: 409 } });
      await deferred.promise;
    });
    expect(screen.queryByText(/awaiting the latest recorded situation/i)).toBeNull();
    expect((screen.getByRole("button", { name: /rebase my draft/i }) as HTMLButtonElement).disabled)
      .toBe(false);

    mounted.rerender({ mutation: { status: "running" } });
    const runtimeBlockedRebase = screen.getByRole("button", { name: /rebase my draft/i });
    expect((runtimeBlockedRebase as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(runtimeBlockedRebase);
    expect((screen.getByLabelText("Scope") as HTMLTextAreaElement).value)
      .toBe(investigation.scope);
    expect(updateSituation).toHaveBeenCalledTimes(1);

    mounted.rerender({ mutation: IDLE });
    fireEvent.click(screen.getByRole("button", { name: /rebase my draft/i }));
    expect((screen.getByLabelText("Scope") as HTMLTextAreaElement).value).toBe(latest.scope);
    expect((screen.getByLabelText("Impact") as HTMLTextAreaElement).value)
      .toBe("Retained while the original save is pending.");
    expect(document.activeElement).toBe(screen.getByLabelText("Problem statement"));
    expect(updateSituation).toHaveBeenCalledTimes(1);
  });

  it("records only entered context values and does not invent catalog or domain values", async () => {
    const investigation = makeSparseImportedCase();
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "failed",
      error: { kind: "validation", status: 400 },
    }));
    mountEditor({ investigation, updateSituation });
    enterEditor();

    fireEvent.change(screen.getByLabelText("Product or software"), {
      target: { value: "  Fixture Console  " },
    });
    fireEvent.change(screen.getByLabelText("Open questions"), {
      target: { value: "  Which worker held the lease?  \n\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateSituation).toHaveBeenCalledTimes(1));
    expect(updateSituation).toHaveBeenCalledWith({
      openQuestions: ["Which worker held the lease?"],
      investigationContext: {
        productName: "  Fixture Console  ",
        version: "",
        build: "",
        component: "",
        environment: "",
        organization: "",
      },
    });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("submits an explicitly cleared question list as an empty array", async () => {
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "failed",
      error: { kind: "validation", status: 400 },
    }));
    mountEditor({ updateSituation });
    enterEditor();

    fireEvent.change(screen.getByLabelText("Open questions"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateSituation).toHaveBeenCalledTimes(1));
    expect(updateSituation).toHaveBeenCalledWith({ openQuestions: [] });
    expect((screen.getByLabelText("Open questions") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the draft when the controller ignores the command", async () => {
    const updateSituation = vi.fn<UpdateSituation>(async () => ({
      status: "ignored",
      reason: "busy",
    }));
    const onSuccess = vi.fn();
    mountEditor({ updateSituation, onSuccess });
    enterEditor();
    fireEvent.change(screen.getByLabelText("Impact"), {
      target: { value: "Retain this ignored draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("A situation save is already in progress.")).toBeTruthy();
    expect((screen.getByLabelText("Impact") as HTMLTextAreaElement).value)
      .toBe("Retain this ignored draft.");
    expect(screen.getByRole("form", { name: "Edit recorded situation" })).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("suppresses writes while runtime-running and allows only one local in-flight write", async () => {
    const investigation = makePopulatedCase();
    const deferred = createDeferred<CommandOutcome<CaseV1>>();
    const updateSituation = vi.fn<UpdateSituation>(() => deferred.promise);
    const mounted = mountEditor({ investigation, updateSituation });
    const form = enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "One bounded correction." },
    });

    mounted.rerender({ mutation: { status: "running" } });
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled)
      .toBe(true);
    for (const label of [
      "Problem statement",
      "Affected people or systems",
      "Impact",
      "Scope",
      "Open questions",
      "Product or software",
      "Version",
      "Build",
      "Component",
      "Environment",
      "Customer, team, or organization",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement).disabled)
        .toBe(true);
    }
    fireEvent.submit(form);
    expect(updateSituation).not.toHaveBeenCalled();

    mounted.rerender({ mutation: IDLE });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.submit(screen.getByRole("form", { name: "Edit recorded situation" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateSituation).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByLabelText("Problem statement") as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => {
      deferred.resolve({ status: "failed", error: { kind: "network" } });
      await deferred.promise;
    });
    expect(screen.getByRole("alert").textContent).toMatch(/draft is still here/i);
    expect((screen.getByLabelText("Problem statement") as HTMLTextAreaElement).value)
      .toBe("One bounded correction.");
  });

  it("fences pending results and prior draft text immediately on case and identity transitions", async () => {
    const first = makePopulatedCase();
    const second: CaseV1 = {
      ...makeSparseImportedCase(),
      id: "case-second",
      problemStatement: "Second authoritative problem.",
    };
    const deferred = createDeferred<CommandOutcome<CaseV1>>();
    const updateSituation = vi.fn<UpdateSituation>(() => deferred.promise);
    const onSuccess = vi.fn();
    const mounted = mountEditor({ investigation: first, updateSituation, onSuccess });

    enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "PRIVATE FIRST CASE DRAFT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    mounted.rerender({ investigation: second });
    expect(document.body.textContent).not.toContain("PRIVATE FIRST CASE DRAFT");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("Second authoritative problem.")).toBeTruthy();

    await act(async () => {
      deferred.resolve({
        status: "succeeded",
        value: { ...first, problemStatement: "Accepted first-case correction." },
      });
      await deferred.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.queryByText("Accepted first-case correction.")).toBeNull();

    enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "PRIVATE SECOND IDENTITY DRAFT" },
    });
    mounted.rerender({ identityKey: "identity-ravi" });
    expect(document.body.textContent).not.toContain("PRIVATE SECOND IDENTITY DRAFT");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("Second authoritative problem.")).toBeTruthy();
  });

  it("does not let an A to B to A completion replace a newer A save", async () => {
    const first = makePopulatedCase();
    const second: CaseV1 = {
      ...makeSparseImportedCase(),
      id: "case-second",
      problemStatement: "Second authoritative problem.",
    };
    const oldSave = createDeferred<CommandOutcome<CaseV1>>();
    const replacementSave = createDeferred<CommandOutcome<CaseV1>>();
    let callCount = 0;
    const updateSituation = vi.fn<UpdateSituation>(() => {
      callCount += 1;
      return callCount === 1 ? oldSave.promise : replacementSave.promise;
    });
    const onSuccess = vi.fn();
    const mounted = mountEditor({ investigation: first, updateSituation, onSuccess });

    enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "Old A draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    mounted.rerender({ investigation: second });
    mounted.rerender({ investigation: first });
    enterEditor();
    fireEvent.change(screen.getByLabelText("Problem statement"), {
      target: { value: "Replacement A draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(updateSituation).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldSave.resolve({
        status: "succeeded",
        value: {
          ...first,
          problemStatement: "Obsolete A result.",
          situationVersion: first.situationVersion + 1,
        },
      });
      await oldSave.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Problem statement") as HTMLTextAreaElement).value)
      .toBe("Replacement A draft.");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled)
      .toBe(true);

    const replacementResult: CaseV1 = {
      ...first,
      problemStatement: "Authoritative replacement A result.",
      situationVersion: first.situationVersion + 2,
    };
    await act(async () => {
      replacementSave.resolve({ status: "succeeded", value: replacementResult });
      await replacementSave.promise;
    });
    expect(screen.getByText("Authoritative replacement A result.")).toBeTruthy();
    expect(screen.queryByText("Obsolete A result.")).toBeNull();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(replacementResult);
  });

  it("invalidates a pending save on unmount", async () => {
    const investigation = makePopulatedCase();
    const deferred = createDeferred<CommandOutcome<CaseV1>>();
    const updateSituation = vi.fn<UpdateSituation>(() => deferred.promise);
    const onSuccess = vi.fn();
    const mounted = mountEditor({ investigation, updateSituation, onSuccess });
    enterEditor();
    fireEvent.change(screen.getByLabelText("Scope"), {
      target: { value: "Pending during unmount." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    mounted.unmount();
    await act(async () => {
      deferred.resolve({
        status: "succeeded",
        value: {
          ...investigation,
          scope: "Server result after unmount.",
          situationVersion: investigation.situationVersion + 1,
        },
      });
      await deferred.promise;
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("cancels by discarding the draft, invokes the callback, and returns focus", () => {
    const investigation = makePopulatedCase();
    const onCancel = vi.fn();
    mountEditor({ investigation, onCancel });
    enterEditor();
    fireEvent.change(screen.getByLabelText("Affected people or systems"), {
      target: { value: "Discard this local draft." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue("Discard this local draft.")).toBeNull();
    expect(screen.getByText(investigation.affectedParties)).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit situation" }));
  });
});
