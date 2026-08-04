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

type RevisionPayload = { corpusId?: unknown; eventId?: unknown };
type RevisionListen = (
  eventName: string,
  handler: (event: { payload: RevisionPayload }) => void,
) => Promise<() => void>;
type RevisionEmit = (
  eventName: string,
  payload: { corpusId: string; eventId: string },
) => Promise<void>;

const MAX_SEEN_EVENT_IDS = 128;
const MAX_EVENT_ID_LENGTH = 128;
const senderId = globalThis.crypto.randomUUID();
let nextEventSequence = 0;

function createEventId(): string {
  nextEventSequence += 1;
  return `${senderId}:${nextEventSequence}`;
}

/** Broadcast that `corpusId`'s event revision changed to every open surface. */
export async function broadcastTimeRevisionChanged(
  corpusId: string,
  injectedEmit?: RevisionEmit,
): Promise<void> {
  const payload = { corpusId, eventId: createEventId() };
  window.dispatchEvent(
    new CustomEvent<RevisionPayload>(TIME_REVISION_CHANGED_EVENT, {
      detail: payload,
    }),
  );
  try {
    const send =
      injectedEmit ??
      ((await import("@tauri-apps/api/event"))
        .emit as unknown as RevisionEmit);
    await send(TIME_REVISION_CHANGED_EVENT, payload);
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
  const seenEventIds = new Set<string>();
  const seenEventOrder: string[] = [];
  const accept = (payload: RevisionPayload | undefined) => {
    if (disposed || typeof payload?.corpusId !== "string") return;
    if (payload.corpusId.length === 0) return;

    // A Tauri emit is delivered to the originating webview too. The same
    // logical signal therefore arrives first as a CustomEvent and then as a
    // Tauri event. Keep a small FIFO of event ids so each subscriber invokes
    // its callback once without retaining unbounded history. Older senders
    // without an event id remain compatible and are accepted once per input.
    if (payload.eventId != null) {
      if (
        typeof payload.eventId !== "string" ||
        payload.eventId.length === 0 ||
        payload.eventId.length > MAX_EVENT_ID_LENGTH
      ) {
        return;
      }
      if (seenEventIds.has(payload.eventId)) return;
      seenEventIds.add(payload.eventId);
      seenEventOrder.push(payload.eventId);
      if (seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
        const expired = seenEventOrder.shift();
        if (expired !== undefined) seenEventIds.delete(expired);
      }
    }
    onChanged(payload.corpusId);
  };
  const onCustom = (event: Event) => {
    accept((event as CustomEvent<RevisionPayload>).detail);
  };

  window.addEventListener(TIME_REVISION_CHANGED_EVENT, onCustom);
  void (async () => {
    const listen =
      injectedListen ??
      ((await import("@tauri-apps/api/event"))
        .listen as unknown as RevisionListen);
    const stop = await listen(TIME_REVISION_CHANGED_EVENT, (event) =>
      accept(event.payload),
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
