import type {
  ArtifactAnnotationBulkResultV1,
  ArtifactAnnotationV1,
} from "../annotation-contract.js";
import type {
  CreateArtifactAnnotationsBulkInput,
  InvestigationAnnotationGateway,
  InvestigationBulkAnnotationGateway,
} from "../gateway.js";
import type { RuntimeFailure } from "../errors.js";
import type {
  CommandOutcome,
  MutationState,
  ResourceState,
} from "../types.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface AnnotationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

export interface UseArtifactAnnotationsOptions {
  readonly gateway: InvestigationAnnotationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly active: boolean;
  readonly canRead: boolean;
  /** Auth-bound 401/403 failures remove the active scope atomically. */
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface ArtifactAnnotationsController {
  readonly annotations: ResourceState<readonly ArtifactAnnotationV1[]>;
  /** Resolve after the next authoritative refresh has settled. */
  readonly refresh: () => Promise<void>;
  /** Publish only a server-confirmed annotation for the active case. */
  readonly publish: (annotation: ArtifactAnnotationV1) => void;
}

function publishAnnotation(
  state: ResourceState<readonly ArtifactAnnotationV1[]>,
  annotation: ArtifactAnnotationV1,
): ResourceState<readonly ArtifactAnnotationV1[]> {
  const merge = (items: readonly ArtifactAnnotationV1[]): readonly ArtifactAnnotationV1[] => {
    const index = items.findIndex(({ id }) => id === annotation.id);
    return index < 0
      ? [...items, annotation]
      : items.map((item, itemIndex) => itemIndex === index ? annotation : item);
  };
  switch (state.status) {
    case "ready":
      return { status: "ready", value: merge(state.value) };
    case "loading":
      return state.previous === undefined
        ? { status: "loading" }
        : { status: "loading", previous: merge(state.previous) };
    case "failed":
      return state.previous === undefined
        ? state
        : { status: "failed", error: state.error, previous: merge(state.previous) };
    case "idle":
      return state;
  }
}

/** Owns the case-scoped, read-only artifact-annotation resource lane. */
export function useArtifactAnnotations(
  options: UseArtifactAnnotationsOptions,
): ArtifactAnnotationsController {
  const scope = useMemo<AnnotationScope | null>(
    () => options.active && options.canRead && options.investigationId !== null
      ? Object.freeze({
          identityKey: options.identityKey,
          authorityKey: options.authorityKey,
          investigationId: options.investigationId,
        })
      : null,
    [
      options.active,
      options.authorityKey,
      options.canRead,
      options.identityKey,
      options.investigationId,
    ],
  );
  const requestSlot = useRef(new RequestSlot<AnnotationScope>());
  const [resource, setResource] = useState<KeyedResourceState<AnnotationScope, readonly ArtifactAnnotationV1[]>>(
    () => createResourceState<AnnotationScope, readonly ArtifactAnnotationV1[]>(),
  );
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const refreshResolversRef = useRef<Array<() => void>>([]);
  const latestRef = useRef(options);
  latestRef.current = options;

  const settleRefreshWaiters = useCallback(() => {
    const waiters = refreshResolversRef.current.splice(0);
    waiters.forEach((resolve) => resolve());
  }, []);

  const load = useCallback(async (
    currentScope: AnnotationScope,
    signal: AbortSignal,
  ) => latestRef.current.gateway.listArtifactAnnotations(
    currentScope.investigationId,
    { signal },
  ), []);

  useEffect(() => {
    if (scope === null) {
      requestSlot.current.invalidate();
      setResource(resetResource<AnnotationScope, readonly ArtifactAnnotationV1[]>());
      settleRefreshWaiters();
      return;
    }

    const token = requestSlot.current.begin(scope);
    setResource((current) => beginResourceLoad(current, scope));
    void load(scope, token.signal)
      .then((result) => {
        if (!requestSlot.current.isCurrent(token)) return;
        // A missing annotation collection is an optional-surface failure
        // (for example, when an older server has not deployed the endpoint);
        // it must not revoke the parent investigation scope. Auth loss still
        // tears down the scope because protectedApiFetch has proved the
        // session is no longer valid.
        if (!result.ok && result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scope.investigationId, result.error);
        }
        setResource((current) => result.ok
          ? succeedResourceLoad(current, scope, result.value)
          : failResourceLoad(current, scope, result.error));
        settleRefreshWaiters();
      })
      .catch(() => {
        if (!requestSlot.current.isCurrent(token)) return;
        setResource((current) => failResourceLoad(
          current,
          scope,
          { kind: "unexpected" },
        ));
        settleRefreshWaiters();
      });

    return () => requestSlot.current.invalidate();
  }, [load, refreshGeneration, scope, settleRefreshWaiters]);

  useEffect(() => () => settleRefreshWaiters(), [settleRefreshWaiters]);

  const refresh = useCallback(() => {
    if (scope === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      refreshResolversRef.current.push(resolve);
      setRefreshGeneration((current) => current + 1);
    });
  }, [scope]);

  const publish = useCallback((annotation: ArtifactAnnotationV1) => {
    if (scope === null || annotation.caseId !== scope.investigationId) return;
    setResource((current) => current.key === scope
      ? { key: scope, state: publishAnnotation(current.state, annotation) }
      : current);
  }, [scope]);

  const state = scope !== null && resource.key === scope
    ? resource.state
    : { status: "idle" as const };
  return { annotations: state, refresh, publish };
}

export interface CreateArtifactAnnotationCommand {
  readonly artifactId: string;
  readonly body: string;
  readonly privacyClass?: "owner_only" | "share_safe";
  readonly clientTime?: string;
  readonly sourceId?: string;
  readonly idempotencyKey?: string;
}

export interface UseCreateArtifactAnnotationOptions {
  readonly gateway: InvestigationAnnotationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly canAnnotate: boolean;
  readonly readOnly: boolean;
  readonly onCreated: (annotation: ArtifactAnnotationV1) => void;
  readonly onRefresh: (investigationId: string) => void;
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface CreateArtifactAnnotationController {
  readonly state: MutationState<ArtifactAnnotationV1>;
  readonly create: (
    command: CreateArtifactAnnotationCommand,
  ) => Promise<CommandOutcome<ArtifactAnnotationV1>>;
}

interface CreateAnnotationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

function unexpected(): { status: "failed"; error: { kind: "unexpected" } } {
  return { status: "failed", error: { kind: "unexpected" } };
}

/** Append one artifact annotation under the same fencing rules as other writes. */
export function useCreateArtifactAnnotation(
  options: UseCreateArtifactAnnotationOptions,
): CreateArtifactAnnotationController {
  const [stored, setStored] = useState<ScopedMutationState<ArtifactAnnotationV1>>(
    () => emptyScopedMutationState(),
  );
  const slotRef = useRef(new RequestSlot<CreateAnnotationScope>());
  const activeRef = useRef<RequestToken<CreateAnnotationScope> | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;

  const invalidate = useCallback(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    if (mountedRef.current) setStored(emptyScopedMutationState());
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
    invalidate,
    options.authorityKey,
    options.canAnnotate,
    options.identityKey,
    options.investigationId,
    options.readOnly,
  ]);

  const create = useCallback(async (
    command: CreateArtifactAnnotationCommand,
  ): Promise<CommandOutcome<ArtifactAnnotationV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };
    const start = latestRef.current;
    let artifactId: string;
    let body: string;
    try {
      artifactId = command.artifactId;
      body = command.body;
      if (
        start.readOnly
        || !start.canAnnotate
        || start.investigationId === null
        || typeof artifactId !== "string"
        || artifactId.trim() === ""
        || typeof body !== "string"
        || body.trim() === ""
      ) {
        return { status: "ignored", reason: "not_ready" };
      }
    } catch {
      return { status: "ignored", reason: "not_ready" };
    }

    const scope: CreateAnnotationScope = {
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
    setStored(scopedMutationState(scopeKey, { status: "running" }));
    const isCurrent = (): boolean => {
      const latest = latestRef.current;
      return mountedRef.current
        && activeRef.current === token
        && slotRef.current.isCurrent(token)
        && latest.identityKey === scope.identityKey
        && latest.authorityKey === scope.authorityKey
        && latest.investigationId === scope.investigationId
        && latest.canAnnotate
        && !latest.readOnly;
    };

    try {
      let input: {
        body: string;
        privacyClass?: "owner_only" | "share_safe";
        clientTime?: string;
        sourceId?: string;
        idempotencyKey?: string;
      };
      try {
        input = {
          body,
          ...(command.privacyClass === undefined ? {} : { privacyClass: command.privacyClass }),
          ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
          ...(command.sourceId === undefined ? {} : { sourceId: command.sourceId }),
          ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
        };
      } catch {
        return unexpected();
      }
      const result = await start.gateway.createArtifactAnnotation(
        scope.investigationId,
        artifactId,
        input,
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      if (!result.ok) {
        if (result.error.kind === "not_found" || result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scope.investigationId, result.error);
        }
        if (!isCurrent()) return { status: "ignored", reason: "stale" };
        setStored(scopedMutationState(scopeKey, { status: "failed", error: result.error }));
        return { status: "failed", error: result.error };
      }
      if (
        result.value.caseId !== scope.investigationId
        || result.value.artifactId !== artifactId
      ) {
        const error: RuntimeFailure = { kind: "protocol", reason: "identity" };
        setStored(scopedMutationState(scopeKey, { status: "failed", error }));
        return { status: "failed", error };
      }
      latestRef.current.onCreated(result.value);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefresh(scope.investigationId);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      setStored(scopedMutationState(scopeKey, { status: "succeeded", value: result.value }));
      return { status: "succeeded", value: result.value };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const error: RuntimeFailure = token.signal.aborted
        ? { kind: "aborted" }
        : { kind: "unexpected" };
      setStored(scopedMutationState(scopeKey, { status: "failed", error }));
      return { status: "failed", error };
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, []);

  const currentScopeKey = options.readOnly
    || !options.canAnnotate
    || options.investigationId === null
    ? null
    : mutationScopeKey([options.identityKey, options.authorityKey, options.investigationId]);
  return {
    state: visibleMutationState(stored, currentScopeKey),
    create,
  };
}

export interface CreateArtifactAnnotationsBulkCommand {
  /** The target set is submitted as one atomic server operation. */
  readonly artifactIds: readonly string[];
  readonly body: string;
  readonly privacyClass?: "owner_only" | "share_safe";
  readonly clientTime?: string;
  readonly sourceId?: string;
  /** Required to safely replay a response whose commit outcome is unknown. */
  readonly idempotencyKey: string;
}

export interface UseCreateArtifactAnnotationsBulkOptions {
  readonly gateway: InvestigationBulkAnnotationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly canAnnotate: boolean;
  readonly readOnly: boolean;
  /** Publish the complete server-confirmed result exactly once. */
  readonly onCreated: (result: ArtifactAnnotationBulkResultV1) => void;
  /** Refresh the one case collection after the set operation settles. */
  readonly onRefresh: (investigationId: string) => void;
  readonly onScopeDenied: (investigationId: string, error: RuntimeFailure) => void;
}

export interface CreateArtifactAnnotationsBulkController {
  readonly state: MutationState<ArtifactAnnotationBulkResultV1>;
  readonly create: (
    command: CreateArtifactAnnotationsBulkCommand,
  ) => Promise<CommandOutcome<ArtifactAnnotationBulkResultV1>>;
}

interface BulkAnnotationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

function bulkAnnotationResultMatches(
  investigationId: string,
  artifactIds: readonly string[],
  result: ArtifactAnnotationBulkResultV1,
): boolean {
  const requested = new Set<string>();
  for (const artifactId of artifactIds) {
    if (
      typeof artifactId !== "string"
      || artifactId.length === 0
      || requested.has(artifactId)
    ) return false;
    requested.add(artifactId);
  }
  if (result.caseId !== investigationId || result.items.length !== requested.size) return false;
  const returned = new Set<string>();
  for (const item of result.items) {
    if (
      typeof item.artifactId !== "string"
      || !requested.has(item.artifactId)
      || returned.has(item.artifactId)
    ) return false;
    returned.add(item.artifactId);
    if (item.outcome === "not_found") continue;
    if (
      item.annotation.caseId !== investigationId
      || item.annotation.artifactId !== item.artifactId
      || item.annotation.id.length === 0
    ) return false;
  }
  return returned.size === requested.size;
}

/**
 * Submits one bounded target set through the bulk transport. This controller
 * intentionally has no loop over the singular annotation method: a set is a
 * single audited/idempotent server operation, including partial not_found
 * outcomes and replay acknowledgements.
 */
export function useCreateArtifactAnnotationsBulk(
  options: UseCreateArtifactAnnotationsBulkOptions,
): CreateArtifactAnnotationsBulkController {
  const [stored, setStored] = useState<ScopedMutationState<ArtifactAnnotationBulkResultV1>>(
    () => emptyScopedMutationState(),
  );
  const slotRef = useRef(new RequestSlot<BulkAnnotationScope>());
  const activeRef = useRef<RequestToken<BulkAnnotationScope> | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;

  const invalidate = useCallback(() => {
    slotRef.current.invalidate();
    activeRef.current = null;
    if (mountedRef.current) setStored(emptyScopedMutationState());
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
    invalidate,
    options.authorityKey,
    options.canAnnotate,
    options.identityKey,
    options.investigationId,
    options.readOnly,
  ]);

  const create = useCallback(async (
    command: CreateArtifactAnnotationsBulkCommand,
  ): Promise<CommandOutcome<ArtifactAnnotationBulkResultV1>> => {
    if (activeRef.current !== null) return { status: "ignored", reason: "busy" };
    const start = latestRef.current;
    let artifactIds: string[];
    let body: string;
    let privacyClass: "owner_only" | "share_safe" | undefined;
    let clientTime: string | undefined;
    let sourceId: string | undefined;
    let idempotencyKey: string;
    try {
      artifactIds = Array.from(command.artifactIds, (artifactId) => artifactId);
      body = command.body;
      privacyClass = command.privacyClass;
      clientTime = command.clientTime;
      sourceId = command.sourceId;
      idempotencyKey = command.idempotencyKey;
      if (
        start.readOnly
        || !start.canAnnotate
        || start.investigationId === null
        || artifactIds.length === 0
        || artifactIds.some((artifactId) => typeof artifactId !== "string" || artifactId.trim() === "")
        || new Set(artifactIds).size !== artifactIds.length
        || typeof body !== "string"
        || body.trim() === ""
        || typeof idempotencyKey !== "string"
        || idempotencyKey.trim() === ""
      ) {
        return { status: "ignored", reason: "not_ready" };
      }
    } catch {
      return { status: "ignored", reason: "not_ready" };
    }

    const scope: BulkAnnotationScope = {
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
    setStored(scopedMutationState(scopeKey, { status: "running" }));
    const isCurrent = (): boolean => {
      const latest = latestRef.current;
      return mountedRef.current
        && activeRef.current === token
        && slotRef.current.isCurrent(token)
        && latest.identityKey === scope.identityKey
        && latest.authorityKey === scope.authorityKey
        && latest.investigationId === scope.investigationId
        && latest.canAnnotate
        && !latest.readOnly;
    };

    try {
      const input: CreateArtifactAnnotationsBulkInput = {
        artifactIds,
        body,
        ...(privacyClass === undefined ? {} : { privacyClass }),
        ...(clientTime === undefined ? {} : { clientTime }),
        ...(sourceId === undefined ? {} : { sourceId }),
        idempotencyKey,
      };
      const result = await start.gateway.createArtifactAnnotationsBulk(
        scope.investigationId,
        input,
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      if (!result.ok) {
        if (result.error.kind === "not_found" || result.error.kind === "auth_lost") {
          latestRef.current.onScopeDenied(scope.investigationId, result.error);
        }
        if (!isCurrent()) return { status: "ignored", reason: "stale" };
        setStored(scopedMutationState(scopeKey, { status: "failed", error: result.error }));
        return { status: "failed", error: result.error };
      }
      let identityMatches = false;
      try {
        identityMatches = bulkAnnotationResultMatches(
          scope.investigationId,
          artifactIds,
          result.value,
        );
      } catch {
        identityMatches = false;
      }
      if (!identityMatches) {
        const error: RuntimeFailure = { kind: "protocol", reason: "identity" };
        setStored(scopedMutationState(scopeKey, { status: "failed", error }));
        return { status: "failed", error };
      }
      latestRef.current.onCreated(result.value);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      latestRef.current.onRefresh(scope.investigationId);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      setStored(scopedMutationState(scopeKey, { status: "succeeded", value: result.value }));
      return { status: "succeeded", value: result.value };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const error: RuntimeFailure = token.signal.aborted
        ? { kind: "aborted" }
        : { kind: "unexpected" };
      setStored(scopedMutationState(scopeKey, { status: "failed", error }));
      return { status: "failed", error };
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, []);

  const currentScopeKey = options.readOnly
    || !options.canAnnotate
    || options.investigationId === null
    ? null
    : mutationScopeKey([options.identityKey, options.authorityKey, options.investigationId]);
  return {
    state: visibleMutationState(stored, currentScopeKey),
    create,
  };
}

/** Naming alias for callers that put the operation name before its scope. */
export const useCreateArtifactAnnotationBulk = useCreateArtifactAnnotationsBulk;
