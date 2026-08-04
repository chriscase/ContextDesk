const EVENT = "contextdesk:turn-activity-updated";

export type TurnActivityUpdate = {
  sessionId: string;
};

/**
 * Announce that the host mutated an existing turn activity record.
 *
 * Only the owning session id crosses this bridge. The record itself is read
 * back through the normal exact-session/message IPC boundary, so activity
 * content cannot be broadcast into another chat's renderer state.
 */
export function publishTurnActivityUpdate(update: TurnActivityUpdate): void {
  if (typeof window === "undefined" || !update.sessionId) return;
  window.dispatchEvent(
    new CustomEvent<TurnActivityUpdate>(EVENT, { detail: update }),
  );
}

export function subscribeTurnActivityUpdate(
  listener: (update: TurnActivityUpdate) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const update = (event as CustomEvent<TurnActivityUpdate>).detail;
    if (update?.sessionId) listener(update);
  };
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
