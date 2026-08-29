/**
 * The small, frontend-only catalogue of presentation strategies.
 *
 * A strategy owns presentation, navigation and sensible defaults. It does
 * not own case, evidence, permission or lifecycle rules: those remain behind
 * the protected API and the existing domain panels. Keeping this catalogue
 * plain data makes it safe for the shell to select a strategy without giving
 * a UI plug-in a second authority over investigation records.
 */

export const DEFAULT_UI_STRATEGY_ID = "war-room" as const;

export const UI_STRATEGY_IDS = ["war-room", "investigation-first"] as const;
export type UiStrategyId = (typeof UI_STRATEGY_IDS)[number];

export type UiStrategyMaturity = "reference" | "pilot";
export type UiStrategyStatus = "available" | "preview";

export interface UiStrategyCompatibility {
  /** The authoritative investigation record contract consumed by the UI. */
  schemaId: "cd-collab.case.v1";
  /** Semver-style UI compatibility range for this strategy contract. */
  version: string;
}

export interface UiStrategyDescriptor {
  id: UiStrategyId;
  name: string;
  description: string;
  /** Stable token for a CSS/icon preview; assets can be added later. */
  previewToken: string;
  /** Optional packaged preview asset. `null` means the token is sufficient. */
  previewAsset: string | null;
  maturity: UiStrategyMaturity;
  status: UiStrategyStatus;
  version: string;
  compatibility: UiStrategyCompatibility;
}

/**
 * The only strategies shipped in this milestone. The War Room remains the
 * reference/default surface while Investigation First is the first alternate
 * presentation adapter.
 */
export const UI_STRATEGIES: readonly UiStrategyDescriptor[] = [
  {
    id: "war-room",
    name: "War Room",
    description:
      "The reference stage-based workspace for capturing, analyzing, comparing, and deciding.",
    previewToken: "strategy-war-room",
    previewAsset: null,
    maturity: "reference",
    status: "available",
    version: "1.0.0",
    compatibility: {
      schemaId: "cd-collab.case.v1",
      version: "^1.0.0",
    },
  },
  {
    id: "investigation-first",
    name: "Investigation First",
    description:
      "A fast, view-first surface for entering triage data, browsing investigations, and reviewing evidence.",
    previewToken: "strategy-investigation-first",
    previewAsset: null,
    maturity: "pilot",
    status: "available",
    version: "1.0.0",
    compatibility: {
      schemaId: "cd-collab.case.v1",
      version: "^1.0.0",
    },
  },
] as const;

const STRATEGY_BY_ID: ReadonlyMap<UiStrategyId, UiStrategyDescriptor> = new Map(
  UI_STRATEGIES.map((strategy) => [strategy.id, strategy]),
);

export interface ResolveUiStrategyOptions {
  /** A user preference, considered first when it is policy-allowed. */
  preferred?: unknown;
  /** The instance/role default, considered after the user preference. */
  instanceDefault?: unknown;
  /** An optional policy allow-list. Unknown IDs are ignored. */
  allowedIds?: readonly unknown[];
}

function findStrategy(candidate: unknown): UiStrategyDescriptor | undefined {
  if (typeof candidate !== "string") return undefined;
  return STRATEGY_BY_ID.get(candidate as UiStrategyId);
}

/**
 * Resolve a strategy without ever trusting an unknown identifier.
 *
 * The resolver is deliberately deterministic and fail-closed:
 * - unknown preferences/defaults never escape the known catalogue;
 * - a supplied allow-list is intersected with the known catalogue;
 * - a preferred strategy cannot bypass that allow-list;
 * - a malformed or empty policy falls back to the reference strategy so the
 *   shell always has a safe presentation, rather than rendering an unknown
 *   strategy or a blank state.
 */
export function resolveUiStrategy(
  options: ResolveUiStrategyOptions = {},
): UiStrategyDescriptor {
  const hasAllowList = options.allowedIds !== undefined;
  const allowed = hasAllowList
    ? UI_STRATEGIES.filter((strategy) => options.allowedIds?.includes(strategy.id) ?? false)
    : UI_STRATEGIES;

  const isAllowed = (strategy: UiStrategyDescriptor | undefined): strategy is UiStrategyDescriptor =>
    strategy !== undefined && allowed.some((candidate) => candidate.id === strategy.id);

  const preferred = findStrategy(options.preferred);
  if (isAllowed(preferred)) return preferred;

  const instanceDefault = findStrategy(options.instanceDefault);
  if (isAllowed(instanceDefault)) return instanceDefault;

  const reference = findStrategy(DEFAULT_UI_STRATEGY_ID);
  if (isAllowed(reference)) return reference;

  // An explicit policy that omits the reference strategy still needs a
  // deterministic result. Choose the first known allow-listed strategy; if
  // the policy contained no usable IDs, use the reference as the safest UI.
  return allowed[0] ?? reference!;
}

