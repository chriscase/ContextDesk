/**
 * Cross-surface signal for "this corpus's event revision changed" (#875).
 *
 * `ExplorerTimeResolutionDialog` already refreshes a Log Explorer that
 * applies or undoes a timezone review from *inside itself* (#819). But a
 * timezone review can also happen from the reviewed-import summary
 * (`TimeReviewCard`, outside any Explorer) or from the Logs pane's own
 * `LogTimezoneStatus` — and by then an Explorer may already be open,
 * in-app or in its own OS window. Neither prop threading nor a shared
 * store reaches a separate Tauri webview, so this mirrors the established
 * `themeBridge` pattern: a same-window `CustomEvent` for in-app listeners
 * plus a Tauri cross-webview `emit`/`listen` for a standalone Explorer
 * window. Broadcasting is read-only signalling — it must never itself
 * trigger a corpus import, apply, or reprocessing.
 */
export const TIME_REVISION_CHANGED_EVENT =
  "contextdesk:corpus-time-revision-changed";

type RevisionPayload = { corpusId?: unknown };
type RevisionListen = (
  eventName: string,
  handler: (event: { payload: RevisionPayload }) => void,
) => Promise<() => void>;
type RevisionEmit = (
  eventName: string,
  payload: { corpusId: string },
) => Promise<void>;

/** Broadcast that `corpusId`'s event revision changed to every open surface. */
export async function broadcastTimeRevisionChanged(
  corpusId: string,
  injectedEmit?: RevisionEmit,
): Promise<void> {
  window.dispatchEvent(
    new CustomEvent<RevisionPayload>(TIME_REVISION_CHANGED_EVENT, {
      detail: { corpusId },
    }),
  );
  try {
    const send =
      injectedEmit ??
      ((await import("@tauri-apps/api/event"))
        .emit as unknown as RevisionEmit);
    await send(TIME_REVISION_CHANGED_EVENT, { corpusId });
  } catch {
    // Browser preview and tests have no Tauri event bus.
  }
}

/** Subscribe to same-window and cross-webview revision-changed signals. */
export function subscribeTimeRevisionChanged(
  onChanged: (corpusId: string) => void,
  injectedListen?: RevisionListen,
): () => void {
  let disposed = false;
  let stopTauri: (() => void) | null = null;
  const accept = (value: unknown) => {
    if (!disposed && typeof value === "string" && value.length > 0) {
      onChanged(value);
    }
  };
  const onCustom = (event: Event) => {
    accept((event as CustomEvent<RevisionPayload>).detail?.corpusId);
  };

  window.addEventListener(TIME_REVISION_CHANGED_EVENT, onCustom);
  void (async () => {
    const listen =
      injectedListen ??
      ((await import("@tauri-apps/api/event"))
        .listen as unknown as RevisionListen);
    const stop = await listen(TIME_REVISION_CHANGED_EVENT, (event) =>
      accept(event.payload?.corpusId),
    );
    if (disposed) stop();
    else stopTauri = stop;
  })().catch(() => {
    // Browser preview and tests have no Tauri event bus.
  });

  return () => {
    disposed = true;
    window.removeEventListener(TIME_REVISION_CHANGED_EVENT, onCustom);
    stopTauri?.();
  };
}
