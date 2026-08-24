import { useEffect, useRef } from "react";
import type { WorkFocus } from "./app-location.js";

function matchingRouteItem(focus: WorkFocus): HTMLElement | null {
  if (!focus.item) return null;
  const candidates = document.querySelectorAll<HTMLElement>("[data-route-item]");
  for (const candidate of candidates) {
    if (
      candidate.dataset.routeItem === focus.item
      && (!focus.itemKind || candidate.dataset.routeKind === focus.itemKind)
    ) return candidate;
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
    if (focus.item && !itemTarget) return;
    const target = itemTarget ?? document.getElementById(focus.section);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "center", inline: "nearest" });
    applied.current = key;
  });
}
