/**
 * The ONE persisted Activity Inspector display preference, shared by ordinary
 * chat and the Log Explorer.
 *
 * Requirement 1 is that there is a single control and a single preference:
 * switching to Drawer in chat and then opening the Explorer must find Drawer
 * there too. That is why the key below is not namespaced per surface, and why
 * `useActivityInspector` broadcasts changes to every mounted surface rather
 * than each keeping its own copy.
 *
 * Same storage pattern as `lib/aiGatewayPrefs.ts` — plain localStorage, never
 * secrets, always try/catch (private mode / quota).
 */
import { ACTIVITY_MODES, type ActivityMode } from "./types";

const MODE_KEY = "cd-activity-inspector-mode";
const DOCK_WIDTH_KEY = "cd-activity-inspector-dock-width";

/**
 * In-process notification that the shared preference changed.
 *
 * `storage` events only fire in *other* documents, so a second surface in the
 * same window would never learn about a change without this.
 */
export const ACTIVITY_MODE_CHANGED_EVENT = "contextdesk:activity-mode-changed";

/** Quiet by default: the inspector must not appear until asked for. */
export const DEFAULT_ACTIVITY_MODE: ActivityMode = "off";
export const DEFAULT_DOCK_WIDTH = 340;
export const MIN_DOCK_WIDTH = 260;
export const MAX_DOCK_WIDTH = 560;

/**
 * Modes written by the pre-unification build, mapped forward.
 *
 * The main-chat draft persisted `"hidden"` for what is now `"off"`. Readers
 * with that value must land on Off rather than silently reverting to the
 * default, which would be the same value today but would stop being so the
 * moment the default changes.
 */
const LEGACY_MODE_ALIASES: Record<string, ActivityMode> = {
  hidden: "off",
};

export function isActivityMode(v: unknown): v is ActivityMode {
  return typeof v === "string" && (ACTIVITY_MODES as readonly string[]).includes(v);
}

/** Normalize any stored/incoming value to a mode, or null when unusable. */
export function coerceActivityMode(v: unknown): ActivityMode | null {
  if (isActivityMode(v)) return v;
  if (typeof v === "string" && v in LEGACY_MODE_ALIASES) {
    return LEGACY_MODE_ALIASES[v]!;
  }
  return null;
}

export function loadActivityMode(): ActivityMode {
  try {
    return coerceActivityMode(localStorage.getItem(MODE_KEY)) ?? DEFAULT_ACTIVITY_MODE;
  } catch {
    return DEFAULT_ACTIVITY_MODE;
  }
}

export function saveActivityMode(mode: ActivityMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* quota / private mode */
  }
  // Tell every other mounted surface in this document, so the single
  // preference stays single even with chat and the Explorer both open.
  try {
    window.dispatchEvent(
      new CustomEvent<ActivityMode>(ACTIVITY_MODE_CHANGED_EVENT, {
        detail: mode,
      }),
    );
  } catch {
    /* no window (SSR / node test) */
  }
}

/** Subscribe to shared-preference changes. Returns an unsubscribe. */
export function subscribeActivityMode(
  onChange: (mode: ActivityMode) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const mode = coerceActivityMode((event as CustomEvent<unknown>).detail);
    if (mode) onChange(mode);
  };
  window.addEventListener(ACTIVITY_MODE_CHANGED_EVENT, handler);
  return () => window.removeEventListener(ACTIVITY_MODE_CHANGED_EVENT, handler);
}

export function clampDockWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_DOCK_WIDTH;
  return Math.min(MAX_DOCK_WIDTH, Math.max(MIN_DOCK_WIDTH, Math.round(px)));
}

export function loadDockWidth(): number {
  try {
    const v = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    return Number.isFinite(v) && v > 0 ? clampDockWidth(v) : DEFAULT_DOCK_WIDTH;
  } catch {
    return DEFAULT_DOCK_WIDTH;
  }
}

export function saveDockWidth(px: number): void {
  try {
    localStorage.setItem(DOCK_WIDTH_KEY, String(clampDockWidth(px)));
  } catch {
    /* quota / private mode */
  }
}
