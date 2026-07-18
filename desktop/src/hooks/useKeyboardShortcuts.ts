/**
 * Global keyboard shortcut layer (#154).
 * Allowlisted mod combos fire even in inputs; plain keys never hijack typing.
 */
import { useEffect } from "react";
import { hasPrimaryMod, isEditableTarget } from "../lib/commandPalette";

export type KeyboardShortcutHandlers = {
  onNewChat: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onPrevSession: () => void;
  onNextSession: () => void;
  onSessionByIndex: (index0: number) => void;
  onRenameActive: () => void;
  /** Escape when palette open — close it. Permission deny is owned by PermissionModal (capture). */
  onEscape: () => void;
  paletteOpen: boolean;
  settingsOpen: boolean;
  /** When true, F2 / session keys still work; Escape left to PermissionModal. */
  permissionOpen: boolean;
};

export function useKeyboardShortcuts(h: KeyboardShortcutHandlers) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const editable = isEditableTarget(e.target);
      const primary = hasPrimaryMod(e);

      // Palette Escape first (before settings local handlers may also listen).
      if (e.key === "Escape" && h.paletteOpen) {
        e.preventDefault();
        h.onEscape();
        return;
      }

      // Permission modal owns Escape deny via capture listener (#149/#154).
      if (h.permissionOpen && e.key === "Escape") {
        return;
      }

      // Cmd/Ctrl+K palette — allowlisted in inputs
      if (primary && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        h.onOpenPalette();
        return;
      }

      // Cmd/Ctrl+N new chat
      if (primary && !e.shiftKey && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        h.onNewChat();
        return;
      }

      // Cmd/Ctrl+, settings
      if (primary && e.key === ",") {
        e.preventDefault();
        h.onOpenSettings();
        return;
      }

      // Cmd/Ctrl+[ ] session switch — allowlisted
      if (primary && e.key === "[") {
        e.preventDefault();
        h.onPrevSession();
        return;
      }
      if (primary && e.key === "]") {
        e.preventDefault();
        h.onNextSession();
        return;
      }

      // Cmd/Ctrl+1-9 jump session
      if (primary && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        h.onSessionByIndex(Number(e.key) - 1);
        return;
      }

      // F2 rename — not while typing plain text (editable)
      if (e.key === "F2" && !editable) {
        e.preventDefault();
        h.onRenameActive();
        return;
      }

      // When palette is open, leave arrow/enter to the palette component.
      if (h.paletteOpen || h.settingsOpen) return;

      // No other plain-key global shortcuts (do not steal Composer typing).
      void editable;
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h]);
}
