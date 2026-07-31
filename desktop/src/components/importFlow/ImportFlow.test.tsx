import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMockEngineClient } from "@contextdesk/client";
import { ImportFlow } from "./ImportFlow";

const dialogMocks = vi.hoisted(() => ({
  openDirectoryDialog: vi.fn(async () => "/incidents/checkout-outage"),
  openFileDialog: vi.fn(async () => null),
}));
vi.mock("../../lib/dialogs", () => dialogMocks);

async function toPreflight(client = createMockEngineClient()) {
  const onPublished = vi.fn();
  const utils = render(<ImportFlow engine={client} variant="pane" onPublished={onPublished} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
  await screen.findByRole("region", { name: "Ready to import" });
  return { client, onPublished, ...utils };
}

describe("ImportFlow ordinary path", () => {
  it("is two deliberate actions: choose input, then Import", async () => {
    const { onPublished } = await toPreflight();
    expect(
      screen.getByText(/Ready to import — 3 sources/),
    ).toBeTruthy();
    // Import stays disabled until SoftWrite confirmation, with the reason inline.
    const importButton = screen.getByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Tick the SoftWrite confirmation to enable Import."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    expect((importButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(importButton);
    await screen.findByRole("region", { name: "Import finished" });
    expect(onPublished).toHaveBeenCalledWith("mock-corpus-0001");
    // Atomic-publication honesty on the summary.
    expect(screen.getByText(/Import finished — corpus mock-corpus-0001/)).toBeTruthy();
  });

  it("keeps the selector out of the ordinary path but one action away", async () => {
    await toPreflight();
    expect(screen.queryByRole("treegrid")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review selection…" }));
    expect(screen.getByRole("treegrid", { name: "Discovered items" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("region", { name: "Ready to import" });
  });
});

describe("ImportFlow zero-importable guard", () => {
  it("disables Import with an inline reason when everything is deselected", async () => {
    await toPreflight();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review selection…" }));
    const grid = screen.getByRole("treegrid", { name: "Discovered items" });
    // Deselect every selected leaf via its checkbox.
    for (const checkbox of within(grid).getAllByRole("checkbox")) {
      if ((checkbox as HTMLInputElement).checked && !(checkbox as HTMLInputElement).disabled) {
        fireEvent.click(checkbox);
      }
    }
    expect(
      screen.getAllByText(
        "Nothing selected would import as log events. Select at least one log source.",
      ).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const importButton = await screen.findByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ImportFlow failure, cancel, and retry", () => {
  it("failure leaves the library unchanged and offers retry back to review", async () => {
    const client = createMockEngineClient({ failNextRun: "disk full while staging" });
    await toPreflight(client);
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/Import failed: disk full while staging/)).toBeTruthy();
    expect(screen.getByText(/Nothing was published/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    await screen.findByRole("region", { name: "Ready to import" });
    // Retry succeeds; the SoftWrite confirmation persists across retry.
    const retryCheckbox = screen.getByRole("checkbox", {
      name: /I understand and want to proceed/,
    }) as HTMLInputElement;
    expect(retryCheckbox.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("region", { name: "Import finished" });
  });

  it("cancellation reports honestly and never claims publication", async () => {
    const client = createMockEngineClient({ manualFlush: true });
    render(<ImportFlow engine={client} variant="pane" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    // Preview parks behind manualFlush; release it once it is parked.
    await screen.findByText(/Looking at what/);
    await waitFor(() => {
      client.flush();
    });
    await screen.findByRole("region", { name: "Ready to import" });
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("button", { name: "Cancel ingest" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel ingest" }));
    await screen.findByText(/Import cancelled\. Nothing was published/);
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    await screen.findByRole("region", { name: "Ready to import" });
  });
});

describe("ImportFlow timezone tail", () => {
  it("shows the corpus-wide time card only when sources are unresolved", async () => {
    await toPreflight();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand and want to proceed/ }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("region", { name: "Import finished" });
    expect(screen.getByText("Place local timestamps")).toBeTruthy();
    expect(
      screen.getByText(/ContextDesk did not guess a timezone\./),
    ).toBeTruthy();
    // Dismissal never blocks: the summary stays.
    fireEvent.click(
      screen.getByRole("button", { name: "Decide later — keep order-only" }),
    );
    expect(screen.queryByText("Place local timestamps")).toBeNull();
    expect(screen.getByRole("region", { name: "Import finished" })).toBeTruthy();
  });
});
