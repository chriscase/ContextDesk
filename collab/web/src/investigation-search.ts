/**
 * Finding one investigation among many.
 *
 * The inventory search matched a fixed list of fields — title, id, creator,
 * participants — that did not include most of what the investigation actually
 * says about itself. Someone who remembered an investigation as "the one about
 * the storefront operators" could not find it, because `affectedParties` was
 * displayed on the Situation picture and searched nowhere. The same held for
 * impact, scope, and the open questions. A search that misses the words a
 * reader remembers teaches them the search does not work.
 *
 * Two behaviours here are deliberate and worth stating, because both look like
 * bugs from one angle and are the point from another:
 *
 * 1. **Archived investigations are hidden by default.** Before the lifecycle
 *    controls existed, `archived` was a label that changed nothing: an
 *    archived case sat in the working list beside live ones, so archiving
 *    accomplished nothing a reader could see. Hiding them is what makes
 *    archiving mean something. It is never silent — the count of what is
 *    hidden is reported, and one control brings them back — and asking for
 *    the archived status explicitly always shows them.
 *
 * 2. **Identifiers are matched but not ranked.** A pasted investigation id is
 *    a legitimate way to find a case, so ids stay searchable. They are not
 *    part of what the surface *shows*: the card names the investigation in
 *    words, and the exact identifier stays one disclosure away. Matching on a
 *    value is not a reason to display it.
 *
 * Pure functions over rows the caller already has. No fetching, no sorting
 * policy, no component state — so the rules can be tested directly and the
 * list component holds only the controls.
 */

/** The subset of an investigation this module reads. All optional but `id`. */
export interface SearchableInvestigationContext {
  productName?: string | null;
  version?: string | null;
  build?: string | null;
  component?: string | null;
  environment?: string | null;
  organization?: string | null;
}

export interface SearchableInvestigation {
  id: string;
  title?: string;
  status?: string;
  severity?: string;
  problemStatement?: string | undefined;
  affectedParties?: string | undefined;
  impact?: string | undefined;
  scope?: string | undefined;
  openQuestions?: readonly string[] | undefined;
  occurredAt?: string | null | undefined;
  createdAt?: string | undefined;
  createdBy?: string | undefined;
  createdByUsername?: string | null | undefined;
  creator?: string | null | undefined;
  reportedProblem?: string | null | undefined;
  problem?: string | null | undefined;
  summary?: string | null | undefined;
  investigationContext?: SearchableInvestigationContext | null | undefined;
  participants?: readonly { username?: string }[] | undefined;
}

export const ARCHIVED_STATUS = "archived";

export interface InvestigationFilter {
  /** Free text. Trimmed and case-folded before matching. */
  query: string;
  /** A status name, or `all`. */
  status: string;
  /** An entity id, or `all`. */
  entityId: string;
  /** Whether archived investigations join the list. */
  includeArchived: boolean;
}

export const DEFAULT_FILTER: InvestigationFilter = {
  query: "",
  status: "all",
  entityId: "all",
  includeArchived: false,
};

/**
 * Every value a query is matched against, in no particular order.
 *
 * Split out so the set is inspectable by a test rather than buried in a
 * predicate: a field that stops being searched should fail a test, not just
 * quietly stop being findable.
 */
export function searchableValues(
  row: SearchableInvestigation,
  entityLabels: readonly string[] = [],
): string[] {
  return [
    row.title,
    row.problemStatement,
    row.affectedParties,
    row.impact,
    row.scope,
    ...(row.openQuestions ?? []),
    row.reportedProblem ?? undefined,
    row.problem ?? undefined,
    row.summary ?? undefined,
    row.status,
    row.severity,
    // Recorded as literal text, so it is matched as literal text: someone
    // searching "2024-11" is looking for the month they were told about, not
    // for an instant this module would have to invent a time zone to compute.
    row.occurredAt ?? undefined,
    row.id,
    row.createdBy,
    row.createdByUsername ?? undefined,
    row.creator ?? undefined,
    ...(row.participants ?? []).map((participant) => participant.username),
    ...Object.values(row.investigationContext ?? {}),
    ...entityLabels,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Case-folded, whitespace-trimmed query. Empty means "no query". */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLocaleLowerCase();
}

export function matchesQuery(
  row: SearchableInvestigation,
  normalizedQuery: string,
  entityLabels: readonly string[] = [],
): boolean {
  if (!normalizedQuery) return true;
  return searchableValues(row, entityLabels).some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}

/**
 * Whether an archived row is admissible under this filter.
 *
 * Asking for the archived status explicitly always shows them: a filter that
 * refused the thing it was set to would be nonsense.
 */
export function admitsArchived(filter: InvestigationFilter): boolean {
  return filter.includeArchived || filter.status === ARCHIVED_STATUS;
}

export interface VisibleInvestigations<T> {
  visible: T[];
  /**
   * Archived rows withheld by this filter and nothing else — they match the
   * query and the entity, and are hidden only because they are archived. This
   * is what the surface offers to reveal, so it must not count rows the reader
   * was not looking for anyway.
   */
  hiddenArchived: number;
}

/**
 * Applies the whole filter, and reports what archiving withheld.
 *
 * `entityMembers` maps an entity id to the investigation ids it is involved
 * in. An installation without the record graph passes an empty map and the
 * entity filter simply never narrows anything.
 */
export function visibleInvestigations<T extends SearchableInvestigation>(
  rows: readonly T[],
  filter: InvestigationFilter,
  entityMembers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  entityLabelsFor: (row: T) => readonly string[] = () => [],
): VisibleInvestigations<T> {
  const normalizedQuery = normalizeQuery(filter.query);
  const showArchived = admitsArchived(filter);
  const visible: T[] = [];
  let hiddenArchived = 0;

  for (const row of rows) {
    if (filter.status !== "all" && row.status !== filter.status) continue;
    if (filter.entityId !== "all" && !entityMembers.get(filter.entityId)?.has(row.id)) continue;
    if (!matchesQuery(row, normalizedQuery, entityLabelsFor(row))) continue;
    if (row.status === ARCHIVED_STATUS && !showArchived) {
      hiddenArchived += 1;
      continue;
    }
    visible.push(row);
  }
  return { visible, hiddenArchived };
}

/**
 * Status counts for the filter control.
 *
 * Counted over everything, including archived, so the archived option always
 * states how many there are — a count that changed with the visibility toggle
 * would make the option that reveals them look empty.
 */
export function statusCounts(
  rows: readonly SearchableInvestigation[],
  known: readonly string[],
): [string, number][] {
  const tally = new Map<string, number>();
  for (const row of rows) {
    const status = row.status ?? "";
    if (!status) continue;
    tally.set(status, (tally.get(status) ?? 0) + 1);
  }
  const ordered: [string, number][] = known.map((status) => [status, tally.get(status) ?? 0]);
  for (const [status, count] of tally) {
    if (!known.includes(status)) ordered.push([status, count]);
  }
  return ordered;
}

/**
 * One sentence describing what the current filter is withholding, or null when
 * it is withholding nothing.
 *
 * Returned as copy rather than a boolean so the list has one place to say it
 * and the wording is testable.
 */
export function hiddenArchivedNotice(hiddenArchived: number): string | null {
  if (hiddenArchived < 1) return null;
  return hiddenArchived === 1
    ? "1 archived investigation is hidden."
    : `${hiddenArchived} archived investigations are hidden.`;
}
