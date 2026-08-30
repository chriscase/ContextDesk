import type {
  CaseV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  LifecycleAction,
} from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationGateway } from "../gateway.js";
import type { RuntimeFailure } from "../errors.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
} from "./scoped-mutation-state.js";

interface LifecycleScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

export interface UseLifecycleActionOptions {
  readonly gateway: InvestigationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly lifecycle: InvestigationLifecycleV1 | null;
  readonly canManageLifecycle: boolean;
  readonly readOnly: boolean;
  readonly onInvestigationPublished: (investigation: CaseV1) => void;
  readonly onLifecyclePublished: (lifecycle: InvestigationLifecycleV1) => void;
  readonly onRefreshInvestigation: (investigationId: string) => void;
  readonly onRefreshInvestigations: () => void;
  readonly onRefreshLifecycle: (investigationId: string) => void;
  /** Atomically deny the active case when a mutation proves access loss. */
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface LifecycleActionController {
  readonly state: MutationState<InvestigationLifecycleActionSuccessV1>;
  /** Accepts intent only; expected lifecycle values are derived internally. */
  readonly apply: (
    action: LifecycleAction,
  ) => Promise<CommandOutcome<InvestigationLifecycleActionSuccessV1>>;
}

function unexpected(): { status: "failed"; error: { kind: "unexpected" } } {
  return { status: "failed", error: { kind: "unexpected" } };
}

/** Executes one server-authoritative archive/restore action without retrying. */
export function useLifecycleAction(
  options: UseLifecycleActionOptions,
): LifecycleActionController {
  const [storedState, setStoredState] = useState(() =>
    emptyScopedMutationState<InvestigationLifecycleActionSuccessV1>()
  );
  const slotRef = useRef(new RequestSlot<LifecycleScope>());
  const activeRef = useRef<RequestToken<LifecycleScope> | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;

  const invalidate = useCallback(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    if (mountedRef.current) setStoredState(emptyScopedMutationState());
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      slotRef.current.dispose();
      activeRef.current = null;
    };
  }, []);

  useEffect(() => {
    invalidate();
    return invalidate;
  }, [
    options.identityKey,
    options.authorityKey,
    options.investigationId,
    options.canManageLifecycle,
    options.readOnly,
    invalidate,
  ]);

  const apply = useCallback(async (
    action: LifecycleAction,
  ): Promise<CommandOutcome<InvestigationLifecycleActionSuccessV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };

    const start = latestRef.current;
    const lifecycle = start.lifecycle;
    if (
      start.readOnly
      || !start.canManageLifecycle
      || start.investigationId === null
      || lifecycle === null
      || lifecycle.investigationId !== start.investigationId
    ) {
      return { status: "ignored", reason: "not_ready" };
    }

    const scope: LifecycleScope = {
      identityKey: start.identityKey,
      authorityKey: start.authorityKey,
      investigationId: start.investigationId,
    };
    const scopeKey = mutationScopeKey([
      scope.identityKey,
      scope.authorityKey,
      scope.investigationId,
    ]);
    const token = slotRef.current.begin(scope);
    activeRef.current = token;
    setStoredState(scopedMutationState(scopeKey, { status: "running" }));

    const isCurrent = (): boolean => {
      const latest = latestRef.current;
      return mountedRef.current
        && activeRef.current === token
        && slotRef.current.isCurrent(token)
        && latest.identityKey === scope.identityKey
        && latest.authorityKey === scope.authorityKey
        && latest.investigationId === scope.investigationId
        && latest.canManageLifecycle
        && !latest.readOnly;
    };

    try {
      const result = await start.gateway.applyLifecycleAction(
        scope.investigationId,
        {
          action,
          expected: {
            status: lifecycle.status,
            legalHold: lifecycle.legalHold,
            restoreTarget: lifecycle.restoreTarget,
          },
        },
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      if (!result.ok) {
        if (result.error.kind === "not_found" || result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scope.investigationId, result.error);
        } else if (result.error.kind === "lifecycle_changed") {
          latestRef.current.onLifecyclePublished(result.error.current);
          if (!isCurrent()) return { status: "ignored", reason: "stale" };
          latestRef.current.onRefreshInvestigation(scope.investigationId);
          if (!isCurrent()) return { status: "ignored", reason: "stale" };
          latestRef.current.onRefreshInvestigations();
        } else if (result.error.kind === "lifecycle_refused") {
          latestRef.current.onRefreshLifecycle(scope.investigationId);
        }
        if (!isCurrent()) return { status: "ignored", reason: "stale" };

        const outcome: CommandOutcome<InvestigationLifecycleActionSuccessV1> = {
          status: "failed",
          error: result.error,
        };
        setStoredState(scopedMutationState(scopeKey, {
          status: "failed",
          error: result.error,
        }));
        return outcome;
      }

      latestRef.current.onInvestigationPublished(result.value.case);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshInvestigation(scope.investigationId);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshInvestigations();
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshLifecycle(scope.investigationId);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      setStoredState(scopedMutationState(scopeKey, {
        status: "succeeded",
        value: result.value,
      }));
      return { status: "succeeded", value: result.value };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const outcome = unexpected();
      setStoredState(scopedMutationState(scopeKey, {
        status: "failed",
        error: outcome.error,
      }));
      return outcome;
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, []);

  const currentScopeKey = options.readOnly
    || !options.canManageLifecycle
    || options.investigationId === null
    ? null
    : mutationScopeKey([
        options.identityKey,
        options.authorityKey,
        options.investigationId,
      ]);
  return { state: visibleMutationState(storedState, currentScopeKey), apply };
}
