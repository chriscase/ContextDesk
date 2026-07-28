import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { InvestigationAddMenu } from "./InvestigationAddMenu";

function renderMenu() {
  const triggerRef = createRef<HTMLButtonElement>();
  const onChoose = vi.fn<(type: "finding" | "note") => void>();
  const onDismiss = vi.fn();
  render(
    <div>
      <button ref={triggerRef}>Add…</button>
      <InvestigationAddMenu
        triggerRef={triggerRef}
        onChoose={onChoose}
        onDismiss={onDismiss}
      />
      <button>Outside</button>
    </div>,
  );
  return { triggerRef, onChoose, onDismiss };
}

describe("InvestigationAddMenu", () => {
  it("opens below the selection strip with both actions keyboard reachable", async () => {
    const { onChoose } = renderMenu();
    const menu = screen.getByRole("menu", {
      name: "Add selected events to Investigation",
    });
    expect(menu.getAttribute("data-placement")).toBe("below");

    const finding = screen.getByRole("menuitem", {
      name: /Create finding/,
    });
    const note = screen.getByRole("menuitem", {
      name: /Create cited note/,
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(finding));

    fireEvent.click(note);
    expect(onChoose).toHaveBeenCalledWith("note");
  });

  it("dismisses on Escape and outside click, restoring focus to Add", async () => {
    const { triggerRef, onDismiss } = renderMenu();
    const finding = screen.getByRole("menuitem", {
      name: /Create finding/,
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(finding));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(triggerRef.current),
    );

    finding.focus();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(triggerRef.current),
    );
  });
});
