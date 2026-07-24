import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  useKeyboardShortcuts,
  type KeyboardShortcutHandlers,
} from "./useKeyboardShortcuts";

function ShortcutHarness({
  onOpenHelp,
  modalOpen,
}: Pick<KeyboardShortcutHandlers, "onOpenHelp" | "modalOpen">) {
  useKeyboardShortcuts({
    onNewChat: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenHelp,
    onOpenSettings: vi.fn(),
    onPrevSession: vi.fn(),
    onNextSession: vi.fn(),
    onSessionByIndex: vi.fn(),
    onRenameActive: vi.fn(),
    onEscape: vi.fn(),
    paletteOpen: false,
    settingsOpen: false,
    permissionOpen: false,
    modalOpen,
  });
  return null;
}

describe("Help keyboard discovery (#440)", () => {
  it("opens Help with the primary Shift+/ shortcut outside modals", () => {
    const onOpenHelp = vi.fn();
    const { rerender } = render(
      <ShortcutHarness onOpenHelp={onOpenHelp} modalOpen={false} />,
    );

    fireEvent.keyDown(window, {
      key: "?",
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    expect(onOpenHelp).toHaveBeenCalledTimes(1);

    rerender(<ShortcutHarness onOpenHelp={onOpenHelp} modalOpen />);
    fireEvent.keyDown(window, {
      key: "?",
      ctrlKey: true,
      metaKey: true,
      shiftKey: true,
    });
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });
});
