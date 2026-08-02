import type { UiScale } from "./session";

export const UI_SCALE_STORAGE_KEY = "cd-ui-scale";
export const UI_SCALE_CHANGED_EVENT = "contextdesk:ui-scale-changed";

type UiScalePayload = { uiScale?: unknown };
type UiScaleListen = (
  eventName: string,
  handler: (event: { payload: UiScalePayload }) => void,
) => Promise<() => void>;
type UiScaleEmit = (
  eventName: string,
  payload: { uiScale: UiScale },
) => Promise<void>;

/** Allow-list guard for the Appearance UI scale union. */
export function isUiScale(value: unknown): value is UiScale {
  return value === "90" || value === "100" || value === "110";
}

/** Validate a possibly-foreign value; unknown fails closed to "100". */
export function parseUiScale(value: unknown): UiScale {
  return isUiScale(value) ? value : "100";
}

/**
 * Apply a UI scale to the document (html[data-ui-scale] drives base.css
 * font-size) and persist it. Unknown input fails closed to "100".
 */
export function applyUiScaleToDocument(value: unknown): UiScale {
  const scale = parseUiScale(value);
  document.documentElement.setAttribute("data-ui-scale", scale);
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, scale);
  } catch {
    // The document still updates when storage is unavailable.
  }
  return scale;
}

/** Broadcast a scale update to same-window tests and every Tauri webview. */
export async function broadcastUiScaleChange(
  uiScale: UiScale,
  injectedEmit?: UiScaleEmit,
): Promise<void> {
  window.dispatchEvent(
    new CustomEvent<UiScalePayload>(UI_SCALE_CHANGED_EVENT, {
      detail: { uiScale },
    }),
  );
  try {
    const send =
      injectedEmit ??
      ((await import("@tauri-apps/api/event")).emit as unknown as UiScaleEmit);
    await send(UI_SCALE_CHANGED_EVENT, { uiScale });
  } catch {
    // Browser preview and tests have no Tauri event bus.
  }
}

/** Subscribe to browser storage/custom events plus the Tauri cross-webview bus. */
export function subscribeUiScaleChanges(
  onUiScale: (uiScale: UiScale) => void,
  injectedListen?: UiScaleListen,
): () => void {
  let disposed = false;
  let stopTauri: (() => void) | null = null;
  const accept = (value: unknown) => {
    // Malformed cross-window payloads are ignored (never coerced to "100")
    // so garbage on the bus cannot reset a legitimate scale.
    if (!disposed && isUiScale(value)) onUiScale(value);
  };
  const onCustom = (event: Event) => {
    accept((event as CustomEvent<UiScalePayload>).detail?.uiScale);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === UI_SCALE_STORAGE_KEY) accept(event.newValue);
  };
  const syncStoredUiScale = () => {
    try {
      accept(localStorage.getItem(UI_SCALE_STORAGE_KEY));
    } catch {
      // The Tauri event bus remains available when storage is unavailable.
    }
  };

  window.addEventListener(UI_SCALE_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", syncStoredUiScale);
  void (async () => {
    const listen =
      injectedListen ??
      ((await import("@tauri-apps/api/event"))
        .listen as unknown as UiScaleListen);
    const stop = await listen(UI_SCALE_CHANGED_EVENT, (event) =>
      accept(event.payload?.uiScale),
    );
    if (disposed) stop();
    else stopTauri = stop;
  })().catch(() => {
    // Browser preview and tests have no Tauri event bus.
  });

  return () => {
    disposed = true;
    window.removeEventListener(UI_SCALE_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", syncStoredUiScale);
    stopTauri?.();
  };
}
