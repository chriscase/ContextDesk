/**
 * Semantic waits with bounded timeouts (no fixed sleep as primary strategy).
 */

/**
 * @template T
 * @param {() => Promise<T|null|undefined|false>|T|null|undefined|false} fn
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [opts]
 * @returns {Promise<T>}
 */
export async function waitUntil(fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 200;
  const label = opts.label ?? "condition";
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return /** @type {T} */ (v);
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  const detail = lastErr ? ` last error: ${String(lastErr)}` : "";
  throw new Error(`waitUntil timed out after ${timeoutMs}ms (${label})${detail}`);
}

/**
 * @param {number} ms
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Default scenario timeouts (ms) — keep bounded for CI. */
export const TIMEOUTS = {
  /** Main window / first paint */
  launch: 60_000,
  /** Demo 25k import */
  import25k: 180_000,
  /** Explorer open + first page */
  explorerReady: 60_000,
  /** Facet / count settle */
  facets: 45_000,
  /** Noise review detector pass */
  noiseReview: 45_000,
  /** Suppress preview round-trip */
  suppressPreview: 45_000,
  /** Per-action click/pointer */
  action: 15_000,
  /** Default element presence */
  element: 20_000,
};
