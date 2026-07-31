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
export function filterWorkContextItems(
  items: PreflightItem[],
): PreflightItem[] {
  return items.filter((i) => {
    const cat =
      (i as PreflightItem & { category?: PreflightCategory }).category ??
      categoryForId(i.id);
    if (cat === "optional") return false;
    if (cat === "work") return true;
    // Files roots also surface as work context when configured
    return i.id === "workspace.roots" && i.level !== "fail";
  });
}

export function isLaunchBlockingLevel(
  level: PreflightLevel,
  id: string,
): boolean {
  if (level !== "fail") return false;
  return categoryForId(id) === "launch";
}

/**
 * Probe-outcome items whose `warn` level means "this was never measured" (#746).
 *
 * cd-core is deliberately honest per item — `provider.remote` warns "Not
 * live-tested yet … (URL shape alone is not a probe)" — but `hasBlocking` is
 * fail-only, so every aggregate surface collapsed unmeasured into healthy and
 * reported "Ready · Preflight ok" for a provider that had never answered.
 *
 * Deliberately narrow. Other launch-category warnings mean something else and
 * must not be reported as unverified readiness:
 *   - `provider.embed` warns on a malformed embed URL (misconfigured, not unmeasured)
 *   - `provider.grok_session` warns when optional session material is absent
 */
export const UNVERIFIED_PROBE_IDS = [
  "provider.key",
  "provider.ollama",
  "provider.remote",
] as const;

const UNVERIFIED_PROBE_ID_SET = new Set<string>(UNVERIFIED_PROBE_IDS);

/** Launch-critical probes that are configured but were never actually run. */
export function unverifiedProbeItems(items: PreflightItem[]): PreflightItem[] {
  return items.filter(
    (item) => item.level === "warn" && UNVERIFIED_PROBE_ID_SET.has(item.id),
  );
}

export type PreflightReadiness = "blocked" | "unverified" | "ready";

/**
 * Three-state readiness for status surfaces. `ready` requires a measurement,
 * never merely the presence of configuration.
 */
export function preflightReadiness(
  items: PreflightItem[],
  hasBlocking: boolean,
): PreflightReadiness {
  if (hasBlocking) return "blocked";
  return unverifiedProbeItems(items).length > 0 ? "unverified" : "ready";
}
