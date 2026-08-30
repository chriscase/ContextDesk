import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LifecyclePanel,
  type LifecyclePanelProps,
  type LifecycleView,
} from "./LifecyclePanel.js";
import {
  type CommandOutcome,
  type InvestigationLifecycleActionSuccessV1,
  type LifecycleAction,
  type MutationState,
  type ResourceState,
} from "./investigations/runtime/public.js";
import { makePopulatedCase } from "./investigations/runtime/testkit/fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CASE_ID = "case-1";
const DELETION = {
  supported: false as const,
  detail: "Investigations are archived, never deleted: the record, its evidence, and its audit trail stay intact.",
  alternatives: ["archive"] as const,
};

function lifecycle(overrides: Partial<LifecycleView> = {}): LifecycleView {
  return {
    schemaId: "cd-collab.investigation_lifecycle.v1",
    investigationId: CASE_ID,
    status: "monitoring",
    legalHold: false,
    archive: { allowed: true, action: "archive", targetStatus: "archived" },
    restore: {
      allowed: false,
      action: "restore",
      reason: "not_archived",
      detail: "This investigation is not archived, so there is nothing to restore.",
    },
    restoreTarget: "monitoring",
    deletion: DELETION,
    ...overrides,
  };
}

function success(
  action: LifecycleAction,
): CommandOutcome<InvestigationLifecycleActionSuccessV1> {
  const appliedStatus = action === "archive" ? "archived" : "monitoring";
  return {
    status: "succeeded",
    value: {
      schemaId: "cd-collab.investigation_lifecycle_action_success.v1",
      investigationId: CASE_ID,
      action,
      previousStatus: action === "archive" ? "monitoring" : "archived",
      appliedStatus,
      case: { ...makePopulatedCase(), id: CASE_ID, status: appliedStatus },
    },
  };
}

function ready(value = lifecycle()): ResourceState<LifecycleView> {
  return { status: "ready", value };
}

function renderPanel(options: Partial<LifecyclePanelProps> = {}) {
  const applyAction = options.applyAction
    ?? vi.fn(async (action: LifecycleAction) => success(action));
  const retryLifecycle = options.retryLifecycle ?? vi.fn();
  const onChanged = options.onChanged ?? vi.fn();
  const props: LifecyclePanelProps = {
    lifecycle: ready(),
    lifecycleMutation: { status: "idle" },
    canManage: true,
    readOnly: false,
    applyAction,
    retryLifecycle,
    onChanged,
    ...options,
  };
  const result = render(<LifecyclePanel {...props} />);
  return { ...result, applyAction, retryLifecycle, onChanged };
}

describe("archiving is a deliberate, runtime-authorized act", () => {
  it("explains archive and requires a second click before emitting intent", async () => {
    const { applyAction } = renderPanel();
    expect(screen.getByText(/Nothing is deleted/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));

    expect(screen.getByText(/Archive this investigation\?/i)).toBeTruthy();
    expect(applyAction).not.toHaveBeenCalled();
  });

  it("emits only the archive action after confirmation", async () => {
    const applyAction = vi.fn(async (action: LifecycleAction) => success(action));
    renderPanel({ applyAction });

    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive it" }));

    await waitFor(() => expect(applyAction).toHaveBeenCalledWith("archive"));
    expect(applyAction).toHaveBeenCalledTimes(1);
  });

  it("cancels without emitting an action", () => {
    const { applyAction } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Archive investigation" })).toBeTruthy();
    expect(applyAction).not.toHaveBeenCalled();
  });

  it("calls onChanged only after a successful action", async () => {
    const onChanged = vi.fn();
    renderPanel({ onChanged });
    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive it" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("does not call onChanged after a bounded failure", async () => {
    const onChanged = vi.fn();
    const applyAction = vi.fn(async (): Promise<
      CommandOutcome<InvestigationLifecycleActionSuccessV1>
    > => ({ status: "failed", error: { kind: "network" } }));
    renderPanel({ applyAction, onChanged });
    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive it" }));

    await waitFor(() => expect(applyAction).toHaveBeenCalledTimes(1));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("parsed lifecycle state controls availability", () => {
  it("shows a legal-hold refusal before the click and disables archive", () => {
    renderPanel({
      lifecycle: ready(lifecycle({
        legalHold: true,
        archive: {
          allowed: false,
          action: "archive",
          reason: "legal_hold",
          detail: "This investigation is under legal hold, so it stays in the working list.",
        },
      })),
    });

    expect(screen.getByText(/under legal hold/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Archive investigation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("names the recorded restore destination and emits only restore", async () => {
    const applyAction = vi.fn(async (action: LifecycleAction) => success(action));
    renderPanel({
      applyAction,
      lifecycle: ready(lifecycle({
        status: "archived",
        archive: {
          allowed: false,
          action: "archive",
          reason: "already_archived",
          detail: "This investigation is already archived.",
        },
        restore: { allowed: true, action: "restore", targetStatus: "resolved" },
        restoreTarget: "resolved",
      })),
    });

    expect(screen.getByText(/back in the working list as resolved/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, restore to resolved" }));
    await waitFor(() => expect(applyAction).toHaveBeenCalledWith("restore"));
  });

  it("uses the parsed deletion explanation without offering delete", () => {
    renderPanel();
    expect(screen.getByText(/Can an investigation be deleted\?/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});

describe("read state fails closed and stays honest", () => {
  it("announces loading and keeps the action disabled even with a prior preview", () => {
    const { applyAction } = renderPanel({
      lifecycle: { status: "loading", previous: lifecycle() },
    });

    expect(screen.getByRole("status").textContent).toMatch(/Checking the current/i);
    const button = screen.getByRole("button", { name: "Archive investigation" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(applyAction).not.toHaveBeenCalled();
  });

  it("announces an unavailable read, keeps action disabled, and offers retry", () => {
    const retryLifecycle = vi.fn();
    const { applyAction } = renderPanel({
      lifecycle: { status: "failed", error: { kind: "network" } },
      retryLifecycle,
    });

    expect(screen.getByRole("alert").textContent).toMatch(/could not be loaded/i);
    const button = screen.getByRole("button", { name: "Archive investigation" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry lifecycle details" }));
    expect(retryLifecycle).toHaveBeenCalledTimes(1);
    expect(applyAction).not.toHaveBeenCalled();
  });

  it("does not turn idle state into an optimistic action", () => {
    renderPanel({ lifecycle: { status: "idle" } });
    expect(screen.getByRole("status").textContent).toMatch(/not ready/i);
    expect(
      (screen.getByRole("button", { name: "Archive investigation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("bounded mutation results", () => {
  function failed(
    error: Extract<
      CommandOutcome<InvestigationLifecycleActionSuccessV1>,
      { status: "failed" }
    >["error"],
  ): MutationState<InvestigationLifecycleActionSuccessV1> {
    return { status: "failed", error };
  }

  it("shows a parsed lifecycle refusal as written", () => {
    renderPanel({
      lifecycleMutation: failed({
        kind: "lifecycle_refused",
        status: 409,
        action: "archive",
        reason: "legal_hold",
        detail: "This investigation is under legal hold, so it stays in the working list.",
      }),
    });

    expect(screen.getByRole("alert").textContent).toMatch(/under legal hold/i);
  });

  it("explains changed state without leaking transport detail", () => {
    renderPanel({
      lifecycleMutation: failed({
        kind: "lifecycle_changed",
        status: 409,
        investigationId: CASE_ID,
        action: "archive",
        current: lifecycle(),
      }),
    });

    expect(screen.getByRole("alert").textContent).toMatch(/changed before this action/i);
    expect(screen.getByRole("alert").textContent).toMatch(/Review the latest lifecycle state/i);
  });

  it("uses safe local copy for every other bounded failure", () => {
    renderPanel({ lifecycleMutation: failed({ kind: "network" }) });
    expect(screen.getByRole("alert").textContent).toBe(
      "The lifecycle action could not be completed. Review the current investigation state before trying again.",
    );
  });
});

describe("authority remains outside the panel", () => {
  it("offers nothing to a reader who cannot manage lifecycle", () => {
    renderPanel({ canManage: false, applyAction: null });
    expect(screen.getByText(/Only a case lead can archive or restore/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /investigation/i })).toBeNull();
  });

  it("names a static snapshot instead of misreporting the reader's role", () => {
    renderPanel({ canManage: true, readOnly: true, applyAction: null });
    expect(
      screen.getByText("Static read-only view: archiving and restoring are unavailable."),
    ).toBeTruthy();
    expect(screen.queryByText(/Only a case lead/i)).toBeNull();
  });

  it("keeps action disabled when no authorized runtime command is bound", () => {
    renderPanel({ applyAction: null });
    expect(
      (screen.getByRole("button", { name: "Archive investigation" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
