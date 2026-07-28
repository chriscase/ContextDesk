import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  CreateInvestigationItemDialog,
  type InvestigationItemDraft,
} from "./CreateInvestigationItemDialog";

function renderDialog(
  type: "finding" | "note",
  onSave = vi.fn<(draft: InvestigationItemDraft) => void>(),
) {
  const triggerRef = createRef<HTMLButtonElement>();
  const onDismiss = vi.fn();
  const view = render(
    <>
      <button ref={triggerRef}>Add…</button>
      <CreateInvestigationItemDialog
        type={type}
        eventCount={2}
        sourceCount={2}
        busy={false}
        triggerRef={triggerRef}
        onSave={onSave}
        onDismiss={onDismiss}
      />
    </>,
  );
  return { ...view, onSave, onDismiss, triggerRef };
}

describe("CreateInvestigationItemDialog", () => {
  it("requires an explicit finding kind and preserves multiline Enter behavior", async () => {
    const { onSave } = renderDialog("finding");
    const dialog = screen.getByRole("dialog", { name: "Create finding" });
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: /Observation/ }),
      ),
    );

    fireEvent.change(within(dialog).getByLabelText("Finding title"), {
      target: { value: "Retry storm follows database timeout" },
    });
    const body = within(dialog).getByLabelText("Why it matters");
    fireEvent.change(body, {
      target: { value: "The retries amplify the original failure." },
    });
    const save = within(dialog).getByRole("button", { name: "Save finding" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(
      within(dialog).getByRole("button", { name: /Inference/ }),
    );
    fireEvent.keyDown(body, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    expect(onSave).toHaveBeenCalledWith({
      type: "finding",
      kind: "inference",
      lifecycle: "accepted",
      title: "Retry storm follows database timeout",
      body: "The retries amplify the original failure.",
    });
  });

  it("protects a dirty cited note from accidental Escape dismissal", async () => {
    const { onDismiss, triggerRef } = renderDialog("note");
    const dialog = screen.getByRole("dialog", { name: "Create cited note" });
    fireEvent.change(within(dialog).getByLabelText("Note title"), {
      target: { value: "Check deployment timing" },
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("investigation-discard-confirmation")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByTestId("investigation-discard-confirmation")).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(triggerRef.current),
    );
  });

  it("edits finding lifecycle without changing its evidence disclosure", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const onSave = vi.fn<(draft: InvestigationItemDraft) => void>();
    render(
      <>
        <button ref={triggerRef}>Edit finding</button>
        <CreateInvestigationItemDialog
          type="finding"
          initialDraft={{
            type: "finding",
            kind: "observation",
            lifecycle: "accepted",
            title: "Database timeout begins",
            body: "The first timeout precedes the retry burst.",
          }}
          eventCount={3}
          sourceCount={2}
          busy={false}
          triggerRef={triggerRef}
          onSave={onSave}
          onDismiss={() => undefined}
        />
      </>,
    );

    const dialog = screen.getByRole("dialog", { name: "Edit finding" });
    expect(dialog.textContent).toContain("3 exact event identities");
    fireEvent.change(within(dialog).getByLabelText("Finding status"), {
      target: { value: "resolved" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      type: "finding",
      kind: "observation",
      lifecycle: "resolved",
      title: "Database timeout begins",
      body: "The first timeout precedes the retry burst.",
    });
  });
});
