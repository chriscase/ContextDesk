/**
 * Presentation-only controls for the non-status collection facets.
 *
 * The Runtime owns the facet buckets and the shell owns the canonical query.
 * This component only reports a user's explicit selection; it never derives
 * a label, priority, ordering, or a new filter value.
 */
export interface CollectionFacetBucket {
  readonly key: string;
  readonly count: number;
}

export interface CollectionFacetGroup {
  readonly top: readonly CollectionFacetBucket[];
  readonly otherCount: number;
}

export interface CollectionFacetFiltersQuery {
  readonly entityId: string | null;
  readonly contributorId: string | null;
}

export interface CollectionFacetFiltersProps {
  readonly query: CollectionFacetFiltersQuery;
  readonly entity?: CollectionFacetGroup | undefined;
  readonly contributor?: CollectionFacetGroup | undefined;
  readonly onQueryChange: (next: {
    readonly entityId?: string | null;
    readonly contributorId?: string | null;
  }) => void;
}

interface FacetGroupProps {
  readonly label: string;
  readonly selected: string | null;
  readonly facet?: CollectionFacetGroup | undefined;
  readonly onSelect: (value: string | null) => void;
}

function FacetGroup({ label, selected, facet, onSelect }: FacetGroupProps) {
  const buckets = facet?.top ?? [];
  if (buckets.length === 0 && selected === null && (facet?.otherCount ?? 0) === 0) return null;
  const hasSelectedBucket = selected !== null && buckets.some(({ key }) => key === selected);
  const selectedLabel = selected !== null && !hasSelectedBucket ? (
    <button
      type="button"
      className="strategy-kit__facet-filter-chip"
      aria-pressed="true"
      onClick={() => onSelect(null)}
    >
      <span>{selected}</span> <span>(selected)</span>
    </button>
  ) : null;
  return (
    <fieldset className="strategy-kit__facet-filter-group">
      <legend>{label}</legend>
      <div className="strategy-kit__facet-filter-options">
        {selectedLabel}
        {buckets.map((bucket) => {
          const active = bucket.key === selected;
          return (
            <button
              key={bucket.key}
              type="button"
              className="strategy-kit__facet-filter-chip"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : bucket.key)}
            >
              <span>{bucket.key}</span>
              <strong>{bucket.count}</strong>
            </button>
          );
        })}
      </div>
      {facet && facet.otherCount > 0 ? (
        <p className="strategy-kit__facet-filter-more" role="status">
          {facet.otherCount} more {label.toLocaleLowerCase()} value{facet.otherCount === 1 ? " is" : "s are"} outside the top results.
        </p>
      ) : null}
    </fieldset>
  );
}

/** Server-backed entity and contributor filters shared by strategy surfaces. */
export function CollectionFacetFilters({
  query,
  entity,
  contributor,
  onQueryChange,
}: CollectionFacetFiltersProps) {
  const hasEntity = (entity?.top.length ?? 0) > 0 || (entity?.otherCount ?? 0) > 0 || query.entityId !== null;
  const hasContributor = (contributor?.top.length ?? 0) > 0 || (contributor?.otherCount ?? 0) > 0 || query.contributorId !== null;
  if (!hasEntity && !hasContributor) return null;
  const activeCount = Number(query.entityId !== null) + Number(query.contributorId !== null);
  return (
    <details className="strategy-kit__facet-filters">
      <summary>
        More filters{activeCount > 0 ? <span className="strategy-kit__facet-filter-count">{activeCount} active</span> : null}
      </summary>
      <p className="strategy-kit__facet-filter-help">
        Choose recorded values supplied by the server. These filters narrow the collection without assigning priority or changing its order.
      </p>
      <div className="strategy-kit__facet-filters-grid">
        <FacetGroup
          label="Entity"
          selected={query.entityId}
          facet={entity}
          onSelect={(entityId) => onQueryChange({ entityId })}
        />
        <FacetGroup
          label="Contributor"
          selected={query.contributorId}
          facet={contributor}
          onSelect={(contributorId) => onQueryChange({ contributorId })}
        />
      </div>
      {activeCount > 0 ? (
        <button
          type="button"
          className="strategy-kit__facet-filter-clear"
          onClick={() => onQueryChange({ entityId: null, contributorId: null })}
        >
          Clear advanced filters
        </button>
      ) : null}
    </details>
  );
}
