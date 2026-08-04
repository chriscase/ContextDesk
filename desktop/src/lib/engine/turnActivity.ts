/**
 * Engine adapter for the Activity Inspector's live contract.
 *
 * `src/lib/engine/` is the designated Tauri/IPC boundary, so this is where the
 * `get_turn_activity` / `forget_session_activity` commands are reached. The
 * `src/lib/activity/*` modules stay pure and host-free; they only ever see the
 * decoded wire shape this file returns.
 *
 * Absence is normal and is never papered over. `null` means one of:
 *  - capture is disabled in config (`AppConfig.activity.enabled = false`),
 *  - the turn predates this process,
 *  - the bounded in-memory store has evicted it,
 *  - this build is running in browser preview with no Tauri host.
 *
 * All four are ordinary, and the UI's contract is to say "not recorded" rather
 * than invent an explanation of the turn.
 */
import type {
  DeveloperDetailEvent,
  HostTurnActivityRecord,
} from "../activity/types";

function isTauriHost(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      "undefined"
  );
}

/**
 * Read the recorded activity for one assistant message, or `null`.
 *
 * Never throws: an inspector that cannot load is a missing explanation, not a
 * broken chat, and it must not take the transcript down with it.
 */
export async function fetchTurnActivity(
  sessionId: string,
  messageId: string,
): Promise<HostTurnActivityRecord | null> {
  if (!sessionId || !messageId || !isTauriHost()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const record = await invoke<HostTurnActivityRecord | null>(
      "get_turn_activity",
      { sessionId, messageId },
    );
    return record ?? null;
  } catch {
    return null;
  }
}

/** Read process-local developer detail only after the explicit UI opt-in. */
export async function fetchDeveloperTurnActivity(
  sessionId: string,
  messageId: string,
): Promise<DeveloperDetailEvent[]> {
  if (!sessionId || !messageId || !isTauriHost()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (
      (await invoke<DeveloperDetailEvent[]>("get_developer_turn_activity", {
        sessionId,
        messageId,
      })) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Deletion lifecycle: drop every activity record for one session.
 *
 * A record can hold redacted conversation text when the operator opted into
 * full detail, so deleting a chat has to mean its explanations go too.
 */
export async function forgetSessionActivity(sessionId: string): Promise<void> {
  if (!sessionId || !isTauriHost()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("forget_session_activity", { sessionId });
  } catch {
    // Best-effort: the store is process-lifetime and bounded anyway.
  }
}
