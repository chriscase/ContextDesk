/**
 * Log Explorer column width preferences (#535).
 * Widths are in rem for timestamp, level, source, and the message minimum.
 * The message track still fills remaining space, but its user-selected minimum
 * may intentionally produce lane-local horizontal scrolling.
 */

export type ColWidths = [number, number, number, number];

export const DEFAULT_COL_WIDTHS: ColWidths = [7.25, 2.5, 6, 16];
export const MIN_COL_WIDTHS: ColWidths = [4, 2.5, 4, 8];
export const MAX_COL_WIDTHS: ColWidths = [16, 6, 30, 80];

const STORAGE_KEY = "contextdesk.logExplorer.colWidths.v1";

export function clampColWidths(w: ColWidths): ColWidths {
  return [
    Math.min(MAX_COL_WIDTHS[0], Math.max(MIN_COL_WIDTHS[0], w[0])),
    Math.min(MAX_COL_WIDTHS[1], Math.max(MIN_COL_WIDTHS[1], w[1])),
    Math.min(MAX_COL_WIDTHS[2], Math.max(MIN_COL_WIDTHS[2], w[2])),
    Math.min(MAX_COL_WIDTHS[3], Math.max(MIN_COL_WIDTHS[3], w[3])),
  ];
}

export function loadColWidths(): ColWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_COL_WIDTHS];
    const parsed = JSON.parse(raw) as number[];
    if (!Array.isArray(parsed) || parsed.length < 3) {
      return [...DEFAULT_COL_WIDTHS];
    }
    return clampColWidths([
      Number(parsed[0]) || DEFAULT_COL_WIDTHS[0],
      Number(parsed[1]) || DEFAULT_COL_WIDTHS[1],
      Number(parsed[2]) || DEFAULT_COL_WIDTHS[2],
      Number(parsed[3]) || DEFAULT_COL_WIDTHS[3],
    ]);
  } catch {
    return [...DEFAULT_COL_WIDTHS];
  }
}

export function saveColWidths(w: ColWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clampColWidths(w)));
  } catch {
    // ignore quota / private mode
  }
}

/** Nudge one column (0=ts, 1=level, 2=source, 3=message) by delta rem. */
export function resizeCol(
  w: ColWidths,
  index: 0 | 1 | 2 | 3,
  deltaRem: number,
): ColWidths {
  const next: ColWidths = [...w];
  next[index] = next[index]! + deltaRem;
  return clampColWidths(next);
}

/** Auto-fit heuristic from bounded source/message samples (rem ≈ chars/2.2). */
export function autoFitColWidths(
  sources: string[],
  messages: string[] = [],
): ColWidths {
  let maxSrc = 6;
  let maxMessage = DEFAULT_COL_WIDTHS[3];
  for (const s of sources.slice(0, 200)) {
    maxSrc = Math.max(maxSrc, Math.min(28, s.length / 2.2));
  }
  for (const message of messages.slice(0, 200)) {
    const longestLine = message
      .split(/\r?\n/, 8)
      .reduce((max, line) => Math.max(max, line.length), 0);
    maxMessage = Math.max(maxMessage, Math.min(40, longestLine / 2.2));
  }
  return clampColWidths([8, 3.5, maxSrc, maxMessage]);
}
