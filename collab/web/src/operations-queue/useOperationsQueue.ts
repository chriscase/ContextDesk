import { useEffect, useMemo, useRef, useState } from "react";
import type { OperationsQueueLocationQuery } from "../app-location.js";
import {
  selectResourceView,
  useInvestigationRuntime,
  type InvestigationOperationsQueuePageV1,
  type InvestigationOperationsQueueQueryInput,
  type ResourceView,
} from "../investigations/runtime/public.js";

export type OperationsQueueCommandAvailability = "available" | "absent" | "denied";

export interface OperationsQueuePresentation {
  readonly commandAvailability: OperationsQueueCommandAvailability;
  readonly view: ResourceView<InvestigationOperationsQueuePageV1>;
  readonly continuationFailed: boolean;
  readonly continuationInFlight: boolean;
  readonly refresh: () => void;
  readonly nextPage: () => void;
}

function inputForLocation(query: OperationsQueueLocationQuery): InvestigationOperationsQueueQueryInput {
  return Object.freeze({
    q: query.q,
    status: [...query.status],
    includeArchived: query.includeArchived,
    coordinationScope: query.coordinationScope,
  });
}

function baseKey(input: InvestigationOperationsQueueQueryInput): string {
  return JSON.stringify({
    q: (input.q ?? "").trim(),
    status: [...(input.status ?? [])].sort(),
    includeArchived: input.includeArchived ?? false,
    coordinationScope: input.coordinationScope ?? "all_visible",
  });
}

/**
 * Operations' only bridge to the public Runtime. The adapter never reads an
 * actor, sorts rows, derives counts, or places the opaque cursor in location
 * state; it only returns the server-owned projection and request truth.
 */
export function useOperationsQueue(
  locationQuery: OperationsQueueLocationQuery,
): OperationsQueuePresentation {
  const runtime = useInvestigationRuntime();
  const command = runtime.commands.queryOperationsQueue;
  const commandAvailability: OperationsQueueCommandAvailability = command === undefined
    ? "absent"
    : command === null
      ? "denied"
      : "available";
  const input = useMemo(() => inputForLocation(locationQuery), [
    locationQuery.coordinationScope,
    locationQuery.includeArchived,
    locationQuery.q,
    locationQuery.status,
  ]);
  const inputKey = useMemo(() => baseKey(input), [input]);
  const rawView = commandAvailability === "available"
    ? selectResourceView(runtime.resources.operationsQueue)
    : { availability: "idle" } as const;
  const activeQueryRef = useRef(runtime.resources.operationsQueueQuery);
  activeQueryRef.current = runtime.resources.operationsQueueQuery;
  const requestedKeyRef = useRef<string | null>(null);
  const continuationPendingRef = useRef(false);
  const [continuationInFlight, setContinuationInFlight] = useState(false);
  const activeQuery = runtime.resources.operationsQueueQuery;
  const activeQueryMatches = activeQuery !== null && baseKey(activeQuery) === inputKey;
  // A location change is authoritative immediately. Never publish rows or
  // counts from the previous query while the Runtime starts the new request.
  const view: ResourceView<InvestigationOperationsQueuePageV1> = commandAvailability === "available"
    ? activeQueryMatches
      ? rawView
      : { availability: "loading" }
    : { availability: "idle" };
  const continuationFailed = view.availability === "available"
    && view.refresh === "failed"
    && activeQueryMatches
    && activeQuery.cursor !== null;

  useEffect(() => {
    if (requestedKeyRef.current !== inputKey || commandAvailability !== "available") {
      continuationPendingRef.current = false;
      setContinuationInFlight(false);
      return;
    }
    if (
      continuationPendingRef.current
      && activeQueryMatches
      && activeQuery.cursor !== null
      && view.availability === "available"
      && view.refresh !== "loading"
    ) {
      continuationPendingRef.current = false;
      setContinuationInFlight(false);
    }
  }, [activeQuery, activeQueryMatches, commandAvailability, inputKey, view]);

  useEffect(() => {
    if (commandAvailability !== "available" || typeof command !== "function") {
      requestedKeyRef.current = null;
      continuationPendingRef.current = false;
      setContinuationInFlight(false);
      return;
    }
    if (requestedKeyRef.current === inputKey) return;
    requestedKeyRef.current = inputKey;
    const current = activeQueryRef.current;
    if (current !== null && current.cursor === null && baseKey(current) === inputKey) {
      runtime.refresh.operationsQueue();
      return;
    }
    command(input);
  }, [command, commandAvailability, input, inputKey, runtime.refresh.operationsQueue]);

  return {
    commandAvailability,
    view,
    continuationFailed,
    continuationInFlight,
    refresh: commandAvailability === "available" && typeof command === "function"
      ? () => {
          if (continuationPendingRef.current) return;
          const current = activeQueryRef.current;
          if (view.availability === "available" && view.refresh === "loading") return;
          if (current?.cursor) command(input);
          else runtime.refresh.operationsQueue();
        }
      : () => undefined,
    nextPage: commandAvailability === "available" && typeof command === "function"
      ? () => {
          if (
            continuationPendingRef.current
            || view.availability !== "available"
            || view.refresh === "loading"
          ) return;
          const cursor = view.value.nextCursor;
          if (cursor === null) return;
          const current = activeQueryRef.current;
          if (
            view.refresh === "failed"
            && current?.cursor === cursor
            && baseKey(current) === inputKey
          ) {
            continuationPendingRef.current = true;
            setContinuationInFlight(true);
            runtime.refresh.operationsQueue();
            return;
          }
          continuationPendingRef.current = true;
          setContinuationInFlight(true);
          command(Object.freeze({ ...input, cursor }));
        }
      : () => undefined,
  };
}
