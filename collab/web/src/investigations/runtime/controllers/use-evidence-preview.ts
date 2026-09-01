import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidencePreviewValue, InvestigationGateway } from "../gateway.js";
import type { RuntimeFailure } from "../errors.js";
import type { CommandOutcome, MutationState } from "../types.js";
import { RequestSlot, type RequestToken } from "./request-slot.js";
import {
  emptyScopedMutationState,
  mutationScopeKey,
  scopedMutationState,
  visibleMutationState,
  type ScopedMutationState,
} from "./scoped-mutation-state.js";

interface PreviewScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
  readonly artifactId: string;
}

export interface PreviewEvidenceCommand {
  readonly artifactId: string;
}

export interface UseEvidencePreviewOptions {
  readonly gateway: InvestigationGateway;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string | null;
  readonly canRead: boolean;
}

export interface EvidencePreviewController {
  readonly state: MutationState<EvidencePreviewValue>;
  readonly preview: (
    command: PreviewEvidenceCommand,
  ) => Promise<CommandOutcome<EvidencePreviewValue>>;
  readonly clear: () => void;
}

interface CachedPreview extends EvidencePreviewValue {
  readonly etag: string | null;
}

function unavailable(): { status: "failed"; error: RuntimeFailure } {
  return { status: "failed", error: { kind: "unavailable", status: 503 } };
}

/** Read-only, bounded evidence preview with identity/case/artifact fencing. */
export function useEvidencePreview(
  options: UseEvidencePreviewOptions,
): EvidencePreviewController {
  const [stored, setStored] = useState<ScopedMutationState<EvidencePreviewValue>>(() =>
    emptyScopedMutationState<EvidencePreviewValue>()
  );
  const slotRef = useRef(new RequestSlot<PreviewScope>());
  const activeRef = useRef<RequestToken<PreviewScope> | null>(null);
  const cacheRef = useRef(new Map<string, CachedPreview>());
  const mountedRef = useRef(true);
  const latestRef = useRef(options);
  latestRef.current = options;
  const currentCaseKey = options.investigationId === null
    ? null
    : mutationScopeKey([options.identityKey, options.authorityKey, options.investigationId]);

  const clear = useCallback(() => {
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
    cacheRef.current.clear();
    clear();
    return clear;
  }, [
    options.identityKey,
    options.authorityKey,
    options.investigationId,
    options.canRead,
    clear,
  ]);

  const preview = useCallback(async (
    command: PreviewEvidenceCommand,
  ): Promise<CommandOutcome<EvidencePreviewValue>> => {
    const start = latestRef.current;
    if (!start.canRead || start.investigationId === null) {
      return { status: "ignored", reason: "not_ready" };
    }
    const previewEvidence = start.gateway.previewEvidence;
    if (previewEvidence === undefined) {
      const unavailableResult = unavailable();
      if (mountedRef.current) {
        setStored(scopedMutationState(currentCaseKey ?? "", {
          status: "failed",
          error: unavailableResult.error,
        }));
      }
      return unavailableResult;
    }
    if (command.artifactId.trim() === "") {
      return { status: "ignored", reason: "not_ready" };
    }
    const scope: PreviewScope = {
      identityKey: start.identityKey,
      authorityKey: start.authorityKey,
      investigationId: start.investigationId,
      artifactId: command.artifactId,
    };
    const scopeKey = mutationScopeKey([
      scope.identityKey,
      scope.authorityKey,
      scope.investigationId,
    ]);
    const cacheKey = mutationScopeKey([
      scope.identityKey,
      scope.authorityKey,
      scope.investigationId,
      scope.artifactId,
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
        && latest.canRead;
    };
    try {
      const cached = cacheRef.current.get(cacheKey);
      const result = await previewEvidence.call(
        start.gateway,
        scope.investigationId,
        scope.artifactId,
        cached?.etag ? { ifNoneMatch: cached.etag } : {},
        { signal: token.signal },
      );
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      if (!result.ok) {
        setStored(scopedMutationState(scopeKey, { status: "failed", error: result.error }));
        return { status: "failed", error: result.error };
      }
      const transportValue = result.value as EvidencePreviewValue & { readonly notModified?: boolean };
      const value = transportValue.notModified
        ? cached
        : transportValue;
      if (value === undefined || value.artifactId !== scope.artifactId) {
        const failure: RuntimeFailure = { kind: "protocol", reason: "identity" };
        setStored(scopedMutationState(scopeKey, { status: "failed", error: failure }));
        return { status: "failed", error: failure };
      }
      const published: EvidencePreviewValue = Object.freeze({
        artifactId: value.artifactId,
        text: value.text,
        truncated: value.truncated,
        etag: value.etag,
      });
      cacheRef.current.set(cacheKey, published);
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      setStored(scopedMutationState(scopeKey, { status: "succeeded", value: published }));
      return { status: "succeeded", value: published };
    } catch {
      if (!isCurrent()) return { status: "ignored", reason: "stale" };
      const failure: RuntimeFailure = token.signal.aborted
        ? { kind: "aborted" }
        : { kind: "unexpected" };
      setStored(scopedMutationState(scopeKey, { status: "failed", error: failure }));
      return { status: "failed", error: failure };
    } finally {
      if (activeRef.current === token) activeRef.current = null;
    }
  }, [currentCaseKey]);

  return {
    state: visibleMutationState(stored, currentCaseKey),
    preview,
    clear,
  };
}
