import {
  PERMANENT_UNKNOWN_SOURCE_ID,
  SOURCE_CREATE_REQUEST_SCHEMA_ID,
  SOURCE_RESTORE_REQUEST_SCHEMA_ID,
  SOURCE_RETIRE_REQUEST_SCHEMA_ID,
  parseSourceCreateRequest,
  parseSourceRestoreRequest,
  parseSourceRetireRequest,
  type SourceCreateRequestV1,
  type SourceKind,
  type SourceMutationAction,
  type SourceMutationRefusedV1,
  type SourceMutationSuccessV1,
  type SourceRestoreRequestV1,
  type SourceRetireRequestV1,
  type SourceV1,
} from "@cd-collab/contracts/source-catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  sourceCatalogGateway,
  type DeepReadonly,
  type SourceCatalogFailure,
  type SourceCatalogGateway,
  type SourceCatalogResult,
} from "./gateway.js";

export const SOURCE_CATALOG_CHANGED_EVENT = "contextdesk:source-catalog-changed";

export type SourceCatalogResource =
  | { readonly status: "idle" }
  | {
      readonly status: "loading";
      readonly previous?: readonly DeepReadonly<SourceV1>[];
    }
  | { readonly status: "ready"; readonly value: readonly DeepReadonly<SourceV1>[] }
  | {
      readonly status: "failed";
      readonly error: SourceCatalogFailure;
      readonly previous?: readonly DeepReadonly<SourceV1>[];
    };

export interface SourceCreateIntent {
  readonly name: string;
  readonly kind: SourceKind;
  readonly description?: string | null;
}

export type SourceCatalogMutationState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly action: SourceMutationAction; readonly sourceId: string | null }
  | {
      readonly status: "succeeded";
      readonly action: SourceMutationAction;
      readonly value: DeepReadonly<SourceMutationSuccessV1>;
    }
  | {
      readonly status: "refused";
      readonly action: SourceMutationAction;
      readonly refusal: DeepReadonly<SourceMutationRefusedV1>;
    }
  | {
      readonly status: "outcome_unknown";
      readonly action: SourceMutationAction;
      readonly sourceId: string | null;
    }
  | {
      readonly status: "failed";
      readonly action: SourceMutationAction;
      readonly error: SourceCatalogFailure;
    };

export type SourceCatalogCommandOutcome =
  | { readonly status: "succeeded"; readonly value: DeepReadonly<SourceMutationSuccessV1> }
  | { readonly status: "refused"; readonly refusal: DeepReadonly<SourceMutationRefusedV1> }
  | { readonly status: "outcome_unknown" }
  | { readonly status: "failed"; readonly error: SourceCatalogFailure }
  | {
      readonly status: "ignored";
      readonly reason: "not_ready" | "busy" | "stale" | "auth_lost";
    };

export interface SourceCatalogController {
  readonly resource: SourceCatalogResource;
  readonly mutation: SourceCatalogMutationState;
  readonly actions: {
    readonly refresh: () => void;
    readonly create: (intent: SourceCreateIntent) => Promise<SourceCatalogCommandOutcome>;
    readonly retire: (sourceId: string) => Promise<SourceCatalogCommandOutcome>;
    readonly restore: (sourceId: string) => Promise<SourceCatalogCommandOutcome>;
    readonly retryUnknown: () => Promise<SourceCatalogCommandOutcome>;
    readonly dismissMutation: () => void;
  };
}

export interface UseSourceCatalogOptions {
  readonly enabled: boolean;
  readonly canWrite: boolean;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly gateway?: SourceCatalogGateway;
  readonly keyFactory?: () => string;
}

type MutationRequest =
  | SourceCreateRequestV1
  | SourceRetireRequestV1
  | SourceRestoreRequestV1;

interface MutationAttempt {
  readonly action: SourceMutationAction;
  readonly sourceId: string | null;
  readonly request: DeepReadonly<MutationRequest>;
  readonly scopeKey: string;
}

interface ScopedResource {
  readonly scopeKey: string | null;
  readonly value: SourceCatalogResource;
}

interface ScopedMutation {
  readonly scopeKey: string | null;
  readonly value: SourceCatalogMutationState;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) return value as DeepReadonly<T>;
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

function frozen<T>(value: T): DeepReadonly<T> {
  return deepFreeze(value);
}

const IDLE_RESOURCE: SourceCatalogResource = frozen({ status: "idle" });
const IDLE_MUTATION: SourceCatalogMutationState = frozen({ status: "idle" });

function rowsOf(resource: SourceCatalogResource): readonly DeepReadonly<SourceV1>[] {
  if (resource.status === "ready") return resource.value;
  if ((resource.status === "loading" || resource.status === "failed") && resource.previous) {
    return resource.previous;
  }
  return [];
}

function hasRetainedRows(resource: SourceCatalogResource): boolean {
  return resource.status === "ready"
    || ((resource.status === "loading" || resource.status === "failed")
      && resource.previous !== undefined);
}

function mergeRow(
  rows: readonly DeepReadonly<SourceV1>[],
  source: DeepReadonly<SourceV1>,
  prependIfNew: boolean,
): readonly DeepReadonly<SourceV1>[] {
  const index = rows.findIndex(({ id }) => id === source.id);
  if (index < 0) return frozen(prependIfNew ? [source, ...rows] : [...rows, source]);
  const next = [...rows];
  next[index] = source;
  return frozen(next);
}

function removeRow(
  rows: readonly DeepReadonly<SourceV1>[],
  sourceId: string,
): readonly DeepReadonly<SourceV1>[] {
  return frozen(rows.filter(({ id }) => id !== sourceId));
}

function replaceResourceRows(
  resource: SourceCatalogResource,
  rows: readonly DeepReadonly<SourceV1>[],
): SourceCatalogResource {
  if (resource.status === "ready") return frozen({ status: "ready", value: rows });
  if (resource.status === "loading") return frozen({ status: "loading", previous: rows });
  if (resource.status === "failed") {
    return frozen({ status: "failed", error: resource.error, previous: rows });
  }
  return resource;
}

function defaultKeyFactory(): string {
  return `source-${crypto.randomUUID()}`;
}

function unexpectedFailure(): SourceCatalogFailure {
  return frozen({ kind: "unexpected" as const });
}

/**
 * Owns the Source Catalog read and CAS mutation lifecycles without owning
 * authorization, persistence, audit, or source identity. The server remains
 * authoritative; this hook only publishes parsed, deeply frozen snapshots.
 */
export function useSourceCatalog(options: UseSourceCatalogOptions): SourceCatalogController {
  const gateway = options.gateway ?? sourceCatalogGateway;
  const keyFactory = options.keyFactory ?? defaultKeyFactory;
  const scopeKey = JSON.stringify([options.identityKey, options.authorityKey]);
  const latestRef = useRef({ ...options, gateway, keyFactory, scopeKey });
  latestRef.current = { ...options, gateway, keyFactory, scopeKey };

  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [storedResource, setStoredResource] = useState<ScopedResource>(() => ({
    scopeKey: null,
    value: IDLE_RESOURCE,
  }));
  const [storedMutation, setStoredMutation] = useState<ScopedMutation>(() => ({
    scopeKey: null,
    value: IDLE_MUTATION,
  }));
  const resourceRef = useRef(storedResource);
  resourceRef.current = storedResource;

  const readGenerationRef = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);
  const mutationGenerationRef = useRef(0);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const activeMutationRef = useRef<MutationAttempt | null>(null);
  const pendingUnknownRef = useRef<MutationAttempt | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      readGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      readAbortRef.current?.abort();
      mutationAbortRef.current?.abort();
      activeMutationRef.current = null;
      pendingUnknownRef.current = null;
    };
  }, []);

  useEffect(() => {
    mutationGenerationRef.current += 1;
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = null;
    activeMutationRef.current = null;
    pendingUnknownRef.current = null;
    setStoredMutation({ scopeKey: null, value: IDLE_MUTATION });
  }, [gateway, options.enabled, options.canWrite, scopeKey]);

  useEffect(() => {
    readAbortRef.current?.abort();
    const request = new AbortController();
    readAbortRef.current = request;
    const generation = ++readGenerationRef.current;

    if (!options.enabled) {
      setStoredResource({ scopeKey: null, value: IDLE_RESOURCE });
      return () => request.abort();
    }

    setStoredResource((current) => {
      const retain = current.scopeKey === scopeKey && hasRetainedRows(current.value);
      const previous = retain ? rowsOf(current.value) : [];
      return {
        scopeKey,
        value: frozen(retain
          ? { status: "loading", previous }
          : { status: "loading" }),
      };
    });

    const isCurrent = () => mountedRef.current
      && options.enabled
      && latestRef.current.enabled
      && latestRef.current.scopeKey === scopeKey
      && readGenerationRef.current === generation
      && !request.signal.aborted;

    void gateway.list(request.signal).then((result) => {
      if (!isCurrent()) return;
      if (result.ok) {
        setStoredResource({
          scopeKey,
          value: frozen({ status: "ready", value: frozen([...result.value.sources]) }),
        });
        return;
      }
      if (result.error.kind === "aborted" || result.error.kind === "auth_lost") {
        setStoredResource({ scopeKey: null, value: IDLE_RESOURCE });
        return;
      }
      setStoredResource((current) => {
        if (current.scopeKey !== scopeKey) return current;
        const retain = hasRetainedRows(current.value);
        const previous = rowsOf(current.value);
        return {
          scopeKey,
          value: frozen(retain
            ? { status: "failed", error: result.error, previous }
            : { status: "failed", error: result.error }),
        };
      });
    }).catch(() => {
      if (!isCurrent()) return;
      setStoredResource((current) => {
        if (current.scopeKey !== scopeKey) return current;
        const retain = hasRetainedRows(current.value);
        const previous = rowsOf(current.value);
        return {
          scopeKey,
          value: frozen(retain
            ? { status: "failed", error: unexpectedFailure(), previous }
            : { status: "failed", error: unexpectedFailure() }),
        };
      });
    });

    return () => request.abort();
  }, [gateway, options.enabled, refreshGeneration, scopeKey]);

  const refresh = useCallback(() => {
    if (!latestRef.current.enabled) return;
    setRefreshGeneration((value) => value + 1);
  }, []);

  const invalidateRead = useCallback(() => {
    readGenerationRef.current += 1;
    readAbortRef.current?.abort();
    readAbortRef.current = null;
  }, []);

  const publishRow = useCallback((
    publishedScope: string,
    source: DeepReadonly<SourceV1>,
    prependIfNew: boolean,
  ) => {
    setStoredResource((current) => {
      if (current.scopeKey !== publishedScope) return current;
      const rows = mergeRow(rowsOf(current.value), source, prependIfNew);
      return { scopeKey: publishedScope, value: replaceResourceRows(current.value, rows) };
    });
  }, []);

  const reconcileRefusal = useCallback((
    publishedScope: string,
    refusal: DeepReadonly<SourceMutationRefusedV1>,
  ) => {
    setStoredResource((current) => {
      if (current.scopeKey !== publishedScope) return current;
      let rows = rowsOf(current.value);
      if (refusal.current !== null) {
        rows = mergeRow(rows, refusal.current, false);
      } else if (refusal.sourceId !== null) {
        rows = removeRow(rows, refusal.sourceId);
      }
      return { scopeKey: publishedScope, value: replaceResourceRows(current.value, rows) };
    });
  }, []);

  const executeAttempt = useCallback(async (
    attempt: MutationAttempt,
  ): Promise<SourceCatalogCommandOutcome> => {
    const current = latestRef.current;
    if (!current.enabled || !current.canWrite || current.scopeKey !== attempt.scopeKey) {
      return frozen({ status: "ignored", reason: "not_ready" });
    }
    if (activeMutationRef.current !== null) {
      return frozen({ status: "ignored", reason: "busy" });
    }

    const generation = ++mutationGenerationRef.current;
    const request = new AbortController();
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = request;
    activeMutationRef.current = attempt;
    setStoredMutation({
      scopeKey: attempt.scopeKey,
      value: frozen({ status: "running", action: attempt.action, sourceId: attempt.sourceId }),
    });

    const isCurrent = () => {
      const latest = latestRef.current;
      return mountedRef.current
        && latest.enabled
        && latest.canWrite
        && latest.scopeKey === attempt.scopeKey
        && mutationGenerationRef.current === generation
        && activeMutationRef.current === attempt
        && !request.signal.aborted;
    };

    let result: SourceCatalogResult<SourceMutationSuccessV1>;
    try {
      result = attempt.action === "create"
        ? await current.gateway.create(attempt.request as SourceCreateRequestV1, request.signal)
        : attempt.action === "retire"
          ? await current.gateway.retire(attempt.request as SourceRetireRequestV1, request.signal)
          : await current.gateway.restore(attempt.request as SourceRestoreRequestV1, request.signal);
    } catch {
      if (!isCurrent()) return frozen({ status: "ignored", reason: "stale" });
      result = frozen({ ok: false, error: unexpectedFailure() });
    }

    try {
      if (!isCurrent()) return frozen({ status: "ignored", reason: "stale" });
      if (!result.ok) {
        if (result.error.kind === "aborted") {
          return frozen({ status: "ignored", reason: "stale" });
        }
        if (result.error.kind === "auth_lost") {
          invalidateRead();
          pendingUnknownRef.current = null;
          setStoredResource({ scopeKey: null, value: IDLE_RESOURCE });
          setStoredMutation({ scopeKey: null, value: IDLE_MUTATION });
          return frozen({ status: "ignored", reason: "auth_lost" });
        }
        if (result.error.kind === "network" || result.error.kind === "commit_outcome_unknown") {
          pendingUnknownRef.current = attempt;
          setStoredMutation({
            scopeKey: attempt.scopeKey,
            value: frozen({
              status: "outcome_unknown",
              action: attempt.action,
              sourceId: attempt.sourceId,
            }),
          });
          return frozen({ status: "outcome_unknown" });
        }
        pendingUnknownRef.current = null;
        if (result.error.kind === "refused") {
          invalidateRead();
          reconcileRefusal(attempt.scopeKey, result.error.refusal);
          setStoredMutation({
            scopeKey: attempt.scopeKey,
            value: frozen({
              status: "refused",
              action: attempt.action,
              refusal: result.error.refusal,
            }),
          });
          setRefreshGeneration((value) => value + 1);
          return frozen({ status: "refused", refusal: result.error.refusal });
        }
        setStoredMutation({
          scopeKey: attempt.scopeKey,
          value: frozen({ status: "failed", action: attempt.action, error: result.error }),
        });
        return frozen({ status: "failed", error: result.error });
      }

      pendingUnknownRef.current = null;
      invalidateRead();
      publishRow(attempt.scopeKey, result.value.applied, attempt.action === "create");
      setStoredMutation({
        scopeKey: attempt.scopeKey,
        value: frozen({ status: "succeeded", action: attempt.action, value: result.value }),
      });
      window.dispatchEvent(new Event(SOURCE_CATALOG_CHANGED_EVENT));
      setRefreshGeneration((value) => value + 1);
      return frozen({ status: "succeeded", value: result.value });
    } finally {
      if (activeMutationRef.current === attempt) activeMutationRef.current = null;
      if (mutationAbortRef.current === request) mutationAbortRef.current = null;
    }
  }, [invalidateRead, publishRow, reconcileRefusal]);

  const makeAttempt = useCallback((
    action: SourceMutationAction,
    request: MutationRequest,
  ): MutationAttempt | null => {
    const current = latestRef.current;
    if (!current.enabled || !current.canWrite || pendingUnknownRef.current !== null) return null;
    try {
      const parsed = action === "create"
        ? parseSourceCreateRequest(request)
        : action === "retire"
          ? parseSourceRetireRequest(request)
          : parseSourceRestoreRequest(request);
      return frozen({
        action,
        sourceId: "sourceId" in parsed ? parsed.sourceId : null,
        request: parsed,
        scopeKey: current.scopeKey,
      }) as MutationAttempt;
    } catch {
      return null;
    }
  }, []);

  const create = useCallback(async (
    intent: SourceCreateIntent,
  ): Promise<SourceCatalogCommandOutcome> => {
    const current = latestRef.current;
    if (!current.enabled || !current.canWrite || activeMutationRef.current !== null) {
      return frozen({
        status: "ignored",
        reason: activeMutationRef.current === null ? "not_ready" : "busy",
      });
    }
    if (pendingUnknownRef.current !== null) return frozen({ status: "ignored", reason: "busy" });
    let idempotencyKey: string;
    try {
      idempotencyKey = current.keyFactory();
    } catch {
      return frozen({ status: "failed", error: unexpectedFailure() });
    }
    let attempt: MutationAttempt | null;
    try {
      const description = intent.description;
      attempt = makeAttempt("create", {
        schemaId: SOURCE_CREATE_REQUEST_SCHEMA_ID,
        name: intent.name,
        kind: intent.kind,
        description: description?.trim() ? description : null,
        identityId: null,
        expectedRevision: 0,
        idempotencyKey,
      });
    } catch {
      const error = unexpectedFailure();
      setStoredMutation({
        scopeKey: current.scopeKey,
        value: frozen({ status: "failed", action: "create", error }),
      });
      return frozen({ status: "failed", error });
    }
    if (attempt === null) {
      const error = frozen({ kind: "invalid_request" as const });
      setStoredMutation({
        scopeKey: current.scopeKey,
        value: frozen({ status: "failed", action: "create", error }),
      });
      return frozen({ status: "failed", error });
    }
    return executeAttempt(attempt);
  }, [executeAttempt, makeAttempt]);

  const lifecycleAttempt = useCallback(async (
    action: "retire" | "restore",
    sourceId: string,
  ): Promise<SourceCatalogCommandOutcome> => {
    const current = latestRef.current;
    if (!current.enabled || !current.canWrite || activeMutationRef.current !== null) {
      return frozen({
        status: "ignored",
        reason: activeMutationRef.current === null ? "not_ready" : "busy",
      });
    }
    if (pendingUnknownRef.current !== null) return frozen({ status: "ignored", reason: "busy" });
    const visible = resourceRef.current.scopeKey === current.scopeKey
      ? rowsOf(resourceRef.current.value)
      : [];
    const source = visible.find(({ id }) => id === sourceId);
    if (
      source === undefined
      || source.id === PERMANENT_UNKNOWN_SOURCE_ID
      || source.revision === undefined
      || (action === "retire" && source.lifecycle !== "active")
      || (action === "restore" && source.lifecycle !== "retired")
    ) {
      return frozen({ status: "ignored", reason: "not_ready" });
    }
    let idempotencyKey: string;
    try {
      idempotencyKey = current.keyFactory();
    } catch {
      return frozen({ status: "failed", error: unexpectedFailure() });
    }
    const request = action === "retire"
      ? {
          schemaId: SOURCE_RETIRE_REQUEST_SCHEMA_ID,
          sourceId,
          expectedRevision: source.revision,
          idempotencyKey,
        }
      : {
          schemaId: SOURCE_RESTORE_REQUEST_SCHEMA_ID,
          sourceId,
          expectedRevision: source.revision,
          idempotencyKey,
        };
    const attempt = makeAttempt(action, request);
    return attempt === null
      ? frozen({ status: "ignored", reason: "not_ready" })
      : executeAttempt(attempt);
  }, [executeAttempt, makeAttempt]);

  const retire = useCallback(
    (sourceId: string) => lifecycleAttempt("retire", sourceId),
    [lifecycleAttempt],
  );
  const restore = useCallback(
    (sourceId: string) => lifecycleAttempt("restore", sourceId),
    [lifecycleAttempt],
  );

  const retryUnknown = useCallback(async (): Promise<SourceCatalogCommandOutcome> => {
    const attempt = pendingUnknownRef.current;
    const current = latestRef.current;
    if (
      attempt === null
      || activeMutationRef.current !== null
      || !current.enabled
      || !current.canWrite
      || current.scopeKey !== attempt.scopeKey
    ) {
      return frozen({ status: "ignored", reason: "not_ready" });
    }
    return executeAttempt(attempt);
  }, [executeAttempt]);

  const dismissMutation = useCallback(() => {
    const current = latestRef.current;
    if (activeMutationRef.current !== null || pendingUnknownRef.current !== null) return;
    setStoredMutation({
      scopeKey: current.scopeKey,
      value: IDLE_MUTATION,
    });
  }, []);

  const resource = !options.enabled || storedResource.scopeKey !== scopeKey
    ? IDLE_RESOURCE
    : storedResource.value;
  const mutation = !options.enabled
    || !options.canWrite
    || storedMutation.scopeKey !== scopeKey
    ? IDLE_MUTATION
    : storedMutation.value;
  const actions = useMemo(() => frozen({
    refresh,
    create,
    retire,
    restore,
    retryUnknown,
    dismissMutation,
  }), [create, dismissMutation, refresh, restore, retire, retryUnknown]);

  return { resource, mutation, actions };
}
