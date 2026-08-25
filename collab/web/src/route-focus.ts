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

/** Focus and reveal an exact canonical route target after its async data exists. */
export function useRouteFocus(focus: WorkFocus | undefined, ready: boolean): void {
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || !ready || focus.navigation === "preserve") {
      applied.current = null;
      return;
    }
    const key = [focus.section, focus.itemKind ?? "", focus.item ?? ""].join(":");
    if (applied.current === key) return;
    const itemTarget = matchingRouteItem(focus);
    // A stale or unresolved item still lands on the visible section that owns
    // it. This is more useful than focusing a hidden duplicate or doing
    // nothing, while the missing exact item remains honestly unresolved.
    const target = itemTarget ?? visibleSectionTarget(focus.section);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "center", inline: "nearest" });
    applied.current = key;
  });
}
