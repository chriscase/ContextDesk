/** Pure helpers for splash duration + storage (offline-testable). */

export const SPLASH_STORAGE_KEY = "contextdesk.splashCompleted";
export const SPLASH_FIRST_MS = 4500;
export const SPLASH_RETURN_MS = 2200;

/** Resolve total splash duration (ms). First visit longer than return. */
export function resolveSplashDuration(
  storageKey: string,
  storage: Pick<Storage, "getItem"> = localStorage,
  overrideMs?: number,
): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  try {
    return storage.getItem(storageKey) ? SPLASH_RETURN_MS : SPLASH_FIRST_MS;
  } catch {
    return SPLASH_FIRST_MS;
  }
}

/** Mark splash complete so next launch uses short duration. */
export function markSplashCompleted(
  storageKey: string,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey, "1");
  } catch {
    /* private mode */
  }
}

/** Dev / screenshot skip. */
export function shouldSkipSplash(search: string = ""): boolean {
  if (typeof import.meta !== "undefined" && import.meta.env?.VITE_SKIP_SPLASH === "1") {
    return true;
  }
  return (
    search.includes("skipSplash=1") ||
    search.includes("skipSplash=true") ||
    search.includes("skipStartup=1")
  );
}
