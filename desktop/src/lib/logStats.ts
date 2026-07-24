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
