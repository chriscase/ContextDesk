import type { CollectionQueryLocation } from "../../app-location.js";
import type { InvestigationCollectionPageV1 } from "../runtime/public.js";
import { useRef } from "react";
import {
  activeCollectionFilters,
  collectionQueryWithoutFilter,
  impactIdentitiesEqual,
  impactIdentityLabel,
  impactIdentityValue,
  impactOptionLabel,
  OUTSIDE_TOP_FACET_NOTE,
  RECORDED_RANGE_UTC_NOTE,
  recordedDateInputValue,
  recordedFromInstant,
  recordedToInstant,
  type CollectionFilterId,
} from "./collection-discovery.js";
import { DEFAULT_COLLECTION_QUERY } from "../../app-location.js";

type ImpactIdentity = NonNullable<CollectionQueryLocation["impactIdentity"]>;
type Facets = InvestigationCollectionPageV1["facets"];

export interface CollectionDiscoveryFiltersProps {
  readonly query: CollectionQueryLocation;
  readonly onQueryChange?: ((query: CollectionQueryLocation) => void) | undefined;
  /** Server page facets. Null while the page is not available; counts are never invented. */
  readonly facets: Facets | null;
  /** War Room already renders the entity control from these same facets. */
  readonly showEntity?: boolean;
  readonly entityLabels?: ReadonlyMap<string, string>;
  /** Operator-visible rejected-cursor restart. Empty when the page is ordinary. */
  readonly cursorRestartNotice?: string | null;
}

function changeQuery(
  query: CollectionQueryLocation,
  onQueryChange: CollectionDiscoveryFiltersProps["onQueryChange"],
  next: Partial<CollectionQueryLocation>,
) {
  onQueryChange?.({ ...query, ...next });
}

function selectedImpactValue(identity: ImpactIdentity | null): string {
  return identity === null ? "" : impactIdentityValue(identity);
}

export function CollectionDiscoveryFilters(props: CollectionDiscoveryFiltersProps) {
  const facets = props.facets;
  const impactFacets = facets?.impactIdentity.top ?? [];
  const contributorFacets = facets?.contributor.top ?? [];
  const entityFacets = facets?.entity.top ?? [];
  const selectedImpact = props.query.impactIdentity;
  const impactMissing = selectedImpact !== null
    && !impactFacets.some((bucket) => impactIdentitiesEqual(bucket.identity, selectedImpact));
  const selectedContributor = props.query.contributorId;
  const contributorMissing = selectedContributor !== null
    && !contributorFacets.some((bucket) => bucket.key === selectedContributor);
  const selectedEntity = props.query.entityId;
  const entityMissing = selectedEntity !== null
    && !entityFacets.some((bucket) => bucket.key === selectedEntity);
  const labels = props.entityLabels ?? new Map<string, string>();
  const active = activeCollectionFilters(props.query, labels);
  const groupRef = useRef<HTMLFieldSetElement>(null);

  function publish(next: CollectionQueryLocation) {
    props.onQueryChange?.(next);
    groupRef.current?.focus();
  }

  function clearOne(id: CollectionFilterId) {
    publish(collectionQueryWithoutFilter(props.query, id));
  }

  return (
    <fieldset
      ref={groupRef}
      className="collection-discovery"
      tabIndex={-1}
      aria-label="Collection filters"
    >
      <legend className="collection-discovery__legend">Collection filters</legend>
      <div className="collection-discovery__summary">
        <p className="collection-discovery__status" role="status">
          {active.length === 0
            ? "No collection filters are active."
            : `${active.length} collection ${active.length === 1 ? "filter is" : "filters are"} active.`}
        </p>
        {active.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className="collection-discovery__clear"
            onClick={() => clearOne(filter.id)}
          >
            {`Clear ${filter.label}`}
          </button>
        ))}
        {active.length > 0 ? (
          <button
            type="button"
            className="collection-discovery__clear"
            onClick={() => publish(DEFAULT_COLLECTION_QUERY)}
          >
            Clear all collection filters
          </button>
        ) : null}
      </div>
      {props.cursorRestartNotice ? (
        <p className="collection-discovery__status" role="status">{props.cursorRestartNotice}</p>
      ) : null}
      {props.showEntity ? (
        <label className="collection-discovery__field">
          <span>Entity</span>
          <select
            aria-label="Filter investigations by involved entity"
            value={selectedEntity ?? ""}
            onChange={(event) => changeQuery(props.query, props.onQueryChange, {
              entityId: event.target.value === "" ? null : event.target.value,
            })}
          >
            <option value="">All entities</option>
            {entityFacets.map((bucket) => (
              <option key={bucket.key} value={bucket.key}>
                {`${labels.get(bucket.key) ?? bucket.key} (${bucket.count})`}
              </option>
            ))}
            {entityMissing && selectedEntity !== null ? (
              <option value={selectedEntity}>{selectedEntity}</option>
            ) : null}
          </select>
          {facets && facets.entity.otherCount > 0 ? (
            <span className="collection-discovery__other">
              {`Other entities: ${facets.entity.otherCount}`}
            </span>
          ) : null}
        </label>
      ) : null}
      <label className="collection-discovery__field">
        <span>Software impact</span>
        <select
          aria-label="Filter investigations by software impact"
          value={selectedImpactValue(selectedImpact)}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "") {
              changeQuery(props.query, props.onQueryChange, { impactIdentity: null });
              return;
            }
            const match = impactFacets.find((bucket) => impactIdentityValue(bucket.identity) === value);
            const identity = match?.identity
              ?? (selectedImpact !== null && impactIdentityValue(selectedImpact) === value
                ? selectedImpact
                : null);
            if (identity === null) return;
            changeQuery(props.query, props.onQueryChange, {
              impactIdentity: {
                productName: identity.productName,
                version: identity.version,
                build: identity.build,
                component: identity.component,
                environment: identity.environment,
              },
            });
          }}
        >
          <option value="">All software impact</option>
          {impactFacets.map((bucket) => (
            <option key={impactIdentityValue(bucket.identity)} value={impactIdentityValue(bucket.identity)}>
              {impactOptionLabel(bucket)}
            </option>
          ))}
          {impactMissing && selectedImpact !== null ? (
            <option value={impactIdentityValue(selectedImpact)}>
              {`${impactIdentityLabel(selectedImpact)} (${OUTSIDE_TOP_FACET_NOTE})`}
            </option>
          ) : null}
        </select>
        {facets && facets.impactIdentity.otherCount > 0 ? (
          <span className="collection-discovery__other">
            {`Other software impact identities: ${facets.impactIdentity.otherCount}`}
          </span>
        ) : null}
      </label>
      <label className="collection-discovery__field">
        <span>Contributor</span>
        <select
          aria-label="Filter investigations by contributor"
          value={selectedContributor ?? ""}
          onChange={(event) => changeQuery(props.query, props.onQueryChange, {
            contributorId: event.target.value === "" ? null : event.target.value,
          })}
        >
          <option value="">All contributors</option>
          {contributorFacets.map((bucket) => (
            <option key={bucket.key} value={bucket.key}>
              {`${bucket.key} (${bucket.count})`}
            </option>
          ))}
          {contributorMissing && selectedContributor !== null ? (
            <option value={selectedContributor}>
              {`${selectedContributor} (${OUTSIDE_TOP_FACET_NOTE})`}
            </option>
          ) : null}
        </select>
        {facets && facets.contributor.otherCount > 0 ? (
          <span className="collection-discovery__other">
            {`Other contributors: ${facets.contributor.otherCount}`}
          </span>
        ) : null}
      </label>
      <label className="collection-discovery__field">
        <span>Recorded from</span>
        <input
          type="date"
          aria-label="Filter investigations by recorded date from"
          value={recordedDateInputValue(props.query.recordedFrom)}
          onChange={(event) => changeQuery(props.query, props.onQueryChange, {
            recordedFrom: recordedFromInstant(event.target.value),
          })}
        />
        <span className="collection-discovery__note">{RECORDED_RANGE_UTC_NOTE}</span>
      </label>
      <label className="collection-discovery__field">
        <span>Recorded to</span>
        <input
          type="date"
          aria-label="Filter investigations by recorded date to"
          value={recordedDateInputValue(props.query.recordedTo)}
          onChange={(event) => changeQuery(props.query, props.onQueryChange, {
            recordedTo: recordedToInstant(event.target.value),
          })}
        />
      </label>
    </fieldset>
  );
}
