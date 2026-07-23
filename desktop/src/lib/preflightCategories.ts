/**
 * Work-context filtering for pre-launch Ready (#395).
 * Mirrors crates/cd-core/src/preflight.rs category rules for client reports.
 */

import type { PreflightItem, PreflightLevel } from "./preflight";

export type PreflightCategory = "launch" | "work" | "optional";

export function categoryForId(id: string): PreflightCategory {
  if (
    id.startsWith("work.") ||
    id.startsWith("confluence.") ||
    id.startsWith("connector.") ||
    id === "memory.store"
  ) {
    return "work";
  }
  if (
    id.startsWith("x.") ||
    id.startsWith("web_research") ||
    id.startsWith("news.") ||
    id.includes("web_research")
  ) {
    return "optional";
  }
  return "launch";
}

/** Items for pre-launch work-context strip (no news/X). */
export function filterWorkContextItems(items: PreflightItem[]): PreflightItem[] {
  return items.filter((i) => {
    const cat = (i as PreflightItem & { category?: PreflightCategory }).category
      ?? categoryForId(i.id);
    if (cat === "optional") return false;
    if (cat === "work") return true;
    // Files roots also surface as work context when configured
    return i.id === "workspace.roots" && i.level !== "fail";
  });
}

export function isLaunchBlockingLevel(level: PreflightLevel, id: string): boolean {
  if (level !== "fail") return false;
  return categoryForId(id) === "launch";
}
