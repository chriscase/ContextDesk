import type { ArtifactAnnotationV1 } from "../annotation-contract.js";
import type { InvestigationAnnotationGateway } from "../gateway.js";
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
  readonly refresh: () => void;
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
  const latestRef = useRef(options);
  latestRef.current = options;

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
      })
      .catch(() => {
        if (!requestSlot.current.isCurrent(token)) return;
        setResource((current) => failResourceLoad(
          current,
          scope,
          { kind: "unexpected" },
        ));
      });

    return () => requestSlot.current.invalidate();
  }, [load, refreshGeneration, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

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
      };
      try {
        input = {
          body,
          ...(command.privacyClass === undefined ? {} : { privacyClass: command.privacyClass }),
          ...(command.clientTime === undefined ? {} : { clientTime: command.clientTime }),
          ...(command.sourceId === undefined ? {} : { sourceId: command.sourceId }),
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
