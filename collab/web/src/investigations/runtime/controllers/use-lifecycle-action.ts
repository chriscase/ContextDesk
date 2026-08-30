import type {
  CaseV1,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  LifecycleAction,
} from "@cd-collab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationGateway } from "../gateway.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";

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
  const [state, setState] = useState<MutationState<InvestigationLifecycleActionSuccessV1>>({
    status: "idle",
  });
  const slotRef = useRef(new RequestSlot<LifecycleScope>());
  const activeRef = useRef<RequestToken<LifecycleScope> | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;

  const invalidate = useCallback(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    if (mountedRef.current) setState({ status: "idle" });
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
        if (result.error.kind === "lifecycle_changed") {
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
        setState({ status: "failed", error: result.error });
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

      setState({ status: "succeeded", value: result.value });
      return { status: "succeeded", value: result.value };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const outcome = unexpected();
      setState({ status: "failed", error: outcome.error });
      return outcome;
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, []);

  return { state, apply };
}
