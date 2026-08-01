/**
 * Guided close-acknowledgement contract (#751 blocker 3).
 *
 * Cancel/Escape during a live run must never tear the wizard down: the flow
 * requests engine cancellation, stays truthfully visible, and only closes
 * after the engine acknowledges cancellation or completion. During the
 * deliberately non-cancellable publish window the wizard says so and stays
 * until publication completes.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMockEngineClient } from "@contextdesk/client";
import { GuidedImportWizard } from "./GuidedImportWizard";

const dialogMocks = vi.hoisted(() => ({
  openDirectoryDialog: vi.fn(async () => "/incidents/checkout-outage"),
  openFileDialog: vi.fn(async () => null),
}));
vi.mock("../../lib/dialogs", () => dialogMocks);

async function driveToRunning(client: ReturnType<typeof createMockEngineClient>) {
  const onCancel = vi.fn();
  const onComplete = vi.fn();
  render(
    <GuidedImportWizard
      engine={client}
      onCancel={onCancel}
      onComplete={onComplete}
      helpAvailable
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  await waitFor(() => {
    client.flush();
    expect(screen.queryByRole("region", { name: "Ready to import" })).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByRole("button", { name: "Cancel ingest" });
  return { onCancel, onComplete };
}

async function driveToPreviewing() {
  const plan = await createMockEngineClient().import.preview("/fixture");
  const client = createMockEngineClient();
  let acknowledge!: () => void;
  vi.spyOn(client.import, "preview").mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = () => resolve(plan);
      }),
  );
  const cancel = vi.spyOn(client.import, "cancel").mockResolvedValue(true);
  const onCancel = vi.fn();
  render(
    <GuidedImportWizard
      engine={client}
      onCancel={onCancel}
      onComplete={vi.fn()}
      helpAvailable
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  await screen.findByText(/Looking at what/);
  return { cancel, onCancel, acknowledge: () => acknowledge() };
}

describe("GuidedImportWizard close acknowledgement", () => {
  it("Cancel during preview waits for preview cancellation acknowledgement", async () => {
    const { cancel, onCancel, acknowledge } = await driveToPreviewing();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelling preview — waiting for the engine to acknowledge…");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();

    acknowledge();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("Escape during preview follows the same acknowledged close path", async () => {
    const { cancel, onCancel, acknowledge } = await driveToPreviewing();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await screen.findByText("Cancelling preview — waiting for the engine to acknowledge…");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    acknowledge();
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  it("Cancel during a run keeps the wizard visible until cancellation is acknowledged", async () => {
    const client = createMockEngineClient({ manualFlush: true });
    const { onCancel } = await driveToRunning(client);

    // The shell's Cancel requests a close; the wizard must NOT disappear.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Cancelling — waiting for the engine to acknowledge…"),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Releasing the engine acknowledges the cancellation; only now closes.
    await waitFor(() => {
      client.flush();
    });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it("Escape during a run follows the same acknowledged path, never a silent close", async () => {
    const client = createMockEngineClient({ manualFlush: true });
    const { onCancel } = await driveToRunning(client);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Cancelling — waiting for the engine to acknowledge…"),
    ).toBeTruthy();
    await waitFor(() => {
      client.flush();
    });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it("closing during the non-cancellable publish window says so and stays until completion", async () => {
    const client = createMockEngineClient({ parkBeforeCompletion: true });
    const { onCancel } = await driveToRunning(client);

    // The run is parked inside the publish window (cancellable: false).
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "Publication is in progress and cannot be cancelled. This stays visible until it completes.",
      ),
    ).toBeTruthy();

    // Publication completes; the run publishes and the requested exit is
    // acknowledged through the summary.
    await waitFor(() => {
      client.flush();
    });
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  it("Cancel outside a run closes immediately — no ceremony when nothing is live", async () => {
    const client = createMockEngineClient();
    const onCancel = vi.fn();
    render(
      <GuidedImportWizard
        engine={client}
        onCancel={onCancel}
        onComplete={vi.fn()}
        helpAvailable
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
