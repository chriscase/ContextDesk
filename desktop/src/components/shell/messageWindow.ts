/**
 * Pure window-range helpers for virtualized chat transcripts (#148).
 * Hand-rolled (no virtualizer package) so default builds stay offline.
 */

export const DEFAULT_ROW_ESTIMATE_PX = 96;
export const DEFAULT_OVERSCAN = 6;
/** Below this count, mount every row (no virtualization overhead). */
export const VIRTUALIZE_THRESHOLD = 40;

export type WindowPlan = {
  /** Sorted unique indices to mount (may be non-contiguous when force-keeping a streaming row). */
  indices: number[];
  /** Cumulative offset (px) for each index 0..count-1. */
  offsets: number[];
  totalHeight: number;
  /** True when only a subset of rows is mounted. */
  virtualized: boolean;
};

function heightAt(
  heights: ReadonlyMap<number, number> | readonly number[],
  i: number,
  estimatePx: number,
): number {
  if (Array.isArray(heights)) {
    return heights[i] ?? estimatePx;
  }
  return (heights as ReadonlyMap<number, number>).get(i) ?? estimatePx;
}

/**
 * Plan which rows to mount given scroll metrics and measured heights.
 * `forceIndices` (e.g. streaming rows) are always included even if off-screen,
 * without expanding the window into a full mount of the gap.
 */
export function computeWindowPlan(args: {
  count: number;
  scrollTop: number;
  clientHeight: number;
  heights: ReadonlyMap<number, number> | readonly number[];
  estimatePx?: number;
  overscan?: number;
  forceIndices?: readonly number[];
}): WindowPlan {
  const {
    count,
    scrollTop,
    clientHeight,
    heights,
    estimatePx = DEFAULT_ROW_ESTIMATE_PX,
    overscan = DEFAULT_OVERSCAN,
    forceIndices = [],
  } = args;

  const offsets: number[] = new Array(count);
  let totalHeight = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = totalHeight;
    totalHeight += heightAt(heights, i, estimatePx);
  }

  if (count <= 0) {
    return { indices: [], offsets, totalHeight: 0, virtualized: false };
  }

  if (count <= VIRTUALIZE_THRESHOLD) {
    return {
      indices: Array.from({ length: count }, (_, i) => i),
      offsets,
      totalHeight,
      virtualized: false,
    };
  }

  const viewTop = Math.max(0, scrollTop);
  const viewBottom = viewTop + Math.max(clientHeight, 1);

  let start = 0;
  while (
    start < count - 1 &&
    offsets[start]! + heightAt(heights, start, estimatePx) < viewTop
  ) {
    start++;
  }
  let end = start;
  while (end < count && offsets[end]! < viewBottom) {
    end++;
  }

  start = Math.max(0, start - overscan);
  end = Math.min(count, end + overscan);

  const set = new Set<number>();
  for (let i = start; i < end; i++) set.add(i);
  for (const fi of forceIndices) {
    if (fi >= 0 && fi < count) set.add(fi);
  }

  const indices = Array.from(set).sort((a, b) => a - b);
  return { indices, offsets, totalHeight, virtualized: true };
}

/** @deprecated use computeWindowPlan — kept for tests that only need range edges */
export function computeWindowRange(args: {
  count: number;
  scrollTop: number;
  clientHeight: number;
  heights: ReadonlyMap<number, number> | readonly number[];
  estimatePx?: number;
  overscan?: number;
  forceIndices?: readonly number[];
}): { start: number; end: number; offsetTop: number; totalHeight: number } {
  const plan = computeWindowPlan(args);
  if (plan.indices.length === 0) {
    return { start: 0, end: 0, offsetTop: 0, totalHeight: plan.totalHeight };
  }
  // Contiguous range covering the primary window (ignore non-contiguous force for edges)
  const start = plan.indices[0]!;
  const end = plan.indices[plan.indices.length - 1]! + 1;
  return {
    start,
    end,
    offsetTop: plan.offsets[start] ?? 0,
    totalHeight: plan.totalHeight,
  };
}

/** Indices that must stay mounted (streaming rows + last). */
export function forceKeepIndices(
  messages: { streaming?: boolean }[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.streaming) out.push(i);
  }
  if (messages.length > 0) {
    const last = messages.length - 1;
    if (!out.includes(last)) out.push(last);
  }
  return out;
}
