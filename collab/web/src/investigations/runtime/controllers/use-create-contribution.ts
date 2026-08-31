import type {
  ContributionKind,
  ContributionV1,
  PrivacyClass,
} from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigationWriteGateway } from "../gateway.js";
import type { RuntimeFailure } from "../errors.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
} from "./scoped-mutation-state.js";

interface ContributionScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

/**
 * The intent a strategy submits. The active case is never part of it.
 *
 * `kind` is required because no default is canonical, and `body` travels
 * verbatim: the server hashes what it stores, so this seam neither trims nor
 * rewrites contributed text.
 */
export interface CreateContributionCommand {
  readonly kind: ContributionKind;
  readonly body: string;
  /** Recorded evidence or prior contributions cited by a hypothesis. */
  readonly hypothesisLinks?: readonly {
    readonly kind: "artifact" | "contribution";
    readonly id: string;
  }[];
  readonly privacyClass?: PrivacyClass;
  readonly clientTime?: string;
  readonly sourceId?: string;
  /** Optional caller-generated duplicate-prevention token, adjudicated by the server. */
  readonly idempotencyKey?: string;
}

export interface UseCreateContributionOptions {
  /** Resolved write seams. An unimplemented seam fails closed as unavailable. */
  readonly gateway: InvestigationWriteGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly canContribute: boolean;
  readonly readOnly: boolean;
  /** Publish the authoritative server contribution. Must not throw. */
  readonly onContributed: (contribution: ContributionV1) => void;
  /** Refresh contributions for this exact investigation. Must not throw. */
  readonly onRefreshContributions: (investigationId: string) => void;
  /** Atomically deny the active case when a mutation proves access loss. */
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface CreateContributionController {
  readonly state: MutationState<ContributionV1>;
  readonly create: (
    command: CreateContributionCommand,
  ) => Promise<CommandOutcome<ContributionV1>>;
}

function unexpected(): { status: "failed"; error: { kind: "unexpected" } } {
  return { status: "failed", error: { kind: "unexpected" } };
}

function snapshotHypothesisLinks(
  raw: unknown,
  contributionKind: ContributionKind,
): Array<{ kind: "artifact" | "contribution"; id: string }> | undefined {
  if (raw === undefined) return undefined;
  if (contributionKind !== "hypothesis") {
    throw new TypeError("hypothesis links require a hypothesis contribution");
  }
  if (!Array.isArray(raw)) throw new TypeError("invalid hypothesis links");
  return Array.from(raw, (candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new TypeError("invalid hypothesis link");
    }
    const link = candidate as Record<string, unknown>;
    const kind = link.kind;
    const id = link.id;
    if ((kind !== "artifact" && kind !== "contribution") || typeof id !== "string") {
      throw new TypeError("invalid hypothesis link");
    }
    return { kind, id };
  });
}

/**
 * Writes one server-authoritative contribution to the active case.
 *
 * The command is caller-initiated only: nothing here retries, schedules, or
 * repeats a write, and every completion is fenced against the identity,
 * authority, case, and capability the write started under.
 */
export function useCreateContribution(
  options: UseCreateContributionOptions,
): CreateContributionController {
  const [storedState, setStoredState] = useState(() =>
    emptyScopedMutationState<ContributionV1>()
  );
  const slotRef = useRef(new RequestSlot<ContributionScope>());
  const activeRef = useRef<RequestToken<ContributionScope> | null>(null);
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
    options.canContribute,
    options.readOnly,
    invalidate,
  ]);

  const create = useCallback(async (
    command: CreateContributionCommand,
  ): Promise<CommandOutcome<ContributionV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };

    const start = latestRef.current;
    if (start.readOnly || !start.canContribute || start.investigationId === null) {
      return { status: "ignored", reason: "not_ready" };
    }

    const scope: ContributionScope = {
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
        && latest.canContribute
        && !latest.readOnly;
    };

    try {
      const linkSnapshot = snapshotHypothesisLinks(command.hypothesisLinks, command.kind);
      const result = await start.gateway.createContribution(
        scope.investigationId,
        {
          kind: command.kind,
          body: command.body,
          ...(linkSnapshot === undefined ? {} : { hypothesisLinks: linkSnapshot }),
          ...(command.privacyClass === undefined ? {} : { privacyClass: command.privacyClass }),
          ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
          ...(command.sourceId === undefined ? {} : { sourceId: command.sourceId }),
          ...(command.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: command.idempotencyKey }),
        },
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      if (!result.ok) {
        if (result.error.kind === "not_found" || result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scope.investigationId, result.error);
        }
        setStoredState(scopedMutationState(scopeKey, {
          status: "failed",
          error: result.error,
        }));
        return { status: "failed", error: result.error };
      }

      latestRef.current.onContributed(result.value);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefreshContributions(scope.investigationId);
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
    || !options.canContribute
    || options.investigationId === null
    ? null
    : mutationScopeKey([
        options.identityKey,
        options.authorityKey,
        options.investigationId,
      ]);
  return { state: visibleMutationState(storedState, currentScopeKey), create };
}
