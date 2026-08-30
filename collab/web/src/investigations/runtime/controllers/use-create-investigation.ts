import type { CaseV1 } from "@cd-collab/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreateInvestigationInput,
  InvestigationGateway,
} from "../gateway.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";

interface CreateScope {
  readonly identityKey: string;
  readonly authorityKey: string;
}

export interface UseCreateInvestigationOptions {
  readonly gateway: InvestigationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly canCreate: boolean;
  readonly readOnly: boolean;
  /** True only while the canonical location is inside the investigations area. */
  readonly isInvestigationLocation: boolean;
  /** The case in the canonical location, or null at the browse/create origin. */
  readonly locationInvestigationId: string | null;
  /** Merge the server-confirmed case into shared runtime state. Must not throw. */
  readonly onCreated: (investigation: CaseV1) => void;
  /** Open the server-confirmed identity. Must not throw. */
  readonly onOpenCreated: (investigationId: string) => void;
}

export interface CreateInvestigationController {
  readonly state: MutationState<CaseV1>;
  readonly create: (
    input: CreateInvestigationInput,
  ) => Promise<CommandOutcome<CaseV1>>;
}

function unexpected(): { status: "failed"; error: { kind: "unexpected" } } {
  return { status: "failed", error: { kind: "unexpected" } };
}

/**
 * Owns the create command without owning navigation or presentation.
 *
 * Identity and authority changes cancel the command. Location changes do not:
 * a completed create is still published, but navigation is allowed only while
 * the user remains at the case-null investigations origin.
 */
export function useCreateInvestigation(
  options: UseCreateInvestigationOptions,
): CreateInvestigationController {
  const [state, setState] = useState<MutationState<CaseV1>>({ status: "idle" });
  const slotRef = useRef(new RequestSlot<CreateScope>());
  const activeRef = useRef<RequestToken<CreateScope> | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;

  const invalidate = useCallback(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    if (mountedRef.current) setState({ status: "idle" });
  }, []);

  useEffect(() => {
    // React StrictMode intentionally replays effect setup/cleanup. Restore the
    // mounted fence during the second setup so development builds do not make
    // every command look stale after the rehearsal cleanup.
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
  }, [options.identityKey, options.authorityKey, options.canCreate, options.readOnly, invalidate]);

  const create = useCallback(async (
    input: CreateInvestigationInput,
  ): Promise<CommandOutcome<CaseV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };

    const start = latestRef.current;
    if (start.readOnly || !start.canCreate) {
      return { status: "ignored", reason: "not_ready" };
    }

    const title = input.title.trim();
    if (title.length === 0) {
      const outcome: CommandOutcome<CaseV1> = {
        status: "failed",
        error: { kind: "input", field: "title", reason: "required" },
      };
      setState({ status: "failed", error: outcome.error });
      return outcome;
    }

    const scope: CreateScope = {
      identityKey: start.identityKey,
      authorityKey: start.authorityKey,
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
        && latest.canCreate
        && !latest.readOnly;
    };

    try {
      const result = await start.gateway.createInvestigation(
        { ...input, title },
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      if (!result.ok) {
        const outcome: CommandOutcome<CaseV1> = { status: "failed", error: result.error };
        setState({ status: "failed", error: result.error });
        return outcome;
      }

      latestRef.current.onCreated(result.value);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };

      const latest = latestRef.current;
      if (latest.isInvestigationLocation && latest.locationInvestigationId === null) {
        latest.onOpenCreated(result.value.id);
      }
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

  return { state, create };
}
