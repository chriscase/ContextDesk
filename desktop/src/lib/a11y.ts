/**
 * Accessibility helpers (#149): focus trap, tablist keyboard, stream announce.
 * Pure functions so vitest can prove behavior without a browser driver.
 */

/** Focusable selectors used by PermissionModal and tablists. */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function queryFocusable(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => {
      if ((el as HTMLButtonElement).disabled) return false;
      if (el.getAttribute("tabindex") === "-1") return false;
      return true;
    },
  );
}

/**
 * Tab/Shift+Tab cycle inside a dialog root.
 * Returns true if the event was handled (caller should preventDefault).
 */
export function trapTabKey(
  e: { key: string; shiftKey: boolean; preventDefault: () => void },
  root: ParentNode,
  active: Element | null,
): boolean {
  if (e.key !== "Tab") return false;
  const focusable = queryFocusable(root);
  if (focusable.length === 0) return false;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
      return true;
    }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * Next tab index for Left/Right/Home/End roving on a tablist.
 * `dir`: -1 left, +1 right; Home → 0; End → last.
 */
export function nextRovingIndex(
  current: number,
  len: number,
  key: string,
): number | null {
  if (len <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return len - 1;
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (current - 1 + len) % len;
  }
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (current + 1) % len;
  }
  return null;
}

/**
 * Extract announcement text from streaming assistant content.
 * Prefer the last complete sentence; debounce is the caller's job.
 * When `streaming` is false, return the full text (trimmed, capped).
 */
export function streamAnnouncementSlice(
  text: string,
  streaming: boolean,
  maxLen = 400,
): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (!streaming) {
    return t.length > maxLen ? t.slice(t.length - maxLen) : t;
  }
  // Last sentence-like unit ending in . ! ? or newline block
  const parts = t.split(/(?<=[.!?])\s+|\n{2,}/);
  let last = "";
  for (const p of parts) {
    if (/[.!?]$/.test(p.trim()) || p.includes("\n")) {
      last = p.trim();
    }
  }
  if (!last && t.length >= 80) {
    // Fallback: last ~80 chars at word boundary when no sentence yet
    last = t.slice(Math.max(0, t.length - 80)).trim();
  }
  if (!last) return "";
  return last.length > maxLen ? last.slice(last.length - maxLen) : last;
}

/** Whether prefers-reduced-motion is set (safe for SSR/tests). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
