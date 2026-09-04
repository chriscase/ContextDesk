import { useEffect, useMemo, useRef } from "react";
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
  /** Continue with the server-issued cursor without changing shell location. */
  readonly nextPage: () => void;
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
  const view = enabled
    ? selectResourceView(runtime.resources.investigationCollection)
    : { availability: "idle" } as const;
  const continuationPendingRef = useRef(false);
  const pendingInputKeyRef = useRef(inputKey);
  const activeCursor = runtime.resources.investigationCollectionQuery?.cursor ?? null;
  const collectionStatus = runtime.resources.investigationCollection.status;

  useEffect(() => {
    if (!enabled || pendingInputKeyRef.current !== inputKey) {
      continuationPendingRef.current = false;
      pendingInputKeyRef.current = inputKey;
      return;
    }
    if (
      continuationPendingRef.current
      && activeCursor !== null
      && (collectionStatus === "ready" || collectionStatus === "failed")
    ) {
      continuationPendingRef.current = false;
    }
  }, [activeCursor, collectionStatus, enabled, inputKey]);

  const nextPage = useMemo(() => {
    if (!enabled || command === undefined || command === null) {
      return () => undefined;
    }
    return () => {
      if (continuationPendingRef.current || view.availability !== "available" || view.value.nextCursor === null || view.refresh === "loading") return;
      continuationPendingRef.current = true;
      void command(Object.freeze({ ...input, cursor: view.value.nextCursor }));
    };
  }, [command, enabled, input, view]);

  useEffect(() => {
    if (!enabled) return;
    command(input);
  }, [command, enabled, input, inputKey]);

  return {
    enabled,
    input,
    view,
    refresh: enabled && command !== undefined && command !== null
      ? () => {
          if (view.availability === "available" && view.refresh === "loading") return;
          if (runtime.resources.investigationCollectionQuery?.cursor) {
            void command(input);
          } else {
            runtime.refresh.investigationCollection();
          }
        }
      : () => undefined,
    nextPage,
  };
}
