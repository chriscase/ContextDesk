import type {
  InvestigationActivityFilterV1,
  InvestigationActivityItemV1,
  InvestigationResourceLocatorV1,
} from "@cd-collab/contracts/investigation-activity";
import type { CaseV1 } from "@cd-collab/contracts/investigation-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  overviewGateway,
  type OverviewFailure,
  type OverviewGateway,
} from "./gateway.js";

export type ActivityResource =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly previous?: readonly InvestigationActivityItemV1[] }
  | { readonly status: "ready"; readonly items: readonly InvestigationActivityItemV1[] }
  | { readonly status: "failed"; readonly error: OverviewFailure; readonly previous?: readonly InvestigationActivityItemV1[] };

interface Scope {
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly filterKey: string;
}

export interface ActivityCenterController {
  readonly activity: ActivityResource;
  readonly investigations: readonly CaseV1[];
  readonly investigationsFailed: boolean;
  readonly nextCursor: string | null;
  readonly loadingMore: boolean;
  readonly openFailure: OverviewFailure | null;
  readonly refresh: () => void;
  readonly loadMore: () => void;
  readonly open: (locator: InvestigationResourceLocatorV1) => Promise<string | null>;
}

function mergeUnique(
  previous: readonly InvestigationActivityItemV1[],
  next: readonly InvestigationActivityItemV1[],
): readonly InvestigationActivityItemV1[] {
  const seen = new Set(previous.map(({ activityId }) => activityId));
  return [...previous, ...next.filter(({ activityId }) => !seen.has(activityId))];
}

export function useActivityCenter(options: {
  readonly enabled: boolean;
  readonly identityKey: string;
  readonly authorityKey: string;
  readonly filter: InvestigationActivityFilterV1;
  readonly gateway?: OverviewGateway;
}): ActivityCenterController {
  const gateway = options.gateway ?? overviewGateway;
  const filterKey = JSON.stringify(options.filter);
  // Equivalent filter objects share one request scope; callers need not memoize
  // a form-derived object merely to avoid a redundant network read.
  const stableFilter = useMemo(() => options.filter, [filterKey]);
  const scope = useMemo<Scope>(() => ({
    identityKey: options.identityKey,
    authorityKey: options.authorityKey,
    filterKey,
  }), [options.authorityKey, options.identityKey, filterKey]);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const resolveController = useRef<AbortController | null>(null);
  const publishedScope = useRef<string | null>(null);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [activity, setActivity] = useState<ActivityResource>({ status: "idle" });
  const [investigations, setInvestigations] = useState<readonly CaseV1[]>([]);
  const [investigationsFailed, setInvestigationsFailed] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openFailure, setOpenFailure] = useState<OverviewFailure | null>(null);

  useEffect(() => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const requestGeneration = ++generation.current;
    const current = () => generation.current === requestGeneration && !request.signal.aborted;
    setNextCursor(null);
    setLoadingMore(false);
    setOpenFailure(null);
    if (!options.enabled) {
      publishedScope.current = null;
      setActivity({ status: "idle" });
      setInvestigations([]);
      setInvestigationsFailed(false);
      return () => request.abort();
    }
    const scopeKey = `${scope.identityKey}\u0000${scope.authorityKey}\u0000${scope.filterKey}`;
    const sameScope = publishedScope.current === scopeKey;
    publishedScope.current = scopeKey;
    setActivity((value) => {
      const previous = sameScope
        ? value.status === "ready" ? value.items : value.status === "failed" ? value.previous : undefined
        : undefined;
      return previous ? { status: "loading", previous } : { status: "loading" };
    });
    void Promise.all([
      gateway.listActivity({ filter: stableFilter }, request.signal),
      gateway.listInvestigations(request.signal),
    ]).then(([activityResult, investigationResult]) => {
      if (!current()) return;
      if (activityResult.ok) {
        setActivity({ status: "ready", items: activityResult.value.items });
        setNextCursor(activityResult.value.nextCursor);
      } else {
        setActivity((value) => ({
          status: "failed",
          error: activityResult.error,
          ...(value.status === "loading" && value.previous ? { previous: value.previous } : {}),
        }));
      }
      if (investigationResult.ok) {
        setInvestigations(investigationResult.value);
        setInvestigationsFailed(false);
      } else {
        setInvestigations([]);
        setInvestigationsFailed(true);
      }
    });
    return () => {
      controller.current?.abort();
      resolveController.current?.abort();
      generation.current += 1;
    };
  }, [gateway, options.enabled, refreshGeneration, scope, stableFilter]);

  const refresh = useCallback(() => setRefreshGeneration((value) => value + 1), []);

  const loadMore = useCallback(() => {
    if (!options.enabled || !nextCursor || loadingMore) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    const requestGeneration = ++generation.current;
    setLoadingMore(true);
    void gateway.listActivity({ filter: stableFilter, cursor: nextCursor }, request.signal)
      .then(async (result) => {
        if (generation.current !== requestGeneration || request.signal.aborted) return;
        if (!result.ok && (result.error.kind === "stale_cursor" || result.error.kind === "malformed_cursor")) {
          const fresh = await gateway.listActivity({ filter: stableFilter }, request.signal);
          if (generation.current !== requestGeneration || request.signal.aborted) return;
          if (fresh.ok) {
            setActivity({ status: "ready", items: fresh.value.items });
            setNextCursor(fresh.value.nextCursor);
          } else {
            setActivity((value) => ({
              status: "failed", error: fresh.error,
              ...(value.status === "ready" ? { previous: value.items } : {}),
            }));
          }
          return;
        }
        if (result.ok) {
          setActivity((value) => ({
            status: "ready",
            items: mergeUnique(value.status === "ready" ? value.items : [], result.value.items),
          }));
          setNextCursor(result.value.nextCursor);
        } else {
          setActivity((value) => ({
            status: "failed", error: result.error,
            ...(value.status === "ready" ? { previous: value.items } : {}),
          }));
        }
      })
      .finally(() => {
        if (generation.current === requestGeneration) setLoadingMore(false);
      });
  }, [gateway, loadingMore, nextCursor, options.enabled, stableFilter]);

  const open = useCallback(async (locator: InvestigationResourceLocatorV1): Promise<string | null> => {
    if (!options.enabled) return null;
    resolveController.current?.abort();
    const request = new AbortController();
    resolveController.current = request;
    const requestGeneration = generation.current;
    setOpenFailure(null);
    const result = await gateway.resolve(locator, request.signal);
    if (generation.current !== requestGeneration || request.signal.aborted) return null;
    if (!result.ok) {
      setOpenFailure(result.error);
      return null;
    }
    return result.value.locator.pathname;
  }, [gateway, options.enabled]);

  return {
    activity, investigations, investigationsFailed, nextCursor, loadingMore,
    openFailure, refresh, loadMore, open,
  };
}
