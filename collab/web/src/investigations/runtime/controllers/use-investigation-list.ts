import type { CaseV1 } from "@cd-collab/contracts";
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
  /** Changes whenever the authenticated identity changes. */
  readonly identityKey: string;
  /** Changes whenever the effective capability/read-only projection changes. */
  readonly authorityKey: string;
}

export interface InvestigationListController {
  readonly investigations: ResourceState<readonly CaseV1[]>;
  readonly refresh: () => void;
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
  }, [gateway, refreshGeneration, scope]);

  const refresh = useCallback(() => {
    setRefreshGeneration((current) => current + 1);
  }, []);

  return {
    investigations: resource.key === scope ? resource.state : { status: "idle" },
    refresh,
  };
}
