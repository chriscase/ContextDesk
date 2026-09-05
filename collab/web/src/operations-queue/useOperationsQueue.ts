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
  /** Opaque adapter scope; changes with Runtime identity/authority command identity. */
  readonly scopeToken: object;
  readonly commandAvailability: OperationsQueueCommandAvailability;
  readonly view: ResourceView<InvestigationOperationsQueuePageV1>;
  readonly continuationFailed: boolean;
  readonly continuationInFlight: boolean;
  /** Monotonic within the current location query; changes only when a continuation settles. */
  readonly continuationOutcome: number;
  /** Scope-local Runtime request generation used only to settle explicit UI attempts. */
  readonly requestGeneration: number;
  readonly refresh: () => void;
  readonly nextPage: () => void;
}

interface ContinuationAttempt {
  readonly id: number;
  readonly baselineRequestGeneration: number;
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
  const scopeToken = useMemo(() => Object.freeze({}), [command]);
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
  const requestedCommandRef = useRef(command);
  const continuationPendingRef = useRef(false);
  const continuationAttemptRef = useRef(0);
  const pendingContinuationAttemptRef = useRef<ContinuationAttempt | null>(null);
  const [continuationInFlight, setContinuationInFlight] = useState(false);
  const [continuationOutcome, setContinuationOutcome] = useState(0);
  const activeQuery = runtime.resources.operationsQueueQuery;
  const requestGeneration = runtime.resources.operationsQueueRequestGeneration;
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
    if (
      requestedKeyRef.current !== inputKey
      || requestedCommandRef.current !== command
      || commandAvailability !== "available"
    ) {
      continuationPendingRef.current = false;
      pendingContinuationAttemptRef.current = null;
      setContinuationInFlight(false);
      setContinuationOutcome(0);
      return;
    }
    if (
      continuationPendingRef.current
      && activeQueryMatches
      && activeQuery.cursor !== null
      && pendingContinuationAttemptRef.current !== null
      && requestGeneration > pendingContinuationAttemptRef.current.baselineRequestGeneration
      && (
        view.availability === "unavailable"
        || (view.availability === "available" && view.refresh !== "loading")
      )
    ) {
      continuationPendingRef.current = false;
      const settledAttempt = pendingContinuationAttemptRef.current.id;
      pendingContinuationAttemptRef.current = null;
      setContinuationInFlight(false);
      setContinuationOutcome(settledAttempt);
    }
  }, [activeQuery, activeQueryMatches, command, commandAvailability, inputKey, requestGeneration, view]);

  useEffect(() => {
    if (commandAvailability !== "available" || typeof command !== "function") {
      requestedKeyRef.current = null;
      requestedCommandRef.current = command;
      continuationPendingRef.current = false;
      pendingContinuationAttemptRef.current = null;
      setContinuationInFlight(false);
      setContinuationOutcome(0);
      return;
    }
    if (requestedKeyRef.current === inputKey && requestedCommandRef.current === command) return;
    requestedKeyRef.current = inputKey;
    requestedCommandRef.current = command;
    const current = activeQueryRef.current;
    if (current !== null && current.cursor === null && baseKey(current) === inputKey) {
      runtime.refresh.operationsQueue();
      return;
    }
    command(input);
  }, [command, commandAvailability, input, inputKey, runtime.refresh.operationsQueue]);

  return {
    scopeToken,
    commandAvailability,
    view,
    continuationFailed,
    continuationInFlight: requestedCommandRef.current === command && continuationInFlight,
    continuationOutcome: requestedCommandRef.current === command ? continuationOutcome : 0,
    requestGeneration,
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
            pendingContinuationAttemptRef.current = {
              id: ++continuationAttemptRef.current,
              baselineRequestGeneration: requestGeneration,
            };
            setContinuationInFlight(true);
            runtime.refresh.operationsQueue();
            return;
          }
          continuationPendingRef.current = true;
          pendingContinuationAttemptRef.current = {
            id: ++continuationAttemptRef.current,
            baselineRequestGeneration: requestGeneration,
          };
          setContinuationInFlight(true);
          command(Object.freeze({ ...input, cursor }));
        }
      : () => undefined,
  };
}
