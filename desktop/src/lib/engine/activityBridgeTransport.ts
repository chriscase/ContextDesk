/** Sanctioned Tauri event-bus boundary for renderer activity bridges. */
import { emit, listen } from "@tauri-apps/api/event";

export async function emitActivityBridgeEvent(
  eventName: string,
  payload: unknown,
): Promise<void> {
  await emit(eventName, payload);
}

export async function listenActivityBridgeEvent(
  eventName: string,
  handler: (event: { payload: unknown }) => void,
): Promise<() => void> {
  return listen(eventName, (event) => handler({ payload: event.payload }));
}
