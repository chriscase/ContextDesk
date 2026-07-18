/**
 * Pure command-palette helpers (#154): fuzzy match + score.
 */

export type PaletteItem = {
  id: string;
  label: string;
  /** Optional secondary text (e.g. session subtitle). */
  detail?: string;
  /** Keywords that also match (e.g. "settings", ","). */
  keywords?: string[];
  group: "action" | "session";
};

/** Case-insensitive subsequence match; higher score = better. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 + (100 - Math.min(q.length, 100));
  if (t.includes(q)) return 200 + (50 - Math.min(t.indexOf(q), 50));
  // subsequence
  let ti = 0;
  let score = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score += 10 - Math.min(found - ti, 9);
    ti = found + 1;
  }
  return score;
}

export function filterPaletteItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const q = query.trim();
  if (!q) return items;
  const ranked = items
    .map((item) => {
      const hay = [item.label, item.detail ?? "", ...(item.keywords ?? [])].join(
        " ",
      );
      return { item, score: fuzzyScore(q, hay) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
  return ranked.map((r) => r.item);
}

/** True when the event target is an editable field (shortcuts must not steal plain keys). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
}

/** Platform-aware primary modifier (Cmd on Mac, Ctrl elsewhere). */
export function hasPrimaryMod(e: {
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  const isMac =
    typeof navigator !== "undefined" &&
    (/Mac/i.test(navigator.platform || "") ||
      /Mac OS X/i.test(navigator.userAgent || ""));
  return isMac ? e.metaKey : e.ctrlKey;
}
