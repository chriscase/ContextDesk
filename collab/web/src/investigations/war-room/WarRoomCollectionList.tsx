import type {
  CaseV1,
  InvestigationCollectionPageV1,
  ResourceView,
} from "../runtime/public.js";
import type { CollectionQueryLocation } from "../../app-location.js";

export interface WarRoomCollectionListProps {
  readonly page: ResourceView<InvestigationCollectionPageV1>;
  readonly query: CollectionQueryLocation;
  readonly canRead: boolean;
  readonly readOnly: boolean;
  readonly entityOptions?: readonly { id: string; label: string }[];
  readonly occurredFrom?: string;
  readonly onOccurredFromChange?: (value: string) => void;
  readonly onQueryChange?: (query: CollectionQueryLocation) => void;
  readonly onRefresh: () => void;
  readonly onOpenCase: (id: string) => void;
}

const STATUS_OPTIONS = ["open", "monitoring", "resolved", "archived"] as const;

function titleOf(item: CaseV1): string {
  return item.title.trim() || "Untitled investigation";
}

function recordedAt(item: CaseV1): string {
  return item.occurredAt || item.createdAt || "Date not recorded";
}

function updateQuery(
  query: CollectionQueryLocation,
  onQueryChange: WarRoomCollectionListProps["onQueryChange"],
  next: Partial<CollectionQueryLocation>,
) {
  onQueryChange?.({ ...query, ...next });
}

export function WarRoomCollectionList(props: WarRoomCollectionListProps) {
  const { page } = props;
  if (!props.canRead) {
    return (
      <section className="case-list" aria-label="Investigations">
        <p className="case-list__empty" role="status">
          Your account cannot read investigations, so no investigation data was requested.
        </p>
      </section>
    );
  }

  const status = props.query.status[0] ?? "all";
  const authoritativeItems = page.availability === "available" ? page.value.items : [];
  // `recordedFrom` is case creation time, not the investigation's observed
  // occurrence. Preserve the legacy control as an explicitly page-local,
  // stable subsequence until the public query contract gains occurredAt.
  const occurredFrom = props.occurredFrom ?? "";
  const items = occurredFrom
    ? authoritativeItems.filter((item) => (item.occurredAt ?? "") >= occurredFrom)
    : authoritativeItems;
  const hiddenArchivedCount = page.availability === "available"
    ? page.value.hiddenArchivedCount
    : 0;
  const statusFacets = page.availability === "available" ? page.value.facets.status.top : [];
  const entityFacets = page.availability === "available" ? page.value.facets.entity.top : [];
  const entityLabels = new Map((props.entityOptions ?? []).map((entity) => [entity.id, entity.label]));
  const selectedEntity = props.query.entityId;
  const selectableEntityFacets = selectedEntity && !entityFacets.some((facet) => facet.key === selectedEntity)
    ? [...entityFacets, { key: selectedEntity, count: null }]
    : entityFacets;
  const isLoading = page.availability === "idle" || page.availability === "loading";

  return (
    <section className="case-list" aria-label="Investigations">
      <div className="case-list__controls">
        <label className="case-list__search">
          <span className="case-list__control-label">Search</span>
          <input
            className="login__input"
            type="search"
            value={props.query.q}
            onChange={(event) => updateQuery(props.query, props.onQueryChange, { q: event.target.value })}
            placeholder="Title, problem, product, or build"
            aria-label="Search investigations by title, situation text, context, or ID"
          />
        </label>
        {selectableEntityFacets.length > 0 ? (
          <label className="case-list__filter">
            <span className="case-list__control-label">Entity</span>
            <select
              className="login__input"
              aria-label="Filter investigations by involved entity"
              value={selectedEntity ?? "all"}
              onChange={(event) => updateQuery(props.query, props.onQueryChange, {
                entityId: event.target.value === "all" ? null : event.target.value,
              })}
            >
              <option value="all">All entities</option>
              {selectableEntityFacets.map((facet) => (
                <option key={facet.key} value={facet.key}>
                  {entityLabels.get(facet.key) ?? facet.key}
                  {facet.count === null ? "" : ` (${facet.count})`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="case-list__filter">
          <span className="case-list__control-label">Observed from</span>
          <input
            className="login__input"
            type="date"
            aria-label="Filter investigations by observed date"
            value={occurredFrom}
            onChange={(event) => props.onOccurredFromChange?.(event.target.value)}
          />
          <span className="case-list__filter-note">Filters the investigations loaded on this page.</span>
        </label>
        <label className="case-list__filter">
          <span className="case-list__control-label">Status</span>
          <select
            className="login__input"
            aria-label="Filter investigations by status"
            value={status}
            onChange={(event) => {
              const value = event.target.value;
              updateQuery(props.query, props.onQueryChange, {
                status: value === "all" ? [] : [value as CollectionQueryLocation["status"][number]],
              });
            }}
          >
            <option value="all">All statuses</option>
            {STATUS_OPTIONS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="case-list__archived-toggle">
          <input
            type="checkbox"
            checked={props.query.includeArchived}
            onChange={(event) => updateQuery(props.query, props.onQueryChange, {
              includeArchived: event.target.checked,
            })}
          />
          <span>Include archived</span>
        </label>
      </div>
      {statusFacets.length > 0 ? (
        <div className="case-list__facets" aria-label="Recorded status counts">
          {statusFacets.map((facet) => (
            <button
              key={facet.key}
              type="button"
              aria-pressed={status === facet.key}
              onClick={() => updateQuery(props.query, props.onQueryChange, {
                status: status === facet.key ? [] : [facet.key as CollectionQueryLocation["status"][number]],
              })}
            >
              <span>{facet.key}</span> <strong>{facet.count}</strong>
            </button>
          ))}
        </div>
      ) : null}
      {hiddenArchivedCount > 0 ? (
        <p className="case-list__archived-notice" role="status">
          {hiddenArchivedCount} archived investigation{hiddenArchivedCount === 1 ? " is" : "s are"} hidden. Check “Include archived” to show them.
        </p>
      ) : null}
      {isLoading ? <p className="case-list__empty" role="status" aria-busy="true">Loading investigations…</p> : null}
      {page.availability === "unavailable" ? (
        <div className="case-list__empty" role="alert">
          <p>Investigation list unavailable right now. Your recorded data was not changed.</p>
          <button type="button" className="case-list__archived-reveal" onClick={props.onRefresh}>Retry</button>
        </div>
      ) : null}
      {page.availability === "available" && page.refresh === "failed" ? (
        <div className="case-list__empty" role="alert">
          <p>The latest refresh failed; the previously loaded list is still shown.</p>
          <button type="button" className="case-list__archived-reveal" onClick={props.onRefresh}>Retry</button>
        </div>
      ) : null}
      {page.availability === "available" && items.length === 0 ? (
        <p className="case-list__empty" role="status">
          {props.query.q || status !== "all" || selectedEntity || occurredFrom
            ? `No investigations match the current search or filter${occurredFrom ? " on this loaded page" : ""}.`
            : "No investigations have been recorded yet."}
        </p>
      ) : null}
      {page.availability === "available" && items.length > 0 ? (
        <ul className="case-list__items">
          {items.map((item) => (
            <li key={item.id} className="case-card">
              <div className="case-card__head">
                <button type="button" className="case-card__open" onClick={() => props.onOpenCase(item.id)}>
                  {titleOf(item)}
                </button>
                <span className={`status-pill status-pill--${item.status}`}>{item.status}</span>
                <span className={`severity-note severity-note--${item.severity}`}>
                  {item.severity} severity
                </span>
              </div>
              <p className="case-card__meta">
                <time dateTime={item.occurredAt ?? item.createdAt}>{recordedAt(item)}</time>
                {item.participants.length > 0 ? ` · ${item.participants.length} participant${item.participants.length === 1 ? "" : "s"}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
