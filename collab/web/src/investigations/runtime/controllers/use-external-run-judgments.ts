import {
  type ExternalRunJudgmentLinkV1,
  type ExternalRunJudgmentListV1,
  type ExternalRunJudgmentSuccessV1,
  type ExternalRunJudgmentValue,
} from "@cd-collab/contracts/external-run-judgment";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deepFreezeDto } from "../deep-freeze.js";
import type { RuntimeFailure } from "../errors.js";
import type {
  CreateExternalRunJudgmentInput,
  InvestigationExternalRunJudgmentGateway,
} from "../gateway.js";
import type { CommandOutcome, MutationState, ResourceState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  resetResource,
  succeedResourceLoad,
  type KeyedResourceState,
} from "./resource-state.js";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
  type ScopedMutationState,
} from "./scoped-mutation-state.js";

export interface ExternalRunJudgmentCommand {
  readonly runId: string;
  readonly judgment: ExternalRunJudgmentValue;
  readonly links: readonly ExternalRunJudgmentLinkV1[];
  readonly rationale: string | null;
  readonly idempotencyKey: string;
}

export interface UseExternalRunJudgmentsOptions {
  readonly gateway: InvestigationExternalRunJudgmentGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly active: boolean;
  readonly canRead: boolean;
  readonly canRecordRunJudgment: boolean;
  readonly readOnly: boolean;
  /** Only global authentication loss denies the parent case scope. */
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface ExternalRunJudgmentsController {
  readonly judgments: ResourceState<ExternalRunJudgmentListV1>;
  readonly runId: string | null;
  /** Only a successful authoritative read begun in this scope completes a generation. */
  readonly completedReadGeneration: number | null;
  readonly state: MutationState<ExternalRunJudgmentSuccessV1>;
  readonly query: (runId: string) => void;
  readonly refresh: () => number | undefined;
  readonly create: (
    command: ExternalRunJudgmentCommand,
  ) => Promise<CommandOutcome<ExternalRunJudgmentSuccessV1>>;
}

interface QueryRequest {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
  readonly runId: string;
}

type JudgmentScope = QueryRequest;

interface CommandSnapshot {
  readonly runId: string;
  readonly judgment: ExternalRunJudgmentValue;
  readonly links: readonly ExternalRunJudgmentLinkV1[];
  readonly rationale: string | null;
  readonly idempotencyKey: string;
}

interface RetainedIntent {
  readonly scopeKey: string;
  readonly command: CommandSnapshot;
  readonly request: CreateExternalRunJudgmentInput;
}

function frozenOutcome<T>(outcome: CommandOutcome<T>): CommandOutcome<T> {
  return deepFreezeDto(outcome);
}

function snapshotCommand(command: ExternalRunJudgmentCommand): CommandSnapshot {
  if (
    typeof command.runId !== "string"
    || typeof command.idempotencyKey !== "string"
    || !Array.isArray(command.links)
  ) throw new TypeError("invalid external run judgment command");
  return deepFreezeDto({
    runId: command.runId,
    judgment: command.judgment,
    links: command.links.map(({ kind, id }) => ({ kind, id })),
    rationale: command.rationale,
    idempotencyKey: command.idempotencyKey,
  });
}

function sameIntent(left: CommandSnapshot, right: CommandSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A transport or response failure after dispatch cannot prove the write rolled back. */
function unconfirmedWrite(error: RuntimeFailure): boolean {
  return error.kind === "network"
    || error.kind === "protocol"
    || error.kind === "unexpected_response"
    || error.kind === "server_failure"
    || error.kind === "unexpected"
    || error.kind === "aborted"
    || error.kind === "unavailable";
}

function publishedList(
  state: ResourceState<ExternalRunJudgmentListV1>,
): ExternalRunJudgmentListV1 | undefined {
  if (state.status === "ready") return state.value;
  if (state.status === "loading" || state.status === "failed") return state.previous;
  return undefined;
}

function mergeSuccess(
  current: KeyedResourceState<string, ExternalRunJudgmentListV1>,
  scopeKey: string,
  success: ExternalRunJudgmentSuccessV1,
): KeyedResourceState<string, ExternalRunJudgmentListV1> {
  if (current.key !== scopeKey) return current;
  const published = publishedList(current.state);
  if (published === undefined) return current;
  const bySequence = new Map(published.judgments.map((row) => [row.seq, row]));
  bySequence.set(success.applied.seq, success.applied);
  const judgments = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
  if (judgments.some((row, index) => row.seq !== index + 1)) return current;
  return {
    key: scopeKey,
    state: {
      status: "ready",
      value: deepFreezeDto({ ...published, judgments }),
    },
  };
}

/** Owns the explicitly selected run's read and caller-triggered judgment write lanes. */
export function useExternalRunJudgments(
  options: UseExternalRunJudgmentsOptions,
): ExternalRunJudgmentsController {
  const latestRef = useRef(options);
  latestRef.current = options;
  const mountedRef = useRef(true);
  const readSlotRef = useRef(new RequestSlot<JudgmentScope>());
  const writeSlotRef = useRef(new RequestSlot<JudgmentScope>());
  const activeWriteRef = useRef<RequestToken<JudgmentScope> | null>(null);
  const retainedRef = useRef<RetainedIntent | null>(null);
  const [requested, setRequested] = useState<QueryRequest | null>(null);
  const nextReadGenerationRef = useRef(0);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [completedRead, setCompletedRead] = useState<{
    readonly scope: JudgmentScope;
    readonly generation: number;
  } | null>(null);
  const [resource, setResource] = useState<
    KeyedResourceState<string, ExternalRunJudgmentListV1>
  >(() => createResourceState());
  const [storedMutation, setStoredMutation] = useState<
    ScopedMutationState<ExternalRunJudgmentSuccessV1>
  >(() => emptyScopedMutationState());

  const query = useCallback((runId: string) => {
    const latest = latestRef.current;
    if (
      typeof runId !== "string"
      || runId.trim() === ""
      || !latest.active
      || !latest.canRead
      || latest.investigationId === null
    ) return;
    const investigationId = latest.investigationId;
    setRequested((current) => current?.identityKey === latest.identityKey
      && current.authorityKey === latest.authorityKey
      && current.investigationId === investigationId
      && current.runId === runId
      ? current
      : Object.freeze({
        identityKey: latest.identityKey,
        authorityKey: latest.authorityKey,
        investigationId,
        runId,
      }));
  }, []);

  const scope = useMemo<JudgmentScope | null>(() => {
    if (
      !options.active
      || !options.canRead
      || options.investigationId === null
      || requested === null
      || requested.identityKey !== options.identityKey
      || requested.authorityKey !== options.authorityKey
      || requested.investigationId !== options.investigationId
    ) return null;
    return requested;
  }, [
    options.active,
    options.authorityKey,
    options.canRead,
    options.identityKey,
    options.investigationId,
    requested,
  ]);
  const scopeKey = scope === null ? null : mutationScopeKey([
    scope.identityKey,
    scope.authorityKey,
    scope.investigationId,
    scope.runId,
  ]);
  const writeScopeKey = scopeKey !== null && options.canRecordRunJudgment && !options.readOnly
    ? scopeKey
    : null;
  const currentRef = useRef({ scope, scopeKey, writeScopeKey, resource });
  currentRef.current = { scope, scopeKey, writeScopeKey, resource };
  const committedScopeRef = useRef<{ scope: JudgmentScope | null; writeScopeKey: string | null }>({
    scope: null,
    writeScopeKey: null,
  });

  useLayoutEffect(() => {
    const previous = committedScopeRef.current;
    if (previous.scope === scope && previous.writeScopeKey === writeScopeKey) return;
    committedScopeRef.current = { scope, writeScopeKey };
    if (previous.scope !== scope) {
      readSlotRef.current.invalidate();
      setResource(resetResource());
      setCompletedRead(null);
    }
    writeSlotRef.current.invalidate();
    activeWriteRef.current = null;
    retainedRef.current = null;
    setStoredMutation(emptyScopedMutationState());
  }, [scope, writeScopeKey]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readSlotRef.current.dispose();
      writeSlotRef.current.dispose();
      activeWriteRef.current = null;
      retainedRef.current = null;
    };
  }, []);

  useEffect(() => {
    writeSlotRef.current.invalidate();
    activeWriteRef.current = null;
    retainedRef.current = null;
    setStoredMutation(emptyScopedMutationState());
  }, [
    options.active,
    options.authorityKey,
    options.canRead,
    options.canRecordRunJudgment,
    options.identityKey,
    options.investigationId,
    options.readOnly,
    requested,
  ]);

  useEffect(() => {
    if (scope === null || scopeKey === null) {
      readSlotRef.current.invalidate();
      setResource(resetResource());
      return;
    }
    const token = readSlotRef.current.begin(scope);
    setResource((current) => beginResourceLoad(current, scopeKey));
    void options.gateway.listExternalRunJudgments(
      scope.investigationId,
      scope.runId,
      { signal: token.signal },
    ).then((result) => {
      if (!mountedRef.current || !readSlotRef.current.isCurrent(token)) return;
      if (!result.ok && result.error.kind === "auth_lost") {
        latestRef.current.onScopeDenied(scope.investigationId, result.error);
      }
      if (result.ok) {
        setResource((current) => succeedResourceLoad(current, scopeKey, result.value));
        setCompletedRead({ scope, generation: refreshGeneration });
      } else {
        setResource((current) => failResourceLoad(current, scopeKey, result.error));
      }
    }).catch(() => {
      if (!mountedRef.current || !readSlotRef.current.isCurrent(token)) return;
      setResource((current) => failResourceLoad(current, scopeKey, { kind: "unexpected" }));
    });
    return () => readSlotRef.current.invalidate();
  }, [options.gateway, refreshGeneration, scope, scopeKey]);

  const refresh = useCallback(() => {
    if (currentRef.current.scope === null) return undefined;
    const generation = ++nextReadGenerationRef.current;
    setRefreshGeneration(generation);
    return generation;
  }, []);

  const create = useCallback(async (
    command: ExternalRunJudgmentCommand,
  ): Promise<CommandOutcome<ExternalRunJudgmentSuccessV1>> => {
    if (activeWriteRef.current !== null) {
      return frozenOutcome({ status: "ignored", reason: "busy" });
    }
    const current = currentRef.current;
    const start = latestRef.current;
    const list = current.scopeKey !== null && current.resource.key === current.scopeKey
      ? publishedList(current.resource.state)
      : undefined;
    if (
      current.scope === null
      || current.scopeKey === null
      || current.writeScopeKey === null
      || list === undefined
      || start.readOnly
      || !start.canRead
      || !start.canRecordRunJudgment
    ) return frozenOutcome({ status: "ignored", reason: "not_ready" });

    let snapshot: CommandSnapshot;
    try {
      snapshot = snapshotCommand(command);
    } catch {
      return frozenOutcome({ status: "ignored", reason: "not_ready" });
    }
    if (snapshot.runId !== current.scope.runId || list.runId !== snapshot.runId) {
      return frozenOutcome({ status: "ignored", reason: "not_ready" });
    }

    const retained = retainedRef.current;
    let request: CreateExternalRunJudgmentInput;
    if (
      retained?.scopeKey === current.writeScopeKey
      && retained.command.idempotencyKey === snapshot.idempotencyKey
    ) {
      if (!sameIntent(retained.command, snapshot)) {
        const error = deepFreezeDto({
          kind: "input" as const,
          field: "idempotencyKey" as const,
          reason: "intent_mismatch" as const,
        });
        setStoredMutation(scopedMutationState(current.writeScopeKey, {
          status: "failed",
          error,
        }));
        return frozenOutcome({ status: "failed", error });
      }
      request = retained.request.expectedSequence === list.judgments.length
        ? retained.request
        : deepFreezeDto({ ...retained.request, expectedSequence: list.judgments.length });
    } else {
      request = deepFreezeDto({
        expectedSequence: list.judgments.length,
        judgment: snapshot.judgment,
        links: snapshot.links,
        rationale: snapshot.rationale,
        idempotencyKey: snapshot.idempotencyKey,
      });
      retainedRef.current = null;
    }

    const scopeAtStart = current.scope;
    const scopeKeyAtStart = current.writeScopeKey;
    const token = writeSlotRef.current.begin(scopeAtStart);
    activeWriteRef.current = token;
    setStoredMutation(scopedMutationState(scopeKeyAtStart, { status: "running" }));
    const isCurrent = () => {
      const latest = latestRef.current;
      const now = currentRef.current;
      return mountedRef.current
        && activeWriteRef.current === token
        && writeSlotRef.current.isCurrent(token)
        && now.writeScopeKey === scopeKeyAtStart
        && latest.canRead
        && latest.canRecordRunJudgment
        && !latest.readOnly;
    };

    try {
      const result = await start.gateway.createExternalRunJudgment(
        scopeAtStart.investigationId,
        scopeAtStart.runId,
        request,
        { signal: token.signal },
      );
      if (!isCurrent()) return frozenOutcome({ status: "ignored", reason: "stale" });
      if (!result.ok) {
        if (result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scopeAtStart.investigationId, result.error);
        }
        if (unconfirmedWrite(result.error)) {
          retainedRef.current = deepFreezeDto({
            scopeKey: scopeKeyAtStart,
            command: snapshot,
            request,
          });
        } else {
          retainedRef.current = null;
        }
        setStoredMutation(scopedMutationState(scopeKeyAtStart, {
          status: "failed",
          error: result.error,
        }));
        if (result.error.kind === "judgment_conflict") refresh();
        return frozenOutcome({ status: "failed", error: result.error });
      }

      retainedRef.current = null;
      setResource((value) => mergeSuccess(value, scopeKeyAtStart, result.value));
      setStoredMutation(scopedMutationState(scopeKeyAtStart, {
        status: "succeeded",
        value: result.value,
      }));
      return frozenOutcome({ status: "succeeded", value: result.value });
    } catch {
      if (!isCurrent()) return frozenOutcome({ status: "ignored", reason: "stale" });
      const error = deepFreezeDto({ kind: "unexpected" as const });
      retainedRef.current = deepFreezeDto({
        scopeKey: scopeKeyAtStart,
        command: snapshot,
        request,
      });
      setStoredMutation(scopedMutationState(scopeKeyAtStart, { status: "failed", error }));
      return frozenOutcome({ status: "failed", error });
    } finally {
      if (activeWriteRef.current === token) activeWriteRef.current = null;
    }
  }, [refresh]);

  return {
    judgments: scopeKey !== null && resource.key === scopeKey
      ? resource.state
      : { status: "idle" },
    runId: scope?.runId ?? null,
    completedReadGeneration: completedRead?.scope === scope
      ? completedRead.generation
      : null,
    state: visibleMutationState(storedMutation, writeScopeKey),
    query,
    refresh,
    create,
  };
}
