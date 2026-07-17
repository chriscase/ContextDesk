/** Async dialogs via Tauri plugin (WKWebView-safe). Never use blocking browser dialogs. */

export async function dialogConfirm(
  message: string,
  opts?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<boolean> {
  try {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return await confirm(message, {
      title: opts?.title ?? "Confirm",
      kind: opts?.kind ?? "warning",
      okLabel: "OK",
      cancelLabel: "Cancel",
    });
  } catch {
    // Browser / non-Tauri: refuse destructive action rather than a sync browser dialog
    // (those do not block under WKWebView and falsely appear to confirm).
    console.warn("[dialogs] confirm unavailable outside Tauri:", message);
    return false;
  }
}

export async function dialogMessage(
  message: string,
  opts?: { title?: string; kind?: "info" | "warning" | "error" },
): Promise<void> {
  try {
    const { message: show } = await import("@tauri-apps/plugin-dialog");
    await show(message, {
      title: opts?.title ?? "ContextDesk",
      kind: opts?.kind ?? "info",
    });
  } catch {
    console.warn("[dialogs] message:", opts?.title ?? "", message);
  }
}
