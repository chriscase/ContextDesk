import { useEffect, useMemo, useRef, useState } from "react";
import type { OperationsQueueLocationQuery } from "../app-location.js";
import {
  selectResourceView,
  useInvestigationRuntime,
  type CommandOutcome,
  type InvestigationCoordinationActionSuccessV1,
  type InvestigationNamedCoordinationParticipantCommand,
  type InvestigationNamedCoordinationSelfCommand,
  type InvestigationRuntimeIdentity,
  type InvestigationOperationsQueuePageV1,
  type InvestigationOperationsQueueQueryInput,
  type ResourceView,
} from "../investigations/runtime/public.js";

export type OperationsQueueCommandAvailability = "available" | "absent" | "denied";

export interface OperationsQueuePresentation {
  readonly identity: InvestigationRuntimeIdentity;
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
  readonly selfCoordination: OperationsQueueSelfCoordinationPresentation;
  readonly participantCoordination: OperationsQueueParticipantCoordinationPresentation;
}

export interface OperationsQueueSelfCoordinationPresentation {
  readonly available: boolean;
  readonly targetInvestigationId: string | null;
  readonly action: InvestigationNamedCoordinationSelfCommand["action"] | null;
  readonly state: ReturnType<typeof useInvestigationRuntime>["mutations"]["namedCoordinationSelf"];
  readonly apply: (
    investigationId: string,
    action: InvestigationNamedCoordinationSelfCommand["action"],
  ) => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>;
  readonly retry: () => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>;
}

export interface OperationsQueueParticipantCoordinationPresentation {
  readonly available: boolean;
  readonly targetInvestigationId: string | null;
  readonly action: InvestigationNamedCoordinationParticipantCommand["action"] | null;
  readonly targetIdentityId: string | null;
  /** Investigation ids whose participant actions were concealed for this query/scope. */
  readonly concealedInvestigationIds: readonly string[];
  readonly state: ReturnType<typeof useInvestigationRuntime>["mutations"]["namedCoordinationParticipant"];
  readonly apply: (
    investigationId: string,
    action: InvestigationNamedCoordinationParticipantCommand["action"],
    targetIdentityId: string,
  ) => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>;
  readonly retry: () => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>;
}

const EMPTY_CONCEALED_INVESTIGATION_IDS: readonly string[] = Object.freeze([]);
const PARTICIPANT_INTENT_MISMATCH = Object.freeze({
  status: "failed" as const,
  error: Object.freeze({
    kind: "input" as const,
    field: "idempotencyKey" as const,
    reason: "intent_mismatch" as const,
  }),
});

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
  const selfCommand = runtime.commands.applyNamedCoordinationSelf;
  const participantCommand = runtime.commands.applyNamedCoordinationParticipant;
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
  const selfIntentRef = useRef<{
    readonly investigationId: string;
    readonly action: InvestigationNamedCoordinationSelfCommand["action"];
    readonly idempotencyKey: string;
  } | null>(null);
  const [selfTarget, setSelfTarget] = useState<{
    readonly investigationId: string;
    readonly action: InvestigationNamedCoordinationSelfCommand["action"];
  } | null>(null);
  const participantIntentRef = useRef<{
    readonly investigationId: string;
    readonly action: InvestigationNamedCoordinationParticipantCommand["action"];
    readonly targetIdentityId: string;
    readonly idempotencyKey: string;
  } | null>(null);
  const [participantTarget, setParticipantTarget] = useState<{
    readonly investigationId: string;
    readonly action: InvestigationNamedCoordinationParticipantCommand["action"];
    readonly targetIdentityId: string;
  } | null>(null);
  const [concealedInvestigationIds, setConcealedInvestigationIds] = useState<readonly string[]>(
    EMPTY_CONCEALED_INVESTIGATION_IDS,
  );
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
    selfIntentRef.current = null;
    setSelfTarget(null);
    participantIntentRef.current = null;
    setParticipantTarget(null);
    setConcealedInvestigationIds(EMPTY_CONCEALED_INVESTIGATION_IDS);
  }, [inputKey, scopeToken]);

  const applySelf = useMemo(() => async (
    investigationId: string,
    action: InvestigationNamedCoordinationSelfCommand["action"],
  ): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    if (selfCommand === null) return { status: "ignored", reason: "not_ready" };
    if (runtime.mutations.namedCoordinationSelf.status === "running") {
      return { status: "ignored", reason: "busy" };
    }
    const previous = selfIntentRef.current;
    const intent = previous?.investigationId === investigationId && previous.action === action
      ? previous
      : {
          investigationId,
          action,
          idempotencyKey: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        };
    selfIntentRef.current = intent;
    setSelfTarget({ investigationId, action });
    const outcome = await selfCommand({
      investigationId,
      action,
      idempotencyKey: intent.idempotencyKey,
    });
    if (outcome.status === "succeeded"
      || (outcome.status === "failed"
        && !(outcome.error.kind === "unavailable" && outcome.error.reason === "commit_outcome_unknown"))) {
      selfIntentRef.current = null;
    }
    return outcome;
  }, [runtime.mutations.namedCoordinationSelf.status, selfCommand]);

  const retrySelf = useMemo(() => async (): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    const intent = selfIntentRef.current;
    if (intent === null) return { status: "ignored", reason: "not_ready" };
    return applySelf(intent.investigationId, intent.action);
  }, [applySelf]);

  const applyParticipant = useMemo(() => async (
    investigationId: string,
    action: InvestigationNamedCoordinationParticipantCommand["action"],
    targetIdentityId: string,
  ): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    if (participantCommand === null) return { status: "ignored", reason: "not_ready" };
    if (runtime.mutations.namedCoordinationParticipant.status === "running") {
      return { status: "ignored", reason: "busy" };
    }
    const previous = participantIntentRef.current;
    const sameIntent = previous !== null
      && previous.investigationId === investigationId
      && previous.action === action
      && previous.targetIdentityId === targetIdentityId;
    // A retained 503 freeze must keep its exact body and key. Alternate
    // action/target (including another row) is a local mismatch with zero POST.
    if (previous !== null && !sameIntent) {
      return PARTICIPANT_INTENT_MISMATCH;
    }
    const intent = sameIntent
      ? previous
      : {
          investigationId,
          action,
          targetIdentityId,
          idempotencyKey: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        };
    participantIntentRef.current = intent;
    setParticipantTarget({ investigationId, action, targetIdentityId });
    const outcome = await participantCommand({
      investigationId,
      action,
      targetIdentityId,
      idempotencyKey: intent.idempotencyKey,
    });
    if (outcome.status === "failed" && outcome.error.kind === "not_found") {
      setConcealedInvestigationIds((current) => (
        current.includes(investigationId)
          ? current
          : Object.freeze([...current, investigationId])
      ));
    }
    if (outcome.status === "ignored"
      || outcome.status === "succeeded"
      || (outcome.status === "failed"
        && !(outcome.error.kind === "unavailable" && outcome.error.reason === "commit_outcome_unknown"))) {
      participantIntentRef.current = null;
    }
    return outcome;
  }, [participantCommand, runtime.mutations.namedCoordinationParticipant.status]);

  const retryParticipant = useMemo(() => async (): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    const intent = participantIntentRef.current;
    if (intent === null) return { status: "ignored", reason: "not_ready" };
    return applyParticipant(intent.investigationId, intent.action, intent.targetIdentityId);
  }, [applyParticipant]);

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
    identity: runtime.identity,
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
    selfCoordination: {
      available: selfCommand !== null,
      targetInvestigationId: selfTarget?.investigationId ?? null,
      action: selfTarget?.action ?? null,
      state: runtime.mutations.namedCoordinationSelf,
      apply: applySelf,
      retry: retrySelf,
    },
    participantCoordination: {
      available: participantCommand !== null,
      targetInvestigationId: participantTarget?.investigationId ?? null,
      action: participantTarget?.action ?? null,
      targetIdentityId: participantTarget?.targetIdentityId ?? null,
      concealedInvestigationIds,
      state: runtime.mutations.namedCoordinationParticipant,
      apply: applyParticipant,
      retry: retryParticipant,
    },
  };
}
