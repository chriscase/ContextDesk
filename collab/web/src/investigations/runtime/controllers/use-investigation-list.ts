import type {
  InvestigationCollectionPageV1,
  InvestigationCollectionQueryV1,
} from "@cd-collab/contracts/investigation-collection";
import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  investigationCollectionQueryKeyFromInput,
  parseInvestigationCollectionQueryInput,
  type InvestigationCollectionQueryGateway,
  type InvestigationCollectionQueryInput,
  type InvestigationGateway,
} from "../gateway.js";
import type { ResourceState } from "../types.js";
import { RequestSlot } from "./request-slot.js";
import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  succeedResourceLoad,
} from "./resource-state.js";

interface InvestigationListScope {
  readonly identityKey: string;
  readonly authorityKey: string;
}

export interface UseInvestigationListOptions {
  readonly gateway: InvestigationGateway;
  /** False when the current authority cannot read the investigation collection. */
  readonly enabled: boolean;
  /** Changes whenever the authenticated identity changes. */
  readonly identityKey: string;
  /** Changes whenever the effective capability/read-only projection changes. */
  readonly authorityKey: string;
}

export interface InvestigationListController {
  readonly investigations: ResourceState<readonly CaseV1[]>;
  /** Advances when an authoritative collection request begins. */
  readonly latestRequestGeneration: number;
  /**
   * Identifies the request that produced the last successful authoritative
   * snapshot. Local publication and failed refreshes never advance it.
   */
  readonly successfulSnapshotGeneration: number;
  /** Merge one server-confirmed investigation into the current published collection. */
  readonly publishInvestigation: (investigation: CaseV1) => void;
  readonly refresh: () => void;
}

function mergeInvestigation(
  investigations: readonly CaseV1[],
  investigation: CaseV1,
): readonly CaseV1[] {
  const existingIndex = investigations.findIndex(({ id }) => id === investigation.id);
  if (existingIndex === -1) return [investigation, ...investigations];
  return investigations.map((current, index) =>
    index === existingIndex ? investigation : current);
}

function publishIntoState<T>(
  state: ResourceState<T>,
  publish: (value: T) => T,
): ResourceState<T> {
  switch (state.status) {
    case "ready":
      return { status: "ready", value: publish(state.value) };
    case "loading":
      return state.previous === undefined
        ? state
        : { status: "loading", previous: publish(state.previous) };
    case "failed":
      return state.previous === undefined
        ? state
        : { status: "failed", error: state.error, previous: publish(state.previous) };
    case "idle":
      return state;
  }
}

/**
 * Owns the collection request lane independently of active-case routing.
 *
 * There is deliberately no `active` option: the mounted runtime may retain its
 * published collection while the shell temporarily leaves the investigation
 * surface. Authentication or authority changes still clear it immediately.
 */
export function useInvestigationList({
  gateway,
  enabled,
  identityKey,
  authorityKey,
}: UseInvestigationListOptions): InvestigationListController {
  const scope = useMemo<InvestigationListScope>(
    () => Object.freeze({ identityKey, authorityKey }),
    [identityKey, authorityKey],
  );
  const requestSlot = useRef(new RequestSlot<InvestigationListScope>());
  const [resource, setResource] = useState(() =>
    createResourceState<InvestigationListScope, readonly CaseV1[]>(),
  );
  const requestGenerationRef = useRef(0);
  const [latestRequest, setLatestRequest] = useState<{
    readonly key: InvestigationListScope | null;
    readonly generation: number;
  }>({ key: null, generation: 0 });
  const [successfulSnapshot, setSuccessfulSnapshot] = useState<{
    readonly key: InvestigationListScope | null;
    readonly generation: number;
  }>({ key: null, generation: 0 });
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (!enabled) {
      requestSlot.current.invalidate();
      setResource(createResourceState<InvestigationListScope, readonly CaseV1[]>());
      return;
    }

    const token = requestSlot.current.begin(scope);
    const requestGeneration = ++requestGenerationRef.current;
    setLatestRequest({ key: scope, generation: requestGeneration });
    setResource((current) => beginResourceLoad(current, scope));

    void gateway.listInvestigations({ signal: token.signal })
      .then((result) => {
        if (!requestSlot.current.isCurrent(token)) return;
        if (result.ok) {
          setResource((current) => succeedResourceLoad(current, scope, result.value));
          setSuccessfulSnapshot({
            key: scope,
            generation: requestGeneration,
          });
        } else {
          setResource((current) => failResourceLoad(current, scope, result.error));
        }
      })
      .catch(() => {
        if (!requestSlot.current.isCurrent(token)) return;
        setResource((current) => failResourceLoad(
          current,
          scope,
          { kind: "unexpected" },
        ));
      });

    return () => {
      requestSlot.current.invalidate();
    };
  }, [enabled, gateway, refreshGeneration, scope]);

  const publishInvestigation = useCallback((investigation: CaseV1) => {
    if (!enabled) return;
    setResource((current) => {
      if (current.key !== scope) return current;
      const state = publishIntoState(
        current.state,
        (investigations) => mergeInvestigation(investigations, investigation),
      );
      return state === current.state ? current : { key: scope, state };
    });
  }, [enabled, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  return {
    investigations: enabled && resource.key === scope ? resource.state : { status: "idle" },
    latestRequestGeneration:
      enabled && latestRequest.key === scope
        ? latestRequest.generation
        : 0,
    successfulSnapshotGeneration:
      enabled && successfulSnapshot.key === scope
        ? successfulSnapshot.generation
        : 0,
    publishInvestigation,
    refresh,
  };
}

interface InvestigationCollectionQueryScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly queryKey: string;
}

interface AccumulatedCollectionPage {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly queryKey: string;
  readonly page: InvestigationCollectionPageV1;
}

function collectionBaseQueryKey(query: InvestigationCollectionQueryV1): string {
  return investigationCollectionQueryKeyFromInput({
    q: query.q,
    status: query.status,
    includeArchived: query.includeArchived,
    entityId: query.entityId,
    impactIdentity: query.impactIdentity,
    contributorId: query.contributorId,
    recordedFrom: query.recordedFrom,
    recordedTo: query.recordedTo,
    limit: query.limit,
  }) ?? "invalid";
}

function accumulatedPage(
  previous: InvestigationCollectionPageV1,
  next: InvestigationCollectionPageV1,
): InvestigationCollectionPageV1 {
  const items = [...previous.items, ...next.items];
  Object.freeze(items);
  // Facets and the hidden-archive count are computed over the authorized
  // collection, not the individual cursor page. Keep the newest server
  // projection while accumulating only the ordered page items.
  return Object.freeze({
    ...next,
    items,
  });
}

export interface UseInvestigationCollectionQueryOptions {
  readonly gateway: InvestigationCollectionQueryGateway;
  /** False when the current authority cannot read the investigation collection. */
  readonly enabled: boolean;
  readonly identityKey: string;
  readonly authorityKey: string;
  /** Null until a query is requested; the controller never invents filters. */
  readonly query: InvestigationCollectionQueryInput | null;
}

export interface InvestigationCollectionQueryController {
  readonly page: ResourceState<InvestigationCollectionPageV1>;
  /** Canonical contract query for the active scope, or null when idle/invalid. */
  readonly query: InvestigationCollectionQueryV1 | null;
  readonly latestRequestGeneration: number;
  readonly successfulSnapshotGeneration: number;
  readonly refresh: () => void;
}

/**
 * Owns the versioned collection-query request lane independently of the
 * legacy unpaged list. State is keyed by canonical query + identity +
 * authority so a late page, cursor continuation, or refresh cannot publish
 * under a different request. This hook never mints a cursor or URL.
 */
export function useInvestigationCollectionQuery({
  gateway,
  enabled,
  identityKey,
  authorityKey,
  query,
}: UseInvestigationCollectionQueryOptions): InvestigationCollectionQueryController {
  const queryRef = useRef(query);
  queryRef.current = query;
  const queryKey = investigationCollectionQueryKeyFromInput(query);
  const parsed = useMemo(() => {
    const current = queryRef.current;
    return current === null ? null : parseInvestigationCollectionQueryInput(current);
  }, [queryKey]);
  const canonicalQuery = parsed !== null && parsed.ok ? parsed.value : null;
  const scope = useMemo<InvestigationCollectionQueryScope>(
    () => Object.freeze({
      identityKey,
      authorityKey,
      queryKey: queryKey ?? "",
    }),
    [authorityKey, identityKey, queryKey],
  );
  const requestSlot = useRef(new RequestSlot<InvestigationCollectionQueryScope>());
  const accumulatedPageRef = useRef<AccumulatedCollectionPage | null>(null);
  const [resource, setResource] = useState(() =>
    createResourceState<InvestigationCollectionQueryScope, InvestigationCollectionPageV1>(),
  );
  const requestGenerationRef = useRef(0);
  const [latestRequest, setLatestRequest] = useState<{
    readonly key: InvestigationCollectionQueryScope | null;
    readonly generation: number;
  }>({ key: null, generation: 0 });
  const [successfulSnapshot, setSuccessfulSnapshot] = useState<{
    readonly key: InvestigationCollectionQueryScope | null;
    readonly generation: number;
  }>({ key: null, generation: 0 });
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (!enabled || queryKey === null) {
      requestSlot.current.invalidate();
      accumulatedPageRef.current = null;
      setResource(createResourceState<
        InvestigationCollectionQueryScope,
        InvestigationCollectionPageV1
      >());
      return;
    }

    const token = requestSlot.current.begin(scope);
    const requestGeneration = ++requestGenerationRef.current;
    const baseQueryKey = parsed !== null && parsed.ok
      ? collectionBaseQueryKey(parsed.value)
      : "invalid";
    const prior = accumulatedPageRef.current;
    const previousPage = prior !== null
      && prior.identityKey === identityKey
      && prior.authorityKey === authorityKey
      && prior.queryKey === baseQueryKey
      ? prior.page
      : undefined;
    setLatestRequest({ key: scope, generation: requestGeneration });
    setResource((current) => previousPage === undefined
      ? beginResourceLoad(current, scope)
      : { key: scope, state: { status: "loading", previous: previousPage } });

    if (parsed === null || !parsed.ok) {
      const error = parsed === null ? { kind: "unexpected" as const } : parsed.error;
      setResource((current) => failResourceLoad(current, scope, error));
      return () => {
        requestSlot.current.invalidate();
      };
    }

    void gateway.queryInvestigations(parsed.value, { signal: token.signal })
      .then((result) => {
        if (!requestSlot.current.isCurrent(token)) return;
        if (result.ok) {
          const page = parsed.value.cursor !== null && previousPage !== undefined
            ? accumulatedPage(previousPage, result.value)
            : result.value;
          accumulatedPageRef.current = {
            identityKey,
            authorityKey,
            queryKey: baseQueryKey,
            page,
          };
          setResource((current) => succeedResourceLoad(current, scope, page));
          setSuccessfulSnapshot({
            key: scope,
            generation: requestGeneration,
          });
        } else {
          setResource((current) => failResourceLoad(current, scope, result.error));
        }
      })
      .catch(() => {
        if (!requestSlot.current.isCurrent(token)) return;
        setResource((current) => failResourceLoad(
          current,
          scope,
          { kind: "unexpected" },
        ));
      });

    return () => {
      requestSlot.current.invalidate();
    };
  }, [authorityKey, enabled, gateway, identityKey, parsed, queryKey, refreshGeneration, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  const visible = enabled && queryKey !== null && resource.key === scope;
  return {
    page: visible ? resource.state : { status: "idle" },
    query: visible && canonicalQuery !== null ? canonicalQuery : null,
    latestRequestGeneration:
      visible && latestRequest.key === scope
        ? latestRequest.generation
        : 0,
    successfulSnapshotGeneration:
      visible && successfulSnapshot.key === scope
        ? successfulSnapshot.generation
        : 0,
    refresh,
  };
}
