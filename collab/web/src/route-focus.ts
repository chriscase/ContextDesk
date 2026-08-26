import { useEffect, useRef, useState } from "react";
import {
  DISCUSSION_ELEMENT_ID,
  isDiscussionSection,
  type WorkFocus,
} from "./app-location.js";
import type { RoutedItemPresence } from "./route-focus-copy.js";

/** Hidden stages stay mounted so their state is preserved; they are never valid link targets. */
export function isVisibleRouteTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target) return false;
  return target.closest("[hidden], [aria-hidden='true']") === null;
}

function routeItemMatches(routed: string, focus: WorkFocus): boolean {
  if (routed === focus.item) return true;
  // Job-level locators name the run. A visible workstream card is `${run}:${lane}`.
  if (
    focus.item
    && (focus.itemKind === "workstream" || focus.section === "workstreams")
    && !focus.item.includes(":")
    && routed.startsWith(`${focus.item}:`)
  ) {
    return true;
  }
  return false;
}

export function matchingRouteItem(focus: WorkFocus): HTMLElement | null {
  if (!focus.item) return null;
  const candidates = document.querySelectorAll<HTMLElement>("[data-route-item]");
  for (const candidate of candidates) {
    const routed = candidate.dataset.routeItem;
    if (!routed) continue;
    if (
      routeItemMatches(routed, focus)
      && (!focus.itemKind || candidate.dataset.routeKind === focus.itemKind)
      && isVisibleRouteTarget(candidate)
    ) return candidate;
  }
  return null;
}

/**
 * All elements carrying this id, in document order.
 *
 * The same panel can legitimately be anchored under more than one stage (for
 * example Timezone review, which sits on both Capture and Analyze). Only one
 * of those copies is visible at a time, and `getElementById` returns whichever
 * comes first in the document — so a link addressed at the visible copy would
 * otherwise resolve to a hidden one and focus nothing.
 */
function elementsWithId(id: string): HTMLElement[] {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  try {
    return [...document.querySelectorAll<HTMLElement>(`#${escaped}`)];
  } catch {
    const only = document.getElementById(id);
    return only ? [only] : [];
  }
}

export function visibleSectionTarget(section: string): HTMLElement | null {
  const ids = isDiscussionSection(section)
    ? [section, DISCUSSION_ELEMENT_ID]
    : [section];
  for (const id of ids) {
    for (const target of elementsWithId(id)) {
      if (isVisibleRouteTarget(target)) return target;
    }
  }
  return null;
}

/** What a route address settled on, so a provisional landing can be upgraded. */
interface AppliedFocus {
  key: string;
  /** True once the exact routed item — not just its section — took focus. */
  exact: boolean;
  /** The element this hook focused, used to detect a reader moving away. */
  target: HTMLElement | null;
  /** The lane highlighted when this focus was applied. */
  lane: string | null;
}

/** Focus and reveal an exact canonical route target after its async data exists. */
export function useRouteFocus(focus: WorkFocus | undefined, ready: boolean): void {
  const applied = useRef<AppliedFocus | null>(null);
  // The address this hook last saw, applied or not. Lane highlighting rewrites
  // the URL without being navigation, and the canonical URL deliberately drops
  // the in-memory "preserve" marker, so the only way to recognise a lane-only
  // change is to compare it with the previous address.
  const seen = useRef<{ key: string; lane: string | null } | null>(null);
  useEffect(() => {
    if (!focus || !ready || focus.navigation === "preserve") {
      applied.current = null;
      if (focus) {
        seen.current = {
          key: [focus.section, focus.itemKind ?? "", focus.item ?? ""].join(":"),
          lane: focus.lane ?? null,
        };
      }
      return;
    }
    const key = [focus.section, focus.itemKind ?? "", focus.item ?? ""].join(":");
    const itemTarget = matchingRouteItem(focus);
    // Highlighting a lane is not navigation, and the UI promises the page will
    // not jump. Recognise it by comparing with the previous address: same
    // section, same item, different lane means the reader stays where they are.
    const laneOnlyChange =
      seen.current !== null
      && seen.current.key === key
      && seen.current.lane !== (focus.lane ?? null);
    seen.current = { key, lane: focus.lane ?? null };
    if (laneOnlyChange) {
      if (applied.current) applied.current = { ...applied.current, lane: focus.lane ?? null };
      return;
    }
    if (applied.current?.key === key) {
      if (!itemTarget) return;
      // The exact record still holds focus; nothing to do.
      if (document.activeElement === itemTarget) return;
      const active = document.activeElement;
      if (applied.current.exact) {
        // The record had focus and lost it. Reclaim it only from the section
        // that wraps the record — the one place the browser puts focus when it
        // replaces a focused node during a background refresh. Focus a reader
        // moved anywhere else is theirs, and is never taken back.
        if (active !== visibleSectionTarget(focus.section)) return;
      } else if (active !== applied.current.target) {
        // A section landing is provisional: records named by a copied link
        // often arrive after the first paint. Upgrade to the exact record, but
        // only while focus is still where this hook put it, so a reader who has
        // already started working is never interrupted.
        return;
      }
    }
    // A stale or unresolved item still lands on the visible section that owns
    // it. This is more useful than focusing a hidden duplicate or doing
    // nothing, while the missing exact item remains honestly unresolved.
    const target = itemTarget ?? visibleSectionTarget(focus.section);
    if (!target) return;
    // Exact records may live in disclosure widgets that are collapsed by
    // default to keep long investigations readable. A direct link promises to
    // reveal the named record, so open every containing disclosure before
    // moving focus to it.
    if (itemTarget) {
      let disclosure = itemTarget.closest<HTMLDetailsElement>("details");
      while (disclosure) {
        disclosure.open = true;
        disclosure = disclosure.parentElement?.closest<HTMLDetailsElement>("details") ?? null;
      }
    }
    target.focus({ preventScroll: true });
    // Centring a record taller than the viewport puts its opening lines above
    // the fold, so a link that promised to open a record lands the reader in
    // the middle of it. Show the top of anything that cannot fit.
    const viewportHeight = window.innerHeight || 0;
    const targetHeight = target.getBoundingClientRect?.().height ?? 0;
    const block = viewportHeight > 0 && targetHeight > viewportHeight * 0.8 ? "start" : "center";
    target.scrollIntoView?.({ block, inline: "nearest" });
    applied.current = { key, exact: Boolean(itemTarget), target, lane: focus.lane ?? null };
  });
}

/**
 * Whether the exact record a deep link named is actually on the page.
 *
 * Read by the arrival announcement so it can never claim to have opened a
 * record that is not there. Records named by a copied link routinely arrive
 * after the first paint, so absence is only reported once the surface has
 * settled — until then the answer is `pending`, and the announcement says it
 * is opening rather than that it arrived.
 */
/** How often the named record is looked for while a surface is still loading. */
const ROUTED_ITEM_POLL_MS = 150;
/** How long it is given to appear before the link is reported as not showing it. */
const ROUTED_ITEM_SETTLE_MS = 1_200;

export function useRoutedItemPresence(
  focus: WorkFocus | undefined,
  ready: boolean,
): RoutedItemPresence {
  const [presence, setPresence] = useState<RoutedItemPresence>("none");
  const key = focus ? [focus.section, focus.itemKind ?? "", focus.item ?? ""].join(":") : "";
  useEffect(() => {
    if (!focus?.item) {
      setPresence("none");
      return undefined;
    }
    if (!ready) {
      setPresence("pending");
      return undefined;
    }
    if (matchingRouteItem(focus)) {
      setPresence("exact");
      return undefined;
    }
    // Settled case data does not mean every panel has finished loading its own
    // records, so the surface is given a bounded chance to render the one that
    // was named before absence is reported. Reporting it early would blame the
    // link for a record that is about to appear; never reporting it at all is
    // the false success this exists to prevent.
    setPresence("pending");
    let elapsed = 0;
    const timer = window.setInterval(() => {
      elapsed += ROUTED_ITEM_POLL_MS;
      if (matchingRouteItem(focus)) {
        window.clearInterval(timer);
        setPresence("exact");
        return;
      }
      if (elapsed >= ROUTED_ITEM_SETTLE_MS) {
        window.clearInterval(timer);
        setPresence("absent");
      }
    }, ROUTED_ITEM_POLL_MS);
    return () => window.clearInterval(timer);
    // `key` carries every part of `focus` this effect reads — section, itemKind,
    // and item — so a new focus object with the same address correctly does not
    // restart the search.
  }, [key, ready]);
  return presence;
}
