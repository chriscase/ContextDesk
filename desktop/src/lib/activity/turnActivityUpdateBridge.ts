const EVENT = "contextdesk:turn-activity-updated";

export type TurnActivityUpdate = {
  sessionId: string;
  /**
   * The session was retired (trashed/deleted/forgotten). A subscriber must
   * evict any cached record for this session rather than refetch — the
   * host has already forgotten it, so a refetch would just observe the
   * eviction as a null and (depending on merge logic) could still leave a
   * stale cached record in place.
   */
  retired?: boolean;
};

type Payload = TurnActivityUpdate & { eventId?: unknown };
type BridgeListen = (
  eventName: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;
type BridgeEmit = (eventName: string, payload: unknown) => Promise<void>;

const MAX_SEEN_EVENT_IDS = 128;
const MAX_EVENT_ID_LENGTH = 128;
const senderId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
let nextEventSequence = 0;

function createEventId(): string {
  nextEventSequence += 1;
  return `${senderId}:${nextEventSequence}`;
}

/**
 * Announce that the host mutated an existing turn activity record, or
 * retired one, for one exact session.
 *
 * Only the owning session id (and the retirement flag) crosses this bridge
 * — the record itself is read back through the normal exact-session/message
 * IPC boundary, so activity content cannot be broadcast into another chat's
 * renderer state.
 *
 * Delivered same-window via a `CustomEvent` AND cross-webview via the
 * sanctioned Tauri event bus (`../engine/activityBridgeTransport`), mirroring
 * `importActivityBridge`'s pattern — a permission decision resolved in one
 * webview (or a trash/delete initiated from a chat archive pane) must reach
 * a Chat pane open in a different Tauri window, not only this document.
 */
export async function publishTurnActivityUpdate(
  update: TurnActivityUpdate,
  injectedEmit?: BridgeEmit,
): Promise<void> {
  if (typeof window === "undefined" || !update.sessionId) return;
  const payload: Payload = { ...update, eventId: createEventId() };
  window.dispatchEvent(new CustomEvent<Payload>(EVENT, { detail: payload }));
  try {
    const send =
      injectedEmit ??
      (await import("../engine/activityBridgeTransport")).emitActivityBridgeEvent;
    await send(EVENT, payload);
  } catch {
    // Browser preview and tests have no Tauri event bus.
  }
}

export function subscribeTurnActivityUpdate(
  listener: (update: TurnActivityUpdate) => void,
  injectedListen?: BridgeListen,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  let disposed = false;
  let stopTauri: (() => void) | null = null;
  const seenIds = new Set<string>();
  const seenOrder: string[] = [];
  const accept = (raw: unknown) => {
    if (disposed) return;
    const payload = raw as Payload | undefined;
    if (!payload?.sessionId) return;
    // A Tauri emit is delivered to the originating webview too, arriving as
    // both a CustomEvent and a Tauri event. Dedup on a small bounded FIFO so
    // a subscriber invokes its callback once per logical update. Senders
    // without an event id remain accepted every time (same as before this
    // bridge gained cross-webview delivery).
    if (payload.eventId != null) {
      if (
        typeof payload.eventId !== "string" ||
        payload.eventId.length === 0 ||
        payload.eventId.length > MAX_EVENT_ID_LENGTH
      ) {
        return;
      }
      if (seenIds.has(payload.eventId)) return;
      seenIds.add(payload.eventId);
      seenOrder.push(payload.eventId);
      if (seenOrder.length > MAX_SEEN_EVENT_IDS) {
        const expired = seenOrder.shift();
        if (expired !== undefined) seenIds.delete(expired);
      }
    }
    listener(
      payload.retired === true
        ? { sessionId: payload.sessionId, retired: true }
        : { sessionId: payload.sessionId },
    );
  };
  const onCustom = (event: Event) => {
    accept((event as CustomEvent<Payload>).detail);
  };

  window.addEventListener(EVENT, onCustom);
  void (async () => {
    const listen =
      injectedListen ??
      (await import("../engine/activityBridgeTransport")).listenActivityBridgeEvent;
    const stop = await listen(EVENT, (event) => accept(event.payload));
    if (disposed) stop();
    else stopTauri = stop;
  })().catch(() => {
    // Browser preview and tests have no Tauri event bus.
  });

  return () => {
    disposed = true;
    window.removeEventListener(EVENT, onCustom);
    stopTauri?.();
  };
}
