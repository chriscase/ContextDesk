import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationWriteGateway, UpdateSituationInput } from "../gateway.js";
import type { RuntimeFailure } from "../errors.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
} from "./scoped-mutation-state.js";

interface SituationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

/**
 * The situation fields a strategy submits.
 *
 * `expectedVersion` is deliberately absent: it is read from the published
 * case this controller is editing, so a presentation can neither forge a
 * version nor keep replaying a stale one after a conflict.
 */
export interface UpdateSituationCommand {
  readonly problemStatement?: string;
  readonly affectedParties?: string;
  readonly impact?: string;
  readonly scope?: string;
  readonly openQuestions?: readonly string[];
  readonly investigationContext?: CaseV1["investigationContext"];
  readonly clientTime?: string;
}

const SITUATION_FIELDS = [
  "problemStatement",
  "affectedParties",
  "impact",
  "scope",
  "openQuestions",
  "investigationContext",
] as const;

export interface UseUpdateSituationOptions {
  /** Resolved write seams. An unimplemented seam fails closed as unavailable. */
  readonly gateway: InvestigationWriteGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  /** The published case whose `situationVersion` this edit is based on. */
  readonly investigation: CaseV1 | null;
  readonly canEditSituation: boolean;
  readonly readOnly: boolean;
  /** Publish the authoritative server case. Must not throw. */
  readonly onInvestigationPublished: (investigation: CaseV1) => void;
  /** Refresh the case for this exact investigation. Must not throw. */
  readonly onRefreshInvestigation: (investigationId: string) => void;
  /** Refresh collection metadata after an authoritative situation change. */
  readonly onRefreshInvestigations: () => void;
  /** Atomically deny the active case when a mutation proves access loss. */
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface UpdateSituationController {
  readonly state: MutationState<CaseV1>;
  /** Accepts situation intent only; the expected version is derived internally. */
  readonly update: (
    command: UpdateSituationCommand,
  ) => Promise<CommandOutcome<CaseV1>>;
}

function unexpected(): { status: "failed"; error: { kind: "unexpected" } } {
  return { status: "failed", error: { kind: "unexpected" } };
}

function suppliedSituation(command: UpdateSituationCommand): Partial<UpdateSituationInput> {
  const supplied: Record<string, unknown> = {};
  for (const field of SITUATION_FIELDS) {
    if (command[field] !== undefined) supplied[field] = command[field];
  }
  return supplied as Partial<UpdateSituationInput>;
}

/**
 * Writes one server-arbitrated situation revision for the active case.
 *
 * The server compares `expectedVersion` and answers 409 when someone else
 * edited first. A conflict is never retried here: the case is refreshed so the
 * next attempt starts from the version the server actually holds.
 */
export function useUpdateSituation(
  options: UseUpdateSituationOptions,
): UpdateSituationController {
  const [storedState, setStoredState] = useState(() => emptyScopedMutationState<CaseV1>());
  const slotRef = useRef(new RequestSlot<SituationScope>());
  const activeRef = useRef<RequestToken<SituationScope> | null>(null);
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
    options.canEditSituation,
    options.readOnly,
    invalidate,
  ]);

  const update = useCallback(async (
    command: UpdateSituationCommand,
  ): Promise<CommandOutcome<CaseV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };

    const start = latestRef.current;
    const investigation = start.investigation;
    if (
      start.readOnly
      || !start.canEditSituation
      || start.investigationId === null
      || investigation === null
      || investigation.id !== start.investigationId
    ) {
      return { status: "ignored", reason: "not_ready" };
    }

    const situation = suppliedSituation(command);
    if (Object.keys(situation).length === 0) {
      return { status: "ignored", reason: "not_ready" };
    }

    const scope: SituationScope = {
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
        && latest.canEditSituation
        && !latest.readOnly;
    };

    try {
      const result = await start.gateway.updateSituation(
        scope.investigationId,
        {
          ...situation,
          expectedVersion: investigation.situationVersion,
          ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
        },
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      if (!result.ok) {
        if (result.error.kind === "not_found" || result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scope.investigationId, result.error);
        } else if (result.error.kind === "conflict") {
          // Someone else advanced the situation first. Re-read rather than
          // resend: the expected version this attempt used is now provably
          // stale, and only the server knows the current one.
          latestRef.current.onRefreshInvestigation(scope.investigationId);
          if (!isCurrent()) return { status: "ignored", reason: "stale" };
          latestRef.current.onRefreshInvestigations();
        }
        if (!isCurrent()) return { status: "ignored", reason: "stale" };

        setStoredState(scopedMutationState(scopeKey, {
          status: "failed",
          error: result.error,
        }));
        return { status: "failed", error: result.error };
      }

      latestRef.current.onInvestigationPublished(result.value);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshInvestigation(scope.investigationId);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshInvestigations();
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
    || !options.canEditSituation
    || options.investigationId === null
    ? null
    : mutationScopeKey([
        options.identityKey,
        options.authorityKey,
        options.investigationId,
      ]);
  return { state: visibleMutationState(storedState, currentScopeKey), update };
}
