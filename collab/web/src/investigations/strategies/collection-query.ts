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

const CONTRACT_DEFAULT_COLLECTION_LIMIT = 50;

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

/** Mirrors the Runtime contract's canonical query key with only cursor removed. */
function canonicalCollectionBaseKey(input: InvestigationCollectionQueryInput): string {
  const impactIdentity = input.impactIdentity ?? null;
  return JSON.stringify({
    q: (input.q ?? "").trim(),
    status: [...(input.status ?? [])].sort(),
    includeArchived: input.includeArchived ?? false,
    entityId: input.entityId ?? null,
    impactIdentity: impactIdentity === null
      ? null
      : {
          productName: impactIdentity.productName.trim(),
          version: impactIdentity.version.trim(),
          build: impactIdentity.build.trim(),
          component: impactIdentity.component.trim(),
          environment: impactIdentity.environment.trim(),
        },
    contributorId: input.contributorId ?? null,
    recordedFrom: input.recordedFrom ?? null,
    recordedTo: input.recordedTo ?? null,
    limit: input.limit === undefined || input.limit === 0
      ? CONTRACT_DEFAULT_COLLECTION_LIMIT
      : input.limit,
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
  const inputKey = useMemo(() => canonicalCollectionBaseKey(input), [input]);
  const command = runtime.commands.queryInvestigations;
  const enabled = locationQuery !== undefined && command !== undefined && command !== null;
  const view = enabled
    ? selectResourceView(runtime.resources.investigationCollection)
    : { availability: "idle" } as const;
  const continuationPendingRef = useRef(false);
  const pendingInputKeyRef = useRef(inputKey);
  const requestedInputKeyRef = useRef<string | null>(null);
  const inactiveRef = useRef(!enabled);
  const activeCursor = runtime.resources.investigationCollectionQuery?.cursor ?? null;
  const collectionStatus = runtime.resources.investigationCollection.status;
  const activeQueryRef = useRef(runtime.resources.investigationCollectionQuery);
  activeQueryRef.current = runtime.resources.investigationCollectionQuery;

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
      const activeQuery = activeQueryRef.current;
      if (
        view.refresh === "failed"
        && activeQuery !== null
        && activeQuery.cursor === view.value.nextCursor
        && canonicalCollectionBaseKey(activeQuery) === inputKey
      ) {
        runtime.refresh.investigationCollection();
        return;
      }
      void command(Object.freeze({ ...input, cursor: view.value.nextCursor }));
    };
  }, [command, enabled, input, inputKey, runtime.refresh.investigationCollection, view]);

  useEffect(() => {
    if (!enabled || command === undefined || command === null) {
      requestedInputKeyRef.current = null;
      inactiveRef.current = true;
      return;
    }
    if (requestedInputKeyRef.current === inputKey) return;
    requestedInputKeyRef.current = inputKey;
    const reentering = inactiveRef.current;
    inactiveRef.current = false;
    const activeQuery = activeQueryRef.current;
    if (
      reentering
      && activeQuery !== null
      && activeQuery.cursor === null
      && canonicalCollectionBaseKey(activeQuery) === inputKey
    ) {
      runtime.refresh.investigationCollection();
      return;
    }
    command(input);
  }, [command, enabled, input, inputKey, runtime.refresh.investigationCollection]);

  return {
    enabled,
    input,
    view,
    refresh: enabled && command !== undefined && command !== null
      ? () => {
          if (view.availability === "available" && view.refresh === "loading") return;
          const activeQuery = runtime.resources.investigationCollectionQuery;
          if (
            view.availability === "available"
            && view.refresh === "failed"
            && activeQuery?.cursor === view.value.nextCursor
            && canonicalCollectionBaseKey(activeQuery) === inputKey
          ) {
            runtime.refresh.investigationCollection();
          } else if (activeQuery?.cursor) {
            void command(input);
          } else {
            runtime.refresh.investigationCollection();
          }
        }
      : () => undefined,
    nextPage,
  };
}
