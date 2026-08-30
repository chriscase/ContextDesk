import type {
  ArtifactV1,
  CaseV1,
  ContributionV1,
  InvestigationLifecycleV1,
} from "@cd-collab/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GatewayResult, InvestigationGateway } from "../gateway.js";
import type { ResourceState } from "../types.js";
import { RequestSlot } from "./request-slot.js";
import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  resetResource,
  succeedResourceLoad,
} from "./resource-state.js";

interface ActiveInvestigationScope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly investigationId: string;
}

interface ResourceLane<T> {
  readonly state: ResourceState<T>;
  readonly publish: (publish: (value: T) => T) => void;
  readonly refresh: () => void;
}

export interface UseActiveInvestigationOptions {
  readonly gateway: InvestigationGateway;
  readonly investigationId: string | null;
  /** False whenever the canonical location is outside the investigation area. */
  readonly active: boolean;
  /** Changes whenever the authenticated identity changes. */
  readonly identityKey: string;
  /** Changes whenever the effective capability/read-only projection changes. */
  readonly authorityKey: string;
}

export interface ActiveInvestigationController {
  readonly investigation: ResourceState<CaseV1>;
  readonly evidence: ResourceState<readonly ArtifactV1[]>;
  readonly contributions: ResourceState<readonly ContributionV1[]>;
  readonly lifecycle: ResourceState<InvestigationLifecycleV1>;
  /** Publish a server-confirmed case only for the currently active case. */
  readonly publishInvestigation: (investigation: CaseV1) => void;
  /** Publish the linked, server-confirmed members of an evidence upload. */
  readonly publishEvidence: (artifact: ArtifactV1, summary: ContributionV1) => void;
  /** Publish a server-confirmed lifecycle snapshot only for the active case. */
  readonly publishLifecycle: (lifecycle: InvestigationLifecycleV1) => void;
  readonly refreshInvestigation: () => void;
  readonly refreshEvidence: () => void;
  readonly refreshContributions: () => void;
  readonly refreshLifecycle: () => void;
  readonly refreshAll: () => void;
}

function publishIntoState<T>(
  state: ResourceState<T>,
  publish: (value: T) => T,
): ResourceState<T> {
  switch (state.status) {
    case "ready":
      return { status: "ready", value: publish(state.value) };
    case "loading":
      return state.previous === undefined
        ? state
        : { status: "loading", previous: publish(state.previous) };
    case "failed":
      return state.previous === undefined
        ? state
        : { status: "failed", error: state.error, previous: publish(state.previous) };
    case "idle":
      return state;
  }
}

function mergeById<T extends { readonly id: string }>(
  records: readonly T[],
  record: T,
): readonly T[] {
  const existingIndex = records.findIndex(({ id }) => id === record.id);
  if (existingIndex === -1) return [...records, record];
  return records.map((current, index) => index === existingIndex ? record : current);
}

function useResourceLane<T>(
  scope: ActiveInvestigationScope | null,
  load: (signal: AbortSignal) => Promise<GatewayResult<T>>,
): ResourceLane<T> {
  const requestSlot = useRef(new RequestSlot<ActiveInvestigationScope>());
  const [resource, setResource] = useState(() =>
    createResourceState<ActiveInvestigationScope, T>(),
  );
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (scope === null) {
      requestSlot.current.invalidate();
      setResource(resetResource<ActiveInvestigationScope, T>());
      return;
    }

    const token = requestSlot.current.begin(scope);
    setResource((current) => beginResourceLoad(current, scope));
    void load(token.signal)
      .then((result) => {
        if (!requestSlot.current.isCurrent(token)) return;
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

    return () => {
      requestSlot.current.invalidate();
    };
  }, [load, refreshGeneration, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  const publish = useCallback((publication: (value: T) => T) => {
    if (scope === null) return;
    setResource((current) => {
      if (current.key !== scope) return current;
      const state = publishIntoState(current.state, publication);
      return state === current.state ? current : { key: scope, state };
    });
  }, [scope]);

  return {
    state: scope !== null && resource.key === scope ? resource.state : { status: "idle" },
    publish,
    refresh,
  };
}

/**
 * Owns four independent case-bound read lanes. Route, identity, and authority
 * are part of the publication identity, so no prior scope can appear as the
 * next scope's `previous` value.
 */
export function useActiveInvestigation({
  gateway,
  investigationId,
  active,
  identityKey,
  authorityKey,
}: UseActiveInvestigationOptions): ActiveInvestigationController {
  const scope = useMemo<ActiveInvestigationScope | null>(
    () => active && investigationId !== null
      ? Object.freeze({ identityKey, authorityKey, investigationId })
      : null,
    [active, authorityKey, identityKey, investigationId],
  );

  const loadInvestigation = useCallback(
    (signal: AbortSignal) => scope === null
      ? Promise.resolve<GatewayResult<CaseV1>>({ ok: false, error: { kind: "aborted" } })
      : gateway.getInvestigation(scope.investigationId, { signal }),
    [gateway, scope],
  );
  const loadEvidence = useCallback(
    (signal: AbortSignal) => scope === null
      ? Promise.resolve<GatewayResult<readonly ArtifactV1[]>>({
          ok: false,
          error: { kind: "aborted" },
        })
      : gateway.listEvidence(scope.investigationId, { signal }),
    [gateway, scope],
  );
  const loadContributions = useCallback(
    (signal: AbortSignal) => scope === null
      ? Promise.resolve<GatewayResult<readonly ContributionV1[]>>({
          ok: false,
          error: { kind: "aborted" },
        })
      : gateway.listContributions(scope.investigationId, { signal }),
    [gateway, scope],
  );
  const loadLifecycle = useCallback(
    (signal: AbortSignal) => scope === null
      ? Promise.resolve<GatewayResult<InvestigationLifecycleV1>>({
          ok: false,
          error: { kind: "aborted" },
        })
      : gateway.getLifecycle(scope.investigationId, { signal }),
    [gateway, scope],
  );

  const investigation = useResourceLane(scope, loadInvestigation);
  const evidence = useResourceLane(scope, loadEvidence);
  const contributions = useResourceLane(scope, loadContributions);
  const lifecycle = useResourceLane(scope, loadLifecycle);
  const refreshInvestigation = investigation.refresh;
  const refreshEvidence = evidence.refresh;
  const refreshContributions = contributions.refresh;
  const refreshLifecycle = lifecycle.refresh;
  const publishInvestigationResource = investigation.publish;
  const publishEvidenceResource = evidence.publish;
  const publishContributionResource = contributions.publish;
  const publishLifecycleResource = lifecycle.publish;

  const publishInvestigation = useCallback((published: CaseV1) => {
    if (scope === null || published.id !== scope.investigationId) return;
    publishInvestigationResource(() => published);
  }, [publishInvestigationResource, scope]);

  const publishEvidence = useCallback((artifact: ArtifactV1, summary: ContributionV1) => {
    if (
      scope === null
      || artifact.caseId !== scope.investigationId
      || summary.caseId !== scope.investigationId
      || artifact.summaryContributionId !== summary.id
    ) {
      return;
    }
    publishEvidenceResource((artifacts) => mergeById(artifacts, artifact));
    publishContributionResource((items) => mergeById(items, summary));
  }, [publishContributionResource, publishEvidenceResource, scope]);

  const publishLifecycle = useCallback((published: InvestigationLifecycleV1) => {
    if (scope === null || published.investigationId !== scope.investigationId) return;
    publishLifecycleResource(() => published);
  }, [publishLifecycleResource, scope]);

  const refreshAll = useCallback(() => {
    refreshInvestigation();
    refreshEvidence();
    refreshContributions();
    refreshLifecycle();
  }, [refreshContributions, refreshEvidence, refreshInvestigation, refreshLifecycle]);

  return {
    investigation: investigation.state,
    evidence: evidence.state,
    contributions: contributions.state,
    lifecycle: lifecycle.state,
    publishInvestigation,
    publishEvidence,
    publishLifecycle,
    refreshInvestigation,
    refreshEvidence,
    refreshContributions,
    refreshLifecycle,
    refreshAll,
  };
}
