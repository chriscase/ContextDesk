import type {
  InvestigationOperationsQueuePageV1,
  InvestigationOperationsQueueQueryV1,
} from "@cd-collab/contracts/investigation-operations-queue";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  investigationOperationsQueueQueryKeyFromInput,
  parseInvestigationOperationsQueueQueryInput,
  type InvestigationOperationsQueueGateway,
  type InvestigationOperationsQueueQueryInput,
} from "../gateway.js";
import type { ResourceState } from "../types.js";
import { RequestSlot } from "./request-slot.js";
import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  succeedResourceLoad,
} from "./resource-state.js";

interface OperationsQueueScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly queryKey: string;
}

interface AccumulatedOperationsQueuePage {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly queryKey: string;
  readonly page: InvestigationOperationsQueuePageV1;
}

function baseQueryKey(query: InvestigationOperationsQueueQueryV1): string {
  return investigationOperationsQueueQueryKeyFromInput({
    q: query.q,
    status: query.status,
    includeArchived: query.includeArchived,
    entityId: query.entityId,
    impactIdentity: query.impactIdentity,
    contributorId: query.contributorId,
    recordedFrom: query.recordedFrom,
    recordedTo: query.recordedTo,
    coordinationScope: query.coordinationScope,
    limit: query.limit,
  }) ?? "invalid";
}

function accumulatedPage(
  previous: InvestigationOperationsQueuePageV1,
  next: InvestigationOperationsQueuePageV1,
): InvestigationOperationsQueuePageV1 {
  const items = [...previous.items, ...next.items];
  Object.freeze(items);
  // The server owns order, cursors, facets, archive visibility, and scope
  // counts. Only the already ordered rows accumulate across cursor pages.
  return Object.freeze({ ...next, items });
}

export interface UseInvestigationOperationsQueueOptions {
  readonly gateway: InvestigationOperationsQueueGateway;
  readonly enabled: boolean;
  readonly identityKey: string;
  readonly authorityKey: string;
  /** Null until presentation explicitly requests the queue. */
  readonly query: InvestigationOperationsQueueQueryInput | null;
}

export interface InvestigationOperationsQueueController {
  readonly page: ResourceState<InvestigationOperationsQueuePageV1>;
  readonly query: InvestigationOperationsQueueQueryV1 | null;
  readonly latestRequestGeneration: number;
  readonly successfulSnapshotGeneration: number;
  readonly refresh: () => void;
}

/**
 * Owns an explicit, read-only Operations Queue request lane. The lane never
 * infers the actor, filters rows, derives counts, sorts, or decodes a cursor.
 */
export function useInvestigationOperationsQueue({
  gateway,
  enabled,
  identityKey,
  authorityKey,
  query,
}: UseInvestigationOperationsQueueOptions): InvestigationOperationsQueueController {
  const queryRef = useRef(query);
  queryRef.current = query;
  const queryKey = investigationOperationsQueueQueryKeyFromInput(query);
  const parsed = useMemo(() => {
    const current = queryRef.current;
    return current === null ? null : parseInvestigationOperationsQueueQueryInput(current);
  }, [queryKey]);
  const canonicalQuery = parsed !== null && parsed.ok ? parsed.value : null;
  const scope = useMemo<OperationsQueueScope>(
    () => Object.freeze({ identityKey, authorityKey, queryKey: queryKey ?? "" }),
    [authorityKey, identityKey, queryKey],
  );
  const requestSlot = useRef(new RequestSlot<OperationsQueueScope>());
  const accumulatedPageRef = useRef<AccumulatedOperationsQueuePage | null>(null);
  const [resource, setResource] = useState(() =>
    createResourceState<OperationsQueueScope, InvestigationOperationsQueuePageV1>(),
  );
  const requestGenerationRef = useRef<{
    readonly identityKey: string;
    readonly authorityKey: string;
    readonly queryKey: string;
    readonly generation: number;
  } | null>(null);
  const [latestRequest, setLatestRequest] = useState<{
    readonly key: OperationsQueueScope | null;
    readonly generation: number;
  }>({ key: null, generation: 0 });
  const [successfulSnapshot, setSuccessfulSnapshot] = useState<{
    readonly key: OperationsQueueScope | null;
    readonly generation: number;
  }>({ key: null, generation: 0 });
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (!enabled || queryKey === null) {
      requestSlot.current.invalidate();
      requestGenerationRef.current = null;
      accumulatedPageRef.current = null;
      setResource(createResourceState<OperationsQueueScope, InvestigationOperationsQueuePageV1>());
      return;
    }

    const currentBaseQueryKey = parsed !== null && parsed.ok
      ? baseQueryKey(parsed.value)
      : queryKey;
    const token = requestSlot.current.begin(scope);
    const previousGeneration = requestGenerationRef.current;
    const requestGeneration = previousGeneration !== null
        && previousGeneration.identityKey === identityKey
        && previousGeneration.authorityKey === authorityKey
        && previousGeneration.queryKey === currentBaseQueryKey
      ? previousGeneration.generation + 1
      : 1;
    requestGenerationRef.current = {
      identityKey,
      authorityKey,
      queryKey: currentBaseQueryKey,
      generation: requestGeneration,
    };
    const prior = accumulatedPageRef.current;
    const previousPage = prior !== null
      && prior.identityKey === identityKey
      && prior.authorityKey === authorityKey
      && prior.queryKey === currentBaseQueryKey
      ? prior.page
      : undefined;
    setLatestRequest({ key: scope, generation: requestGeneration });
    setResource((current) => previousPage === undefined
      ? beginResourceLoad(current, scope)
      : { key: scope, state: { status: "loading", previous: previousPage } });

    if (parsed === null || !parsed.ok) {
      const error = parsed === null ? { kind: "unexpected" as const } : parsed.error;
      setResource((current) => failResourceLoad(current, scope, error));
      return () => requestSlot.current.invalidate();
    }

    void gateway.queryOperationsQueue(parsed.value, { signal: token.signal })
      .then((result) => {
        if (!requestSlot.current.isCurrent(token)) return;
        if (result.ok) {
          const page = parsed.value.cursor !== null && previousPage !== undefined
            ? accumulatedPage(previousPage, result.value)
            : result.value;
          accumulatedPageRef.current = {
            identityKey,
            authorityKey,
            queryKey: currentBaseQueryKey,
            page,
          };
          setResource((current) => succeedResourceLoad(current, scope, page));
          setSuccessfulSnapshot({ key: scope, generation: requestGeneration });
        } else {
          // A concealed resource must also evict the private accumulated-page
          // cache. Otherwise a later retry could republish rows that the
          // current request is no longer allowed to reveal.
          if (result.error.kind === "not_found" || result.error.kind === "auth_lost") {
            accumulatedPageRef.current = null;
          }
          setResource((current) => failResourceLoad(current, scope, result.error));
        }
      })
      .catch(() => {
        if (!requestSlot.current.isCurrent(token)) return;
        setResource((current) => failResourceLoad(current, scope, { kind: "unexpected" }));
      });

    return () => requestSlot.current.invalidate();
  }, [authorityKey, enabled, gateway, identityKey, parsed, queryKey, refreshGeneration, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  const visible = enabled && queryKey !== null && resource.key === scope;
  return {
    page: visible ? resource.state : { status: "idle" },
    query: visible && canonicalQuery !== null ? canonicalQuery : null,
    latestRequestGeneration: visible && latestRequest.key === scope
      ? latestRequest.generation
      : 0,
    successfulSnapshotGeneration: visible && successfulSnapshot.key === scope
      ? successfulSnapshot.generation
      : 0,
    refresh,
  };
}
