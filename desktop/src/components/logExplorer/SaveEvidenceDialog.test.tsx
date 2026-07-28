import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SaveEvidenceDialog } from "./SaveEvidenceDialog";

function Harness({
  onSave,
  onDismiss,
}: {
  onSave: (title: string) => void;
  onDismiss: () => void;
}) {
  const triggerRef = createRef<HTMLButtonElement>();
  return (
    <>
      <button ref={triggerRef} type="button">
        Save evidence trigger
      </button>
      <SaveEvidenceDialog
        eventCount={2}
        sourceCount={2}
        defaultTitle="Selected evidence"
        busy={false}
        triggerRef={triggerRef}
        onSave={onSave}
        onDismiss={onDismiss}
      />
    </>
  );
}

describe("SaveEvidenceDialog", () => {
  it("describes payload-free persistence and submits a trimmed title", async () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} onDismiss={() => undefined} />);

    expect(screen.getByRole("dialog").textContent).toContain(
      "2 exact event identities across 2 sources",
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      "not copied into the Investigation file",
    );
    const input = screen.getByLabelText("Evidence title");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "  Retry storm  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save evidence" }));
    expect(onSave).toHaveBeenCalledWith("Retry storm");
  });

  it("dismisses with Escape and restores focus to the invoking control", async () => {
    const onDismiss = vi.fn();
    render(<Harness onSave={() => undefined} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByLabelText("Evidence title"), {
      key: "Escape",
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Save evidence trigger"),
    );
  });

  it("dismisses on the backdrop but not inside the dialog", () => {
    const onDismiss = vi.fn();
    render(<Harness onSave={() => undefined} onDismiss={onDismiss} />);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByTestId("save-evidence-backdrop"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps keyboard focus inside the modal dialog", async () => {
    render(<Harness onSave={() => undefined} onDismiss={() => undefined} />);
    const input = screen.getByLabelText("Evidence title");
    await waitFor(() => expect(document.activeElement).toBe(input));
    const save = screen.getByRole("button", { name: "Save evidence" });
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
  });
});
