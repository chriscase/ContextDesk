import type { CollectionQueryLocation } from "../../../app-location.js";
import type { InvestigationCollectionPageV1 } from "../../runtime/public.js";

type ImpactIdentity = NonNullable<CollectionQueryLocation["impactIdentity"]>;

/**
 * A shareable filter narrows the server collection. Archive inclusion widens
 * the same collection, so it does not by itself mean "nothing was recorded".
 */
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
