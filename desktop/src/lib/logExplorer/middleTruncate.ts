/**
 * Grapheme-safe middle truncation for the Explorer corpus identity (#641).
 *
 * Corpus names carry their signal at BOTH ends (family prefix + revision/date
 * suffix), so end-only ellipsis destroys exactly the distinguishing tail.
 * Middle truncation keeps a 60/40 head/tail split, joined by one U+2026.
 *
 * All slicing is grapheme-segmented via Intl.Segmenter (undefined locale), so
 * surrogate pairs, ZWJ emoji sequences, and combining-mark clusters are never
 * split — a grapheme is the atomic unit throughout.
 */

const ELLIPSIS = "…";

/** Minimum budget for a head/tail split; below this, end-truncate instead. */
const MIN_MIDDLE_BUDGET = 15;
const HEAD_FLOOR = 8;
const TAIL_FLOOR = 6;

let segmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    segmenter = null;
  }
  return segmenter;
}

/** Split into user-perceived characters (falls back to code points). */
export function splitGraphemes(text: string): string[] {
  const seg = graphemeSegmenter();
  if (seg) {
    return Array.from(seg.segment(text), (part) => part.segment);
  }
  // Array.from iterates code points, which at least never splits surrogate
  // pairs even where Intl.Segmenter is unavailable.
  return Array.from(text);
}

/**
 * Truncate `name` to at most `maxGraphemes` user-perceived characters.
 *
 * - Fits: returned unchanged.
 * - `maxGraphemes` < 15: end-truncation at min(12, maxGraphemes - 1)
 *   graphemes plus the ellipsis (a middle split below that budget leaves
 *   neither end recognisable).
 * - Otherwise: head = ceil(budget × 0.6), tail = floor(budget × 0.4) around a
 *   single "…", with floors head ≥ 8 and tail ≥ 6 (budget = maxGraphemes − 1,
 *   the ellipsis spends one grapheme of the allowance).
 */
export function middleTruncate(name: string, maxGraphemes: number): string {
  if (!Number.isFinite(maxGraphemes)) return name;
  const limit = Math.floor(maxGraphemes);
  if (limit <= 0) return ELLIPSIS;
  const parts = splitGraphemes(name);
  if (parts.length <= limit) return name;

  if (limit < MIN_MIDDLE_BUDGET) {
    const keep = Math.max(1, Math.min(12, limit - 1));
    return parts.slice(0, keep).join("") + ELLIPSIS;
  }

  const budget = limit - 1;
  let tail = Math.max(TAIL_FLOOR, Math.floor(budget * 0.4));
  let head = Math.max(HEAD_FLOOR, Math.ceil(budget * 0.6));
  if (head + tail > budget) {
    head = Math.max(HEAD_FLOOR, budget - tail);
    if (head + tail > budget) {
      tail = Math.max(TAIL_FLOOR, budget - head);
    }
  }
  return (
    parts.slice(0, head).join("") + ELLIPSIS + parts.slice(parts.length - tail).join("")
  );
}
