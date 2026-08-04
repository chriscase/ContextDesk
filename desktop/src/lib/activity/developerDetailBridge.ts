import type { DeveloperDetailEvent } from "./types";

const EVENT = "contextdesk:developer-activity-event";

export type DeveloperDetailEnvelope = {
  sessionId: string;
  messageId: string;
  event: DeveloperDetailEvent;
};

/** Route an already-redacted host event without putting it in transcript state. */
export function publishDeveloperDetail(envelope: DeveloperDetailEnvelope): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<DeveloperDetailEnvelope>(EVENT, { detail: envelope }),
  );
}

export function subscribeDeveloperDetail(
  listener: (envelope: DeveloperDetailEnvelope) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const envelope = (event as CustomEvent<DeveloperDetailEnvelope>).detail;
    if (envelope?.sessionId && envelope.messageId && envelope.event) {
      listener(envelope);
    }
  };
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
