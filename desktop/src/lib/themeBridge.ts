import { isSkinId, type SkinId } from "./skins";

export const THEME_STORAGE_KEY = "cd-theme";
export const THEME_CHANGED_EVENT = "contextdesk:theme-changed";

type ThemePayload = { theme?: unknown };
type ThemeListen = (
  eventName: string,
  handler: (event: { payload: ThemePayload }) => void,
) => Promise<() => void>;
type ThemeEmit = (
  eventName: string,
  payload: { theme: SkinId },
) => Promise<void>;

/** Apply only a registered skin; malformed cross-window payloads fail closed. */
export function applyThemeToDocument(value: unknown): SkinId | null {
  if (typeof value !== "string" || !isSkinId(value)) return null;
  document.documentElement.setAttribute("data-theme", value);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // The document still updates when storage is unavailable.
  }
  return value;
}

/** Broadcast a theme update to same-window tests and every Tauri webview. */
export async function broadcastThemeChange(
  theme: SkinId,
  injectedEmit?: ThemeEmit,
): Promise<void> {
  window.dispatchEvent(
    new CustomEvent<ThemePayload>(THEME_CHANGED_EVENT, {
      detail: { theme },
    }),
  );
  try {
    const send =
      injectedEmit ??
      ((await import("@tauri-apps/api/event")).emit as unknown as ThemeEmit);
    await send(THEME_CHANGED_EVENT, { theme });
  } catch {
    // Browser preview and tests have no Tauri event bus.
  }
}

/** Subscribe to browser storage/custom events plus the Tauri cross-webview bus. */
export function subscribeThemeChanges(
  onTheme: (theme: SkinId) => void,
  injectedListen?: ThemeListen,
): () => void {
  let disposed = false;
  let stopTauri: (() => void) | null = null;
  const accept = (value: unknown) => {
    if (!disposed && typeof value === "string" && isSkinId(value)) {
      onTheme(value);
    }
  };
  const onCustom = (event: Event) => {
    accept((event as CustomEvent<ThemePayload>).detail?.theme);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) accept(event.newValue);
  };
  const syncStoredTheme = () => {
    try {
      accept(localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      // The Tauri event bus remains available when storage is unavailable.
    }
  };

  window.addEventListener(THEME_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", syncStoredTheme);
  void (async () => {
    const listen =
      injectedListen ??
      ((await import("@tauri-apps/api/event")).listen as unknown as ThemeListen);
    const stop = await listen(THEME_CHANGED_EVENT, (event) =>
      accept(event.payload?.theme),
    );
    if (disposed) stop();
    else stopTauri = stop;
  })().catch(() => {
    // Browser preview and tests have no Tauri event bus.
  });

  return () => {
    disposed = true;
    window.removeEventListener(THEME_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", syncStoredTheme);
    stopTauri?.();
  };
}
