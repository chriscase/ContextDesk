import {
  INVESTIGATION_COORDINATION_ACTIONS,
  type InvestigationCoordinationAction,
  type InvestigationCoordinationActionSuccessV1,
  type InvestigationCoordinationV1,
} from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deepFreezeDto } from "../deep-freeze.js";
import type { RuntimeFailure } from "../errors.js";
import type {
  ApplyCoordinationActionInput,
  InvestigationCoordinationGateway,
} from "../gateway.js";
import type { CommandOutcome, MutationState, ResourceState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
} from "./scoped-mutation-state.js";

export type InvestigationCoordinationCommand =
  | {
      readonly action: "claim_self" | "release_self";
      readonly targetIdentityId?: never;
      readonly idempotencyKey: string;
      readonly clientTime?: string;
    }
  | {
      readonly action: "assign_participant" | "release_participant";
      readonly targetIdentityId: string;
      readonly idempotencyKey: string;
      readonly clientTime?: string;
    };

interface CoordinationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly actorIdentityId: string;
  readonly investigationId: string;
}

interface RetainedIntent {
  readonly scopeKey: string;
  readonly action: InvestigationCoordinationAction;
  readonly targetIdentityId: string | null;
  readonly idempotencyKey: string;
  readonly request: ApplyCoordinationActionInput;
}

export interface UseInvestigationCoordinationOptions {
  readonly gateway: InvestigationCoordinationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly actorIdentityId: string;
  readonly investigationId: string | null;
  readonly active: boolean;
  readonly canRead: boolean;
  readonly canCoordinateSelf: boolean;
  readonly canCoordinateParticipants: boolean;
  readonly readOnly: boolean;
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface InvestigationCoordinationController {
  readonly coordination: ResourceState<InvestigationCoordinationV1>;
  readonly state: MutationState<InvestigationCoordinationActionSuccessV1>;
  readonly refresh: () => void;
  readonly apply: (
    command: InvestigationCoordinationCommand,
  ) => Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>>;
}

function mayApply(
  action: InvestigationCoordinationAction,
  canCoordinateSelf: boolean,
  canCoordinateParticipants: boolean,
): boolean {
  switch (action) {
    case "claim_self":
    case "release_self":
      return canCoordinateSelf;
    case "assign_participant":
    case "release_participant":
      return canCoordinateParticipants;
  }
  const exhaustive: never = action;
  return exhaustive;
}

function normalizedTarget(command: InvestigationCoordinationCommand): string | null {
  switch (command.action) {
    case "claim_self":
    case "release_self":
      return null;
    case "assign_participant":
    case "release_participant":
      return command.targetIdentityId.normalize("NFKC").trim();
  }
  const exhaustive: never = command;
  return exhaustive;
}

const ACTION_SET: ReadonlySet<string> = new Set(INVESTIGATION_COORDINATION_ACTIONS);

/** Owns the complete case-bound coordination read/action lane. */
export function useInvestigationCoordination(
  options: UseInvestigationCoordinationOptions,
): InvestigationCoordinationController {
  const latestRef = useRef(options);
  latestRef.current = options;
  const mountedRef = useRef(true);
  const readSlotRef = useRef(new RequestSlot<CoordinationScope>());
  const actionSlotRef = useRef(new RequestSlot<CoordinationScope>());
  const activeActionRef = useRef<RequestToken<CoordinationScope> | null>(null);
  const retainedRef = useRef<RetainedIntent | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [resource, setResource] = useState<{
    readonly scopeKey: string | null;
    readonly state: ResourceState<InvestigationCoordinationV1>;
  }>({ scopeKey: null, state: { status: "idle" } });
  const [storedMutation, setStoredMutation] = useState(() =>
    emptyScopedMutationState<InvestigationCoordinationActionSuccessV1>()
  );

  const scope = useMemo<CoordinationScope | null>(() => {
    if (
      !options.active
      || !options.canRead
      || options.investigationId === null
    ) return null;
    return Object.freeze({
      identityKey: options.identityKey,
      authorityKey: options.authorityKey,
      actorIdentityId: options.actorIdentityId,
      investigationId: options.investigationId,
    });
  }, [
    options.active,
    options.actorIdentityId,
    options.authorityKey,
    options.canRead,
    options.identityKey,
    options.investigationId,
  ]);
  const scopeKey = scope === null ? null : mutationScopeKey([
    scope.identityKey,
    scope.authorityKey,
    scope.actorIdentityId,
    scope.investigationId,
  ]);
  const actionScopeKey = scopeKey === null
    || options.actorIdentityId.length === 0
    || options.readOnly
    || (!options.canCoordinateSelf && !options.canCoordinateParticipants)
    ? null
    : mutationScopeKey([
        scopeKey,
        String(options.canCoordinateSelf),
        String(options.canCoordinateParticipants),
      ]);
  const currentRef = useRef({ scope, scopeKey, actionScopeKey, resource });
  currentRef.current = { scope, scopeKey, actionScopeKey, resource };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readSlotRef.current.dispose();
      actionSlotRef.current.dispose();
      activeActionRef.current = null;
      retainedRef.current = null;
    };
  }, []);

  useEffect(() => {
    actionSlotRef.current.invalidate();
    activeActionRef.current = null;
    retainedRef.current = null;
    setStoredMutation(emptyScopedMutationState());
  }, [
    options.identityKey,
    options.authorityKey,
    options.actorIdentityId,
    options.investigationId,
    options.canCoordinateSelf,
    options.canCoordinateParticipants,
    options.active,
    options.canRead,
    options.readOnly,
  ]);

  useEffect(() => {
    if (scope === null || scopeKey === null) {
      readSlotRef.current.invalidate();
      setResource({ scopeKey: null, state: { status: "idle" } });
      return;
    }
    const token = readSlotRef.current.begin(scope);
    setResource((current) => ({
      scopeKey,
      state: current.scopeKey === scopeKey && current.state.status === "ready"
        ? { status: "loading", previous: current.state.value }
        : { status: "loading" },
    }));
    void options.gateway.getCoordination(scope.investigationId, {
      actorIdentityId: scope.actorIdentityId,
      signal: token.signal,
    }).then((result) => {
      if (!mountedRef.current || !readSlotRef.current.isCurrent(token)) return;
      if (!result.ok && (result.error.kind === "auth_lost" || result.error.kind === "not_found")) {
        latestRef.current.onScopeDenied(scope.investigationId, result.error);
      }
      setResource((current) => {
        if (current.scopeKey !== scopeKey) return current;
        const previous = current.state.status === "loading"
          ? current.state.previous
          : undefined;
        return {
          scopeKey,
          state: result.ok
            ? { status: "ready", value: result.value }
            : previous === undefined
            ? { status: "failed", error: result.error }
            : { status: "failed", error: result.error, previous },
        };
      });
    }).catch(() => {
      if (!mountedRef.current || !readSlotRef.current.isCurrent(token)) return;
      setResource({ scopeKey, state: { status: "failed", error: { kind: "unexpected" } } });
    });
    return () => readSlotRef.current.invalidate();
  }, [options.gateway, refreshGeneration, scope, scopeKey]);

  const refresh = useCallback(() => setRefreshGeneration((value) => value + 1), []);

  const apply = useCallback(async (
    command: InvestigationCoordinationCommand,
  ): Promise<CommandOutcome<InvestigationCoordinationActionSuccessV1>> => {
    if (activeActionRef.current !== null) return { status: "ignored", reason: "busy" };
    const start = latestRef.current;
    if (!ACTION_SET.has(command.action)) return { status: "ignored", reason: "not_ready" };
    const current = currentRef.current;
    const currentScope = current.scope;
    const currentReadScopeKey = current.scopeKey;
    const currentActionScopeKey = current.actionScopeKey;
    const currentResource: ResourceState<InvestigationCoordinationV1> =
      current.resource.scopeKey === currentReadScopeKey
        ? current.resource.state
        : { status: "idle" };
    if (
      currentScope === null
      || currentReadScopeKey === null
      || currentActionScopeKey === null
      || currentScope.actorIdentityId.length === 0
      || start.readOnly
      || currentResource.status !== "ready"
      || currentResource.value.investigationId !== currentScope.investigationId
      || !mayApply(command.action, start.canCoordinateSelf, start.canCoordinateParticipants)
    ) return { status: "ignored", reason: "not_ready" };

    let targetIdentityId: string | null;
    try {
      targetIdentityId = normalizedTarget(command);
    } catch {
      return { status: "failed", error: { kind: "unexpected" } };
    }
    const retained = retainedRef.current;
    let request: ApplyCoordinationActionInput;
    if (
      retained?.scopeKey === currentActionScopeKey
      && retained.idempotencyKey === command.idempotencyKey
    ) {
      if (retained.action !== command.action || retained.targetIdentityId !== targetIdentityId) {
        const error = deepFreezeDto({
          kind: "input" as const,
          field: "idempotencyKey" as const,
          reason: "intent_mismatch" as const,
        });
        setStoredMutation(scopedMutationState(currentActionScopeKey, {
          status: "failed",
          error,
        }));
        return { status: "failed", error };
      }
      request = retained.request;
    } else {
      request = deepFreezeDto({
        action: command.action,
        ...(targetIdentityId === null ? {} : { targetIdentityId }),
        expectedRevision: currentResource.value.revision,
        idempotencyKey: command.idempotencyKey,
        ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
      });
      retainedRef.current = null;
    }

    const token = actionSlotRef.current.begin(currentScope);
    activeActionRef.current = token;
    setStoredMutation(scopedMutationState(currentActionScopeKey, { status: "running" }));
    const isCurrent = (): boolean => {
      const latest = latestRef.current;
      return mountedRef.current
        && activeActionRef.current === token
        && actionSlotRef.current.isCurrent(token)
        && latest.identityKey === currentScope.identityKey
        && latest.authorityKey === currentScope.authorityKey
        && latest.actorIdentityId === currentScope.actorIdentityId
        && latest.investigationId === currentScope.investigationId
        && latest.active
        && latest.canRead
        && !latest.readOnly
        && mayApply(command.action, latest.canCoordinateSelf, latest.canCoordinateParticipants);
    };

    try {
      const result = await start.gateway.applyCoordinationAction(
        currentScope.investigationId,
        request,
        { actorIdentityId: currentScope.actorIdentityId, signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      if (!result.ok) {
        if (result.error.kind === "auth_lost" || result.error.kind === "not_found") {
          latestRef.current.onScopeDenied(currentScope.investigationId, result.error);
        } else if (
          result.error.kind === "coordination_changed"
          || result.error.kind === "coordination_refused"
        ) {
          setResource({ scopeKey: currentReadScopeKey, state: {
            status: "ready",
            value: result.error.current,
          } });
          retainedRef.current = null;
        } else if (
          result.error.kind === "unavailable"
          && result.error.reason === "commit_outcome_unknown"
        ) {
          retainedRef.current = deepFreezeDto({
            scopeKey: currentActionScopeKey,
            action: command.action,
            targetIdentityId,
            idempotencyKey: command.idempotencyKey,
            request,
          });
        }
        if (!isCurrent()) return { status: "ignored", reason: "stale" };
        setStoredMutation(scopedMutationState(currentActionScopeKey, {
          status: "failed",
          error: result.error,
        }));
        return { status: "failed", error: result.error };
      }
      retainedRef.current = null;
      setResource({ scopeKey: currentReadScopeKey, state: {
        status: "ready",
        value: result.value.applied,
      } });
      setStoredMutation(scopedMutationState(currentActionScopeKey, {
        status: "succeeded",
        value: result.value,
      }));
      return { status: "succeeded", value: result.value };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const error = deepFreezeDto({ kind: "unexpected" as const });
      setStoredMutation(scopedMutationState(currentActionScopeKey, {
        status: "failed",
        error,
      }));
      return { status: "failed", error };
    } finally {
      if (activeActionRef.current === token) activeActionRef.current = null;
    }
  }, []);

  return {
    coordination: scopeKey !== null && resource.scopeKey === scopeKey
      ? resource.state
      : { status: "idle" },
    state: visibleMutationState(storedMutation, actionScopeKey),
    refresh,
    apply,
  };
}
