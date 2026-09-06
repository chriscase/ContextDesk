import type {
  InvestigationCoordinationActionSuccessV1,
  InvestigationCoordinationAction,
} from "@cd-collab/contracts/investigation-runtime";
import type {
  InvestigationOperationsQueuePageV1,
  InvestigationOperationsQueueQueryV1,
  InvestigationOperationsQueueRowV1,
} from "@cd-collab/contracts/investigation-operations-queue";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deepFreezeDto } from "../deep-freeze.js";
import type {
  ApplyCoordinationActionInput,
  CoordinationGatewayRequestOptions,
  InvestigationCoordinationGateway,
} from "../gateway.js";
import type { RuntimeFailure } from "../errors.js";
import type { CommandOutcome, MutationState, ResourceState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import { mutationScopeKey } from "./scoped-mutation-state.js";

export type NamedCoordinationParticipantAction = Extract<
  InvestigationCoordinationAction,
  "assign_participant" | "release_participant"
>;

export interface NamedCoordinationParticipantCommand {
  readonly investigationId: string;
  readonly action: NamedCoordinationParticipantAction;
  readonly targetIdentityId: string;
  readonly idempotencyKey: string;
  readonly clientTime?: string;
}

interface NamedCoordinationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly actorIdentityId: string;
  readonly queryKey: string;
  readonly requestGeneration: number;
  readonly investigationId: string;
  readonly revision: number;
}

interface RetainedNamedIntent {
  readonly scopeKey: string;
  readonly action: NamedCoordinationParticipantAction;
  readonly targetIdentityId: string;
  readonly idempotencyKey: string;
  readonly request: ApplyCoordinationActionInput;
}

export interface UseNamedCoordinationParticipantOptions {
  readonly gateway: InvestigationCoordinationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly actorIdentityId: string;
  readonly canRead: boolean;
  readonly canCoordinateParticipants: boolean;
  readonly readOnly: boolean;
  readonly queue: ResourceState<InvestigationOperationsQueuePageV1>;
  readonly query: InvestigationOperationsQueueQueryV1 | null;
  readonly requestGeneration: number;
  readonly onRefreshQueue: () => void;
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface NamedCoordinationParticipantController {
  readonly state: MutationState<InvestigationCoordinationActionSuccessV1>;
  readonly apply: (
    command: NamedCoordinationParticipantCommand,
  ) => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>;
}

function frozenOutcome<T>(outcome: CommandOutcome<T>): CommandOutcome<T> {
  return deepFreezeDto(outcome);
}

function queryKey(query: InvestigationOperationsQueueQueryV1 | null): string {
  return query === null ? "" : JSON.stringify(query);
}

function currentRow(
  queue: ResourceState<InvestigationOperationsQueuePageV1>,
  investigationId: string,
) {
  return queue.status === "ready"
    ? queue.value.items.find((item) => item.investigation.id === investigationId) ?? null
    : null;
}

function normalizedTarget(targetIdentityId: string): string {
  return targetIdentityId.normalize("NFKC").trim();
}

function isRecordedParticipant(
  row: InvestigationOperationsQueueRowV1,
  targetIdentityId: string,
): boolean {
  return row.investigation.participants.some(
    (participant) => participant.identityId === targetIdentityId,
  );
}

function isRecordedCoordinator(
  row: InvestigationOperationsQueueRowV1,
  targetIdentityId: string,
): boolean {
  return row.coordination.coordinator?.identityId === targetIdentityId;
}

function targetIsEligible(
  action: NamedCoordinationParticipantAction,
  row: InvestigationOperationsQueueRowV1,
  targetIdentityId: string,
): boolean {
  switch (action) {
    case "assign_participant":
      return isRecordedParticipant(row, targetIdentityId);
    case "release_participant":
      // Server cleanup may release an ineligible recorded holder; membership
      // is not required, only that the target is the visible coordinator.
      return isRecordedCoordinator(row, targetIdentityId);
  }
  const exhaustive: never = action;
  return exhaustive;
}

/**
 * Applies assign_participant/release_participant to a visible Operations Queue
 * row. This controller deliberately does not read the row's endpoint: the queue
 * page already contains the authoritative revision, recorded participants, and
 * coordinator. The protected gateway owns the only write transport.
 */
export function useNamedCoordinationParticipant({
  gateway,
  identityKey,
  authorityKey,
  actorIdentityId,
  canRead,
  canCoordinateParticipants,
  readOnly,
  queue,
  query,
  requestGeneration,
  onRefreshQueue,
  onScopeDenied,
}: UseNamedCoordinationParticipantOptions): NamedCoordinationParticipantController {
  const latestRef = useRef<UseNamedCoordinationParticipantOptions>({
    gateway,
    identityKey,
    authorityKey,
    actorIdentityId,
    canRead,
    canCoordinateParticipants,
    readOnly,
    queue,
    query,
    requestGeneration,
    onRefreshQueue,
    onScopeDenied,
  });
  latestRef.current = {
    gateway,
    identityKey,
    authorityKey,
    actorIdentityId,
    canRead,
    canCoordinateParticipants,
    readOnly,
    queue,
    query,
    requestGeneration,
    onRefreshQueue,
    onScopeDenied,
  };
  const mountedRef = useRef(true);
  const slotRef = useRef(new RequestSlot<NamedCoordinationScope>());
  const activeRef = useRef<RequestToken<NamedCoordinationScope> | null>(null);
  const retainedRef = useRef<RetainedNamedIntent | null>(null);
  const [state, setState] = useState<MutationState<InvestigationCoordinationActionSuccessV1>>({
    status: "idle",
  });
  const currentQueryKey = queryKey(query);
  const scopeKey = useMemo(
    () => mutationScopeKey([
      identityKey,
      authorityKey,
      actorIdentityId,
      currentQueryKey,
      String(requestGeneration),
      String(canRead),
      String(canCoordinateParticipants),
      String(readOnly),
    ]),
    [
      actorIdentityId,
      authorityKey,
      canCoordinateParticipants,
      canRead,
      currentQueryKey,
      identityKey,
      readOnly,
      requestGeneration,
    ],
  );

  useEffect(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    retainedRef.current = null;
    setState({ status: "idle" });
  }, [
    authorityKey,
    actorIdentityId,
    canCoordinateParticipants,
    canRead,
    currentQueryKey,
    identityKey,
    readOnly,
    requestGeneration,
  ]);

  useEffect(() => () => {
    mountedRef.current = false;
    slotRef.current.dispose();
    activeRef.current = null;
    retainedRef.current = null;
  }, []);

  const apply = useCallback(async (
    command: NamedCoordinationParticipantCommand,
  ): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    if (activeRef.current !== null) return frozenOutcome({ status: "ignored", reason: "busy" });
    const start = latestRef.current;
    if (
      start.actorIdentityId.length === 0
      || !start.canRead
      || !start.canCoordinateParticipants
      || start.readOnly
      || (command.action !== "assign_participant" && command.action !== "release_participant")
      || command.investigationId.trim().length === 0
      || command.idempotencyKey.trim().length === 0
    ) return frozenOutcome({ status: "ignored", reason: "not_ready" });
    const row = currentRow(start.queue, command.investigationId);
    if (row === null || row.coordination.investigationId !== command.investigationId) {
      return frozenOutcome({ status: "ignored", reason: "not_ready" });
    }
    let targetIdentityId: string;
    try {
      targetIdentityId = normalizedTarget(command.targetIdentityId);
    } catch {
      const error = deepFreezeDto({ kind: "unexpected" as const });
      setState({ status: "failed", error });
      return frozenOutcome({ status: "failed", error });
    }
    if (targetIdentityId.length === 0 || !targetIsEligible(command.action, row, targetIdentityId)) {
      return frozenOutcome({ status: "ignored", reason: "not_ready" });
    }
    const scope: NamedCoordinationScope = Object.freeze({
      identityKey: start.identityKey,
      authorityKey: start.authorityKey,
      actorIdentityId: start.actorIdentityId,
      queryKey: queryKey(start.query),
      requestGeneration: start.requestGeneration,
      investigationId: command.investigationId,
      revision: row.coordination.revision,
    });
    const currentScopeKey = mutationScopeKey([
      scopeKey,
      scope.investigationId,
      String(scope.revision),
    ]);
    const retained = retainedRef.current;
    let request: ApplyCoordinationActionInput;
    if (retained?.scopeKey === currentScopeKey && retained.idempotencyKey === command.idempotencyKey) {
      if (retained.action !== command.action || retained.targetIdentityId !== targetIdentityId) {
        const error = deepFreezeDto({
          kind: "input" as const,
          field: "idempotencyKey" as const,
          reason: "intent_mismatch" as const,
        });
        setState({ status: "failed", error });
        return frozenOutcome({ status: "failed", error });
      }
      request = retained.request;
    } else {
      request = deepFreezeDto({
        action: command.action,
        targetIdentityId,
        expectedRevision: scope.revision,
        idempotencyKey: command.idempotencyKey,
        ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
      });
      retainedRef.current = null;
    }
    const token = slotRef.current.begin(scope);
    activeRef.current = token;
    setState({ status: "running" });
    const isCurrent = (): boolean => {
      const latest = latestRef.current;
      return mountedRef.current
        && activeRef.current === token
        && slotRef.current.isCurrent(token)
        && latest.identityKey === scope.identityKey
        && latest.authorityKey === scope.authorityKey
        && latest.actorIdentityId === scope.actorIdentityId
        && latest.requestGeneration === scope.requestGeneration
        && queryKey(latest.query) === scope.queryKey
        && latest.canRead
        && latest.canCoordinateParticipants
        && !latest.readOnly
        && currentRow(latest.queue, scope.investigationId)?.coordination.revision === scope.revision;
    };
    try {
      const result = await start.gateway.applyCoordinationAction(
        scope.investigationId,
        request,
        { actorIdentityId: scope.actorIdentityId, signal: token.signal } satisfies CoordinationGatewayRequestOptions,
      );
      if (!isCurrent()) return frozenOutcome({ status: "ignored", reason: "stale" });
      if (!result.ok) {
        if (result.error.kind === "auth_lost") {
          start.onScopeDenied(scope.investigationId, result.error);
        }
        if (result.error.kind === "coordination_changed" || result.error.kind === "coordination_refused") {
          retainedRef.current = null;
          start.onRefreshQueue();
        } else if (result.error.kind === "unavailable" && result.error.reason === "commit_outcome_unknown") {
          retainedRef.current = deepFreezeDto({
            scopeKey: currentScopeKey,
            action: command.action,
            targetIdentityId,
            idempotencyKey: command.idempotencyKey,
            request,
          });
        }
        setState({ status: "failed", error: result.error });
        return frozenOutcome({ status: "failed", error: result.error });
      }
      retainedRef.current = null;
      start.onRefreshQueue();
      setState({ status: "succeeded", value: result.value });
      return frozenOutcome({ status: "succeeded", value: result.value });
    } catch {
      if (!isCurrent()) return frozenOutcome({ status: "ignored", reason: "stale" });
      const error = deepFreezeDto({ kind: "unexpected" as const });
      setState({ status: "failed", error });
      return frozenOutcome({ status: "failed", error });
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, [scopeKey]);

  return { state, apply };
}
