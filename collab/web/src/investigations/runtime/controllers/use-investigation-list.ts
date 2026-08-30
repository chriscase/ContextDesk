import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InvestigationGateway } from "../gateway.js";
import type { ResourceState } from "../types.js";
import { RequestSlot } from "./request-slot.js";
import {
  beginResourceLoad,
  createResourceState,
  failResourceLoad,
  succeedResourceLoad,
} from "./resource-state.js";

interface InvestigationListScope {
  readonly identityKey: string;
  readonly authorityKey: string;
}

export interface UseInvestigationListOptions {
  readonly gateway: InvestigationGateway;
  /** False when the current authority cannot read the investigation collection. */
  readonly enabled: boolean;
  /** Changes whenever the authenticated identity changes. */
  readonly identityKey: string;
  /** Changes whenever the effective capability/read-only projection changes. */
  readonly authorityKey: string;
}

export interface InvestigationListController {
  readonly investigations: ResourceState<readonly CaseV1[]>;
  /** Merge one server-confirmed investigation into the current published collection. */
  readonly publishInvestigation: (investigation: CaseV1) => void;
  readonly refresh: () => void;
}

function mergeInvestigation(
  investigations: readonly CaseV1[],
  investigation: CaseV1,
): readonly CaseV1[] {
  const existingIndex = investigations.findIndex(({ id }) => id === investigation.id);
  if (existingIndex === -1) return [investigation, ...investigations];
  return investigations.map((current, index) =>
    index === existingIndex ? investigation : current);
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

/**
 * Owns the collection request lane independently of active-case routing.
 *
 * There is deliberately no `active` option: the mounted runtime may retain its
 * published collection while the shell temporarily leaves the investigation
 * surface. Authentication or authority changes still clear it immediately.
 */
export function useInvestigationList({
  gateway,
  enabled,
  identityKey,
  authorityKey,
}: UseInvestigationListOptions): InvestigationListController {
  const scope = useMemo<InvestigationListScope>(
    () => Object.freeze({ identityKey, authorityKey }),
    [identityKey, authorityKey],
  );
  const requestSlot = useRef(new RequestSlot<InvestigationListScope>());
  const [resource, setResource] = useState(() =>
    createResourceState<InvestigationListScope, readonly CaseV1[]>(),
  );
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (!enabled) {
      requestSlot.current.invalidate();
      setResource(createResourceState<InvestigationListScope, readonly CaseV1[]>());
      return;
    }

    const token = requestSlot.current.begin(scope);
    setResource((current) => beginResourceLoad(current, scope));

    void gateway.listInvestigations({ signal: token.signal })
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
  }, [enabled, gateway, refreshGeneration, scope]);

  const publishInvestigation = useCallback((investigation: CaseV1) => {
    if (!enabled) return;
    setResource((current) => {
      if (current.key !== scope) return current;
      const state = publishIntoState(
        current.state,
        (investigations) => mergeInvestigation(investigations, investigation),
      );
      return state === current.state ? current : { key: scope, state };
    });
  }, [enabled, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  return {
    investigations: enabled && resource.key === scope ? resource.state : { status: "idle" },
    publishInvestigation,
    refresh,
  };
}
