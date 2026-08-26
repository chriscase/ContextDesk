import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecyclePanel, type LifecycleView } from "./LifecyclePanel.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DELETION = {
  supported: false as const,
  detail: "Investigations are archived, never deleted: the record, its evidence, and its audit trail stay intact.",
};

function view(overrides: Partial<LifecycleView> = {}): LifecycleView {
  return {
    status: "monitoring",
    legalHold: false,
    archive: { allowed: true, action: "archive", targetStatus: "archived" },
    restore: { allowed: false, action: "restore", reason: "not_archived" },
    restoreTarget: "monitoring",
    deletion: DELETION,
    ...overrides,
  };
}

function renderPanel(
  lifecycle: LifecycleView,
  options: { canLead?: boolean; onChanged?: () => void } = {},
) {
  const onChanged = options.onChanged ?? vi.fn();
  render(
    <LifecyclePanel
      caseId="case-1"
      status={lifecycle.status}
      canLead={options.canLead ?? true}
      onChanged={onChanged}
      loadLifecycle={() => Promise.resolve(lifecycle)}
    />,
  );
  return { onChanged };
}

describe("archiving is a deliberate, explained act", () => {
  it("says what archiving does before offering it", async () => {
    renderPanel(view());
    expect(await screen.findByText(/Nothing is deleted/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive investigation" })).toBeTruthy();
  });

  it("requires a second explicit confirmation before it posts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderPanel(view());
    fireEvent.click(await screen.findByRole("button", { name: "Archive investigation" }));
    expect(screen.getByText(/Archive this investigation\?/i)).toBeTruthy();
    // The first click only asks. Nothing has been written yet.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("abandons the archive when the operator cancels", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderPanel(view());
    fireEvent.click(await screen.findByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Archive investigation" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the archived status once confirmed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { onChanged } = renderPanel(view());
    fireEvent.click(await screen.findByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive it" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cases/case-1/status");
    expect(JSON.parse(String(init.body))).toEqual({ status: "archived" });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe("a legal hold refuses the archive before the click", () => {
  it("disables the control and states the reason", async () => {
    renderPanel(
      view({
        legalHold: true,
        archive: {
          allowed: false,
          action: "archive",
          reason: "legal_hold",
          detail: "This investigation is under legal hold, so it stays in the working list.",
        },
      }),
    );
    expect(await screen.findByText(/under legal hold/i)).toBeTruthy();
    const button = await screen.findByRole("button", { name: "Archive investigation" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a server refusal as written rather than as a generic failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "lifecycle_refused",
          reason: "legal_hold",
          detail: "This investigation is under legal hold, so it stays in the working list.",
        }),
        { status: 409 },
      ),
    );
    renderPanel(view());
    fireEvent.click(await screen.findByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, archive it" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/under legal hold/i);
    expect(alert.textContent).not.toMatch(/permission/i);
  });
});

describe("restore names where it lands", () => {
  it("offers a restore to the recorded prior status, not a generic open", async () => {
    renderPanel(
      view({
        status: "archived",
        archive: { allowed: false, action: "archive", reason: "already_archived" },
        restore: { allowed: true, action: "restore", targetStatus: "monitoring" },
        restoreTarget: "monitoring",
      }),
    );
    expect(await screen.findByText(/back in the working list as monitoring/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore investigation" }));
    expect(screen.getByRole("button", { name: "Yes, restore to monitoring" })).toBeTruthy();
  });

  it("posts the recorded prior status rather than open", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    renderPanel(
      view({
        status: "archived",
        restore: { allowed: true, action: "restore", targetStatus: "resolved" },
        restoreTarget: "resolved",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Restore investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, restore to resolved" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ status: "resolved" });
  });

  it("never disables restore for a legal hold", async () => {
    renderPanel(
      view({
        status: "archived",
        legalHold: true,
        restore: { allowed: true, action: "restore", targetStatus: "open" },
        restoreTarget: "open",
      }),
    );
    const button = await screen.findByRole("button", { name: "Restore investigation" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("what the panel refuses to imply", () => {
  it("answers the deletion question instead of offering a delete control", async () => {
    renderPanel(view());
    expect(await screen.findByText(/Can an investigation be deleted\?/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });

  it("offers nothing to a reader who cannot lead the case", async () => {
    renderPanel(view(), { canLead: false });
    expect(
      await screen.findByText(/Only a case lead can archive or restore/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
  });

  it("still offers the archive when the lifecycle read is unavailable", async () => {
    // An installation that has not deployed the lifecycle route yet must not
    // lose the control; the server stays the authority on the refusal.
    render(
      <LifecyclePanel
        caseId="case-1"
        status="open"
        canLead
        onChanged={vi.fn()}
        loadLifecycle={() => Promise.resolve(null)}
      />,
    );
    const button = await screen.findByRole("button", { name: "Archive investigation" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
