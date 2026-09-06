import type {
  InvestigationCoordinationActionSuccessV1,
  InvestigationCoordinationAction,
} from "@cd-collab/contracts/investigation-runtime";
import type {
  InvestigationOperationsQueuePageV1,
  InvestigationOperationsQueueQueryV1,
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

export type NamedCoordinationSelfAction = Extract<InvestigationCoordinationAction, "claim_self" | "release_self">;

export interface NamedCoordinationSelfCommand {
  readonly investigationId: string;
  readonly action: NamedCoordinationSelfAction;
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
  readonly action: NamedCoordinationSelfAction;
  readonly idempotencyKey: string;
  readonly request: ApplyCoordinationActionInput;
}

export interface UseNamedCoordinationSelfOptions {
  readonly gateway: InvestigationCoordinationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly actorIdentityId: string;
  readonly canRead: boolean;
  readonly canCoordinateSelf: boolean;
  readonly readOnly: boolean;
  readonly queue: ResourceState<InvestigationOperationsQueuePageV1>;
  readonly query: InvestigationOperationsQueueQueryV1 | null;
  readonly requestGeneration: number;
  readonly onRefreshQueue: () => void;
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface NamedCoordinationSelfController {
  readonly state: MutationState<InvestigationCoordinationActionSuccessV1>;
  readonly apply: (
    command: NamedCoordinationSelfCommand,
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

/**
 * Applies claim_self/release_self to a visible Operations Queue row. This
 * controller deliberately does not read the row's endpoint: the queue page
 * already contains the authoritative revision and the protected gateway owns
 * the only write transport.
 */
export function useNamedCoordinationSelf({
  gateway,
  identityKey,
  authorityKey,
  actorIdentityId,
  canRead,
  canCoordinateSelf,
  readOnly,
  queue,
  query,
  requestGeneration,
  onRefreshQueue,
  onScopeDenied,
}: UseNamedCoordinationSelfOptions): NamedCoordinationSelfController {
  const latestRef = useRef<UseNamedCoordinationSelfOptions>({
    gateway,
    identityKey,
    authorityKey,
    actorIdentityId,
    canRead,
    canCoordinateSelf,
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
    canCoordinateSelf,
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
      String(canCoordinateSelf),
      String(readOnly),
    ]),
    [actorIdentityId, authorityKey, canCoordinateSelf, canRead, currentQueryKey, identityKey, readOnly, requestGeneration],
  );

  useEffect(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    retainedRef.current = null;
    setState({ status: "idle" });
  }, [authorityKey, actorIdentityId, canCoordinateSelf, canRead, currentQueryKey, identityKey, readOnly, requestGeneration]);

  useEffect(() => () => {
    mountedRef.current = false;
    slotRef.current.dispose();
    activeRef.current = null;
    retainedRef.current = null;
  }, []);

  const apply = useCallback(async (
    command: NamedCoordinationSelfCommand,
  ): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    if (activeRef.current !== null) return frozenOutcome({ status: "ignored", reason: "busy" });
    const start = latestRef.current;
    if (
      start.actorIdentityId.length === 0
      || !start.canRead
      || !start.canCoordinateSelf
      || start.readOnly
      || (command.action !== "claim_self" && command.action !== "release_self")
      || command.investigationId.trim().length === 0
      || command.idempotencyKey.trim().length === 0
    ) return frozenOutcome({ status: "ignored", reason: "not_ready" });
    const row = currentRow(start.queue, command.investigationId);
    if (row === null || row.coordination.investigationId !== command.investigationId) {
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
      if (retained.action !== command.action) {
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
        && latest.canCoordinateSelf
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
        if (result.error.kind === "auth_lost" || result.error.kind === "not_found") {
          start.onScopeDenied(scope.investigationId, result.error);
        }
        if (result.error.kind === "coordination_changed" || result.error.kind === "coordination_refused") {
          retainedRef.current = null;
          start.onRefreshQueue();
        } else if (result.error.kind === "unavailable" && result.error.reason === "commit_outcome_unknown") {
          retainedRef.current = deepFreezeDto({
            scopeKey: currentScopeKey,
            action: command.action,
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
