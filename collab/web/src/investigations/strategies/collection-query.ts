import { useEffect, useMemo } from "react";
import {
  selectResourceView,
  useInvestigationRuntime,
  type InvestigationCollectionQueryInput,
  type ResourceView,
  type InvestigationCollectionPageV1,
} from "../runtime/public.js";
import {
  DEFAULT_COLLECTION_QUERY,
  type CollectionQueryLocation,
} from "../../app-location.js";

export interface InvestigationCollectionQueryPresentation {
  readonly enabled: boolean;
  readonly input: InvestigationCollectionQueryInput;
  readonly view: ResourceView<InvestigationCollectionPageV1>;
  readonly refresh: () => void;
}

function inputForLocation(query: CollectionQueryLocation): InvestigationCollectionQueryInput {
  return Object.freeze({
    q: query.q,
    status: [...query.status],
    includeArchived: query.includeArchived,
    entityId: query.entityId,
    contributorId: query.contributorId,
    recordedFrom: query.recordedFrom,
    recordedTo: query.recordedTo,
  });
}

/**
 * Binds shell-owned list query state to the additive public Runtime V1 seam.
 * Strategies decide how to render the returned page and may fall back to the
 * legacy list when `enabled` is false; this helper never constructs URLs or
 * grants authority.
 */
export function useInvestigationCollectionQuery(
  locationQuery: CollectionQueryLocation | undefined,
): InvestigationCollectionQueryPresentation {
  const runtime = useInvestigationRuntime();
  const query = locationQuery ?? DEFAULT_COLLECTION_QUERY;
  const input = useMemo(() => inputForLocation(query), [
    query.contributorId,
    query.entityId,
    query.includeArchived,
    query.q,
    query.recordedFrom,
    query.recordedTo,
    query.status,
  ]);
  const inputKey = useMemo(() => JSON.stringify({
    q: input.q ?? "",
    status: input.status ?? [],
    includeArchived: input.includeArchived ?? false,
    entityId: input.entityId ?? null,
    contributorId: input.contributorId ?? null,
    recordedFrom: input.recordedFrom ?? null,
    recordedTo: input.recordedTo ?? null,
  }), [input]);
  const command = runtime.commands.queryInvestigations;
  const enabled = locationQuery !== undefined && command !== undefined && command !== null;

  useEffect(() => {
    if (!enabled) return;
    command(input);
  }, [command, enabled, input, inputKey]);

  return {
    enabled,
    input,
    view: enabled
      ? selectResourceView(runtime.resources.investigationCollection)
      : { availability: "idle" },
    refresh: runtime.refresh.investigationCollection,
  };
}
