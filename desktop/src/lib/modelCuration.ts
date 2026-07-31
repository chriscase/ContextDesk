/**
 * The one curated-selection contract every model picker consumes (#678).
 *
 * Before this existed, the main composer and the linked-chat rail each grouped
 * and ordered the model list their own way, so any curation rule had to be
 * re-implemented per picker and drifted. Everything presentational about
 * "which choices does this picker offer, in what order" lives here.
 *
 * Curation is display state. A hidden model is still configured and still
 * reachable; hiding is never a security or redaction claim, and it says
 * nothing about whether a provider is healthy — `tools_enabled` /
 * `tools_disabled_reason` and provider health remain the truth for that.
 */

import type { ModelOptionDto } from "@contextdesk/contracts";

/** One `<optgroup>`-shaped band of the picker. */
export type CuratedGroup = {
  key: string;
  label: string;
  options: ModelOptionDto[];
};

export type CuratedModels = {
  /** Explicitly pinned, in the user's own order. */
  pinned: ModelOptionDto[];
  /** Ordinary visible choices. */
  available: ModelOptionDto[];
  /**
   * Curated away. Empty unless `includeHidden`, except for a selected choice,
   * which is always surfaced so a chat never loses its real model silently.
   */
  hidden: ModelOptionDto[];
  /** Render order for a picker: pinned band first, then provider groups. */
  groups: CuratedGroup[];
  /** The selected option when it is hidden — the picker must say so. */
  selectedHidden: ModelOptionDto | null;
  /** True when curation has left nothing to choose from. */
  empty: boolean;
  /** How many choices are curated away (whether or not they are listed). */
  hiddenCount: number;
  /** True when a search query filtered the result. */
  filtered: boolean;
  /** Matches dropped by the render cap, so callers can say so honestly. */
  truncated: number;
};

export type CurateOptions = {
  /** The picker's current value, always kept visible. */
  selectedKey?: string | null;
  /** Free-text filter over model id, label, and provider label. */
  query?: string;
  /** Management surfaces pass true; ordinary pickers never do. */
  includeHidden?: boolean;
  /**
   * Upper bound on rendered options. Discovery against a large gateway can
   * return thousands; an unbounded `<select>` is unusable and janky, so the
   * list is capped and the remainder reported rather than quietly dropped.
   */
  limit?: number;
};

/** Default hard cap across every rendered picker band. */
export const DEFAULT_PICKER_LIMIT = 200;

const PINNED_GROUP_KEY = "__pinned__";

function isHidden(m: ModelOptionDto): boolean {
  return Boolean(m.hidden);
}

function pinRank(m: ModelOptionDto): number | null {
  return typeof m.pinned_rank === "number" ? m.pinned_rank : null;
}

/**
 * Separator between fields in the search haystack.
 *
 * Written as an escape, never as a literal byte. A raw NUL in a .ts file makes
 * Git classify the whole file as binary, which costs the diff, blame, and
 * three-way merges. The runtime value is unchanged: a character no user can
 * type, so a query cannot match across two field boundaries.
 */
const HAYSTACK_SEP = "\u0000";

function matches(m: ModelOptionDto, needle: string): boolean {
  if (!needle) return true;
  const haystack = [m.id, m.label, m.provider_label, m.group].join(
    HAYSTACK_SEP,
  );
  return haystack.toLowerCase().includes(needle);
}

/**
 * Order within a band: pinned rank first (explicit user order), then the
 * host's own ordering, which is already active-provider-first then group then
 * model id. Stable so a discovery refresh cannot reshuffle the list.
 */
function byPinThenHostOrder(
  a: ModelOptionDto,
  b: ModelOptionDto,
  indexOf: Map<string, number>,
): number {
  const ra = pinRank(a);
  const rb = pinRank(b);
  if (ra !== null && rb !== null) return ra - rb;
  if (ra !== null) return -1;
  if (rb !== null) return 1;
  return (indexOf.get(a.selection_key) ?? 0) - (indexOf.get(b.selection_key) ?? 0);
}

/**
 * Turn a raw model list into what a picker should render.
 *
 * Duplicate `selection_key`s — which a discovery refresh race can briefly
 * produce by appending a second copy of the same list — are collapsed to the
 * first occurrence, so a picker can never show one model twice.
 */
export function curateModels(
  all: readonly ModelOptionDto[],
  options: CurateOptions = {},
): CuratedModels {
  const {
    selectedKey = null,
    query = "",
    includeHidden = false,
    limit = DEFAULT_PICKER_LIMIT,
  } = options;

  const deduped: ModelOptionDto[] = [];
  const seen = new Set<string>();
  for (const m of all) {
    if (!m || typeof m.selection_key !== "string" || !m.selection_key) continue;
    if (seen.has(m.selection_key)) continue;
    seen.add(m.selection_key);
    deduped.push(m);
  }

  const indexOf = new Map(deduped.map((m, i) => [m.selection_key, i]));
  const needle = query.trim().toLowerCase();
  const selected =
    deduped.find((m) => m.selection_key === selectedKey) ?? null;

  // The selected choice is exempt from search and from hiding: a picker that
  // cannot render its own value would silently show the wrong model.
  const keep = (m: ModelOptionDto) =>
    m.selection_key === selectedKey || matches(m, needle);

  const visible = deduped.filter((m) => !isHidden(m) && keep(m));
  const hiddenAll = deduped.filter(isHidden);
  const hiddenListed = includeHidden
    ? hiddenAll.filter(keep)
    : hiddenAll.filter((m) => m.selection_key === selectedKey);

  const sortAll = (list: ModelOptionDto[]) =>
    [...list].sort((a, b) => byPinThenHostOrder(a, b, indexOf));

  const allPinned = sortAll(visible.filter((m) => pinRank(m) !== null));
  const allAvailable = sortAll(visible.filter((m) => pinRank(m) === null));
  const allHidden = sortAll(hiddenListed);

  // One cap governs the complete rendered inventory. Pinned rows receive
  // priority, but cannot make a large user-curated inventory unbounded. The
  // current selection is the sole exemption in priority: if it falls beyond
  // the cap, it displaces the final retained row instead of being appended.
  const capacity = Math.max(0, Math.floor(limit));
  const candidates = [...allPinned, ...allAvailable, ...allHidden];
  const retained = new Set(
    candidates.slice(0, capacity).map((m) => m.selection_key),
  );
  if (
    capacity > 0 &&
    selected &&
    candidates.some((m) => m.selection_key === selected.selection_key) &&
    !retained.has(selected.selection_key)
  ) {
    const displaced = candidates
      .slice(0, capacity)
      .at(-1)?.selection_key;
    if (displaced) retained.delete(displaced);
    retained.add(selected.selection_key);
  }

  const retain = (m: ModelOptionDto) => retained.has(m.selection_key);
  const pinned = allPinned.filter(retain);
  const available = allAvailable.filter(retain);
  const hidden = allHidden.filter(retain);
  const truncated = candidates.length - retained.size;

  const groups: CuratedGroup[] = [];
  if (pinned.length > 0) {
    groups.push({ key: PINNED_GROUP_KEY, label: "Pinned", options: pinned });
  }
  const byGroup = new Map<string, ModelOptionDto[]>();
  for (const m of available) {
    const key = m.group || m.provider_label || "Other";
    const list = byGroup.get(key);
    if (list) list.push(m);
    else byGroup.set(key, [m]);
  }
  for (const [key, opts] of byGroup) {
    groups.push({ key, label: key, options: opts });
  }
  if (hidden.length > 0) {
    groups.push({ key: "__hidden__", label: "Hidden", options: hidden });
  }

  return {
    pinned,
    available,
    hidden,
    groups,
    selectedHidden: selected && isHidden(selected) ? selected : null,
    empty: pinned.length === 0 && available.length === 0 && hidden.length === 0,
    hiddenCount: hiddenAll.length,
    filtered: needle.length > 0,
    truncated,
  };
}

/**
 * One-line summary for the Settings entry point, so ordinary Settings shows a
 * count rather than the whole inventory (progressive disclosure).
 */
export function curationSummary(all: readonly ModelOptionDto[]): string {
  const shown = all.filter((m) => !isHidden(m)).length;
  const hiddenCount = all.filter(isHidden).length;
  const pinnedCount = all.filter((m) => pinRank(m) !== null).length;
  const parts = [`${shown} shown`];
  if (hiddenCount > 0) parts.push(`${hiddenCount} hidden`);
  if (pinnedCount > 0) parts.push(`${pinnedCount} pinned`);
  return parts.join(" · ");
}
