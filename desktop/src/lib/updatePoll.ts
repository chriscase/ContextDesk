/**
 * Opt-in background update poll prefs (#339).
 * Default OFF. Installed channel only should act on results.
 */

const KEY = "cd-update-poll-v1";

export type UpdatePollPrefs = {
  /** When true, app may poll the signed updater endpoint. */
  enabled: boolean;
  /** Interval hours (min 1, default 24). */
  intervalHours: number;
  /** Last successful check epoch ms. */
  lastCheckAt: number | null;
};

export function defaultUpdatePollPrefs(): UpdatePollPrefs {
  return { enabled: false, intervalHours: 24, lastCheckAt: null };
}

export function loadUpdatePollPrefs(): UpdatePollPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultUpdatePollPrefs();
    const j = JSON.parse(raw) as Partial<UpdatePollPrefs>;
    return {
      enabled: Boolean(j.enabled),
      intervalHours: Math.max(1, Math.min(168, Number(j.intervalHours) || 24)),
      lastCheckAt:
        typeof j.lastCheckAt === "number" && Number.isFinite(j.lastCheckAt)
          ? j.lastCheckAt
          : null,
    };
  } catch {
    return defaultUpdatePollPrefs();
  }
}

export function saveUpdatePollPrefs(p: UpdatePollPrefs): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

/** Whether a check is due given prefs and now. */
export function shouldPollNow(prefs: UpdatePollPrefs, nowMs: number): boolean {
  if (!prefs.enabled) return false;
  if (prefs.lastCheckAt == null) return true;
  const intervalMs = prefs.intervalHours * 60 * 60 * 1000;
  return nowMs - prefs.lastCheckAt >= intervalMs;
}

/**
 * Pure gate: only installed channel should surface installer updates.
 * Dev/source runs must not claim installer updates.
 */
export function mayUseInstallerUpdates(channel: string | undefined | null): boolean {
  return (channel ?? "dev").toLowerCase() === "installed";
}
