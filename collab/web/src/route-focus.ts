import { useEffect, useRef } from "react";
import {
  DISCUSSION_ELEMENT_ID,
  isDiscussionSection,
  type WorkFocus,
} from "./app-location.js";

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

export function visibleSectionTarget(section: string): HTMLElement | null {
  const ids = isDiscussionSection(section)
    ? [section, DISCUSSION_ELEMENT_ID]
    : [section];
  for (const id of ids) {
    const target = document.getElementById(id);
    if (isVisibleRouteTarget(target)) return target;
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
