/**
 * Pure formatters for log ingest / corpus stats (wizard + Logs pane).
 * No Tauri dependency — unit-testable.
 */

export type StatsLike = {
  lines: number;
  templates: number;
  reductionRatio: number;
  embedded?: number;
  files?: number;
  sourceBytes?: number;
  corpusBytes?: number;
  levelCounts?: Record<string, number>;
  topTemplates?: Array<{
    id: number;
    pattern: string;
    count: number;
    severity: number;
  }>;
};

export function formatBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatReduction(ratio: number | undefined | null): string {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return "—";
  return `${ratio.toFixed(1)}×`;
}

/** One-line blurb for composer seed / cards. */
export function statsBlurb(s: StatsLike): string {
  const red = formatReduction(s.reductionRatio);
  return `${s.lines.toLocaleString()} lines → ${s.templates.toLocaleString()} templates (${red} reduction)`;
}

export function levelEntries(
  levels: Record<string, number> | undefined | null,
): Array<{ level: string; count: number }> {
  if (!levels) return [];
  return Object.entries(levels)
    .map(([level, count]) => ({ level, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Format a timeline bucket start for display.
 * Real unix times (≥ ~2001) show as locale datetime; synthetic seq-as-ts show as order.
 */
export function formatTimelineBucketStart(start: number, widthSecs: number): string {
  // Heuristic: real wall-clock unix seconds are large; ingest fallback uses seq (0,1,2…).
  if (start >= 1_000_000_000) {
    try {
      const d = new Date(start * 1000);
      const end = new Date((start + widthSecs) * 1000);
      const opts: Intl.DateTimeFormatOptions = {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };
      return `${d.toLocaleString(undefined, opts)} – ${end.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })}`;
    } catch {
      return `t=${start}`;
    }
  }
  return `events #${start}–${start + widthSecs - 1} (no wall-clock ts in logs)`;
}

/** One-line purpose caption for the volume timeline (not a log browser). */
export const TIMELINE_PURPOSE =
  "Event volume over time (spikes = where to look). This is not a full log browser — use Search / chat tools for lines and filters.";
