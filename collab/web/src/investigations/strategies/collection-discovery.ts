import {
  type CollectionQueryLocation,
} from "../../app-location.js";
import type { InvestigationCollectionPageV1 } from "../runtime/public.js";

type ImpactIdentity = NonNullable<CollectionQueryLocation["impactIdentity"]>;

/**
 * A shareable filter narrows the server collection. Archive inclusion widens
 * the same collection, so it does not by itself mean "nothing was recorded".
 */
export { shareableCollectionQuery } from "../../app-location.js";

export function shareableQueryNarrows(query: CollectionQueryLocation): boolean {
  return query.q.trim().length > 0
    || query.status.length > 0
    || query.entityId !== null
    || query.impactIdentity !== null
    || query.contributorId !== null
    || query.recordedFrom !== null
    || query.recordedTo !== null;
}

/**
 * Empty copy for a collection page. A narrowing filter, including contributor
 * or recorded-at alone, must not claim that nothing has been recorded.
 * `pageLocal` is only the War Room observed-date control, which filters the
 * already loaded page and is not the server recorded-at range.
 */
export function collectionEmptyMessage(
  narrows: boolean,
  options: { readonly pageLocal?: boolean; readonly canCreate?: boolean } = {},
): string {
  if (!narrows) return "No investigations have been recorded yet.";
  const where = options.pageLocal ? " on this loaded page" : "";
  const next = options.canCreate ? " Try a different search or create a new one." : "";
  return `No investigations match the current search or filter${where}.${next}`;
}

export function recordedDateInputValue(instant: string | null): string {
  if (instant === null || instant.length < 10) return "";
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Inclusive UTC start of the chosen calendar day. The server compares createdAt. */
export function recordedFromInstant(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  return `${date}T00:00:00.000Z`;
}

/** Inclusive UTC end of the chosen calendar day. The server compares createdAt. */
export function recordedToInstant(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  return `${date}T23:59:59.999Z`;
}

export function impactIdentityValue(identity: ImpactIdentity): string {
  return JSON.stringify({
    productName: identity.productName,
    version: identity.version,
    build: identity.build,
    component: identity.component,
    environment: identity.environment,
  });
}

export function impactIdentitiesEqual(
  left: ImpactIdentity | null,
  right: ImpactIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return impactIdentityValue(left) === impactIdentityValue(right);
}

export function impactOptionLabel(
  bucket: InvestigationCollectionPageV1["facets"]["impactIdentity"]["top"][number],
): string {
  const name = bucket.key.trim() || "Recorded software impact";
  return `${name} (${bucket.count})`;
}

/**
 * Neutral label from the structured identity the shell already holds.
 * It is not a facet count and it is not decoded from a display key.
 */
export function impactIdentityLabel(identity: ImpactIdentity): string {
  const parts = [
    identity.productName,
    identity.version,
    identity.build,
    identity.component,
    identity.environment,
  ].map((part) => part.trim()).filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : "Selected software impact";
}

export const RECORDED_RANGE_UTC_NOTE =
  "Recorded from and recorded to are the case creation time, not the observed occurrence. A date-only choice uses the UTC calendar day: from is 00:00:00.000Z and to is 23:59:59.999Z, including both endpoints. Daylight-saving transitions do not move these UTC bounds.";

export const OUTSIDE_TOP_FACET_NOTE = "not in the current top matches";

export type CollectionFilterId =
  | "q"
  | "status"
  | "includeArchived"
  | "entity"
  | "impact"
  | "contributor"
  | "recordedFrom"
  | "recordedTo";

export interface ActiveCollectionFilter {
  readonly id: CollectionFilterId;
  readonly label: string;
}

export function activeCollectionFilters(
  query: CollectionQueryLocation,
  entityLabels?: ReadonlyMap<string, string>,
): readonly ActiveCollectionFilter[] {
  const filters: ActiveCollectionFilter[] = [];
  if (query.q.trim().length > 0) filters.push({ id: "q", label: `Search: ${query.q.trim()}` });
  if (query.status.length > 0) {
    filters.push({ id: "status", label: `Status: ${query.status.join(", ")}` });
  }
  if (query.includeArchived) filters.push({ id: "includeArchived", label: "Include archived" });
  if (query.entityId !== null) {
    const label = entityLabels?.get(query.entityId) ?? query.entityId;
    filters.push({ id: "entity", label: `Entity: ${label}` });
  }
  if (query.impactIdentity !== null) {
    filters.push({
      id: "impact",
      label: `Software impact: ${impactIdentityLabel(query.impactIdentity)}`,
    });
  }
  if (query.contributorId !== null) {
    filters.push({ id: "contributor", label: `Contributor: ${query.contributorId}` });
  }
  if (query.recordedFrom !== null) {
    filters.push({
      id: "recordedFrom",
      label: `Recorded from ${recordedDateInputValue(query.recordedFrom) || query.recordedFrom} UTC`,
    });
  }
  if (query.recordedTo !== null) {
    filters.push({
      id: "recordedTo",
      label: `Recorded to ${recordedDateInputValue(query.recordedTo) || query.recordedTo} UTC`,
    });
  }
  return filters;
}

export function collectionQueryWithoutFilter(
  query: CollectionQueryLocation,
  id: CollectionFilterId,
): CollectionQueryLocation {
  switch (id) {
    case "q":
      return { ...query, q: "" };
    case "status":
      return { ...query, status: [] };
    case "includeArchived":
      return { ...query, includeArchived: false };
    case "entity":
      return { ...query, entityId: null };
    case "impact":
      return { ...query, impactIdentity: null };
    case "contributor":
      return { ...query, contributorId: null };
    case "recordedFrom":
      return { ...query, recordedFrom: null };
    case "recordedTo":
      return { ...query, recordedTo: null };
    default: {
      const unreachable: never = id;
      return unreachable;
    }
  }
}
