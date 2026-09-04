import { useEffect, useMemo, useRef } from "react";
import {
  selectResourceView,
  useInvestigationRuntime,
  type InvestigationCollectionPageV1,
  type InvestigationCollectionQueryInput,
  type ResourceView,
} from "../runtime/public.js";
import type { CollectionQueryLocation } from "../../app-location.js";

export interface WarRoomCollectionQueryPresentation {
  readonly input: InvestigationCollectionQueryInput;
  readonly view: ResourceView<InvestigationCollectionPageV1>;
  readonly refresh: () => void;
  /** Continue with the server-issued opaque cursor without changing the URL. */
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
 * War Room's deliberately small bridge to the public collection seam.
 *
 * This adapter owns no URL state and does not import strategy helpers. The
 * shell remains the canonical query owner; the runtime remains the source of
 * page order, facets, archive counts, and request/error state.
 */
export function useWarRoomCollectionQuery(
  locationQuery: CollectionQueryLocation | undefined,
): WarRoomCollectionQueryPresentation {
  const runtime = useInvestigationRuntime();
  const input = useMemo(() => inputForLocation(locationQuery ?? {
    q: "",
    status: [],
    includeArchived: false,
    entityId: null,
    contributorId: null,
    recordedFrom: null,
    recordedTo: null,
  }), [
    locationQuery?.contributorId,
    locationQuery?.entityId,
    locationQuery?.includeArchived,
    locationQuery?.q,
    locationQuery?.recordedFrom,
    locationQuery?.recordedTo,
    locationQuery?.status,
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
  const enabled = locationQuery !== undefined && command !== null && command !== undefined;
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
    if (!enabled || command === null || command === undefined) {
      return () => undefined;
    }
    return () => {
      if (continuationPendingRef.current || view.availability !== "available" || view.value.nextCursor === null || view.refresh === "loading") return;
      continuationPendingRef.current = true;
      void command(Object.freeze({ ...input, cursor: view.value.nextCursor }));
    };
  }, [command, enabled, input, view]);

  useEffect(() => {
    if (!enabled || !command) return;
    void command(input);
  }, [command, enabled, input, inputKey]);

  return {
    input,
    view,
    refresh: enabled && command !== null && command !== undefined
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
