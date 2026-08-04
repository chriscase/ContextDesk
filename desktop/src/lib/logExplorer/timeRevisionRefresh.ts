/**
 * Ordered refresh after a corpus time revision is published (#819).
 *
 * A timezone apply or undo republishes event timestamps, so every downstream
 * snapshot is stale. The order below is the contract, not a preference:
 *
 * 1. invalidate in-flight event requests, so a pre-change response can never
 *    be adopted after the revision changes;
 * 2. refresh the corpus summary (new revision, counts, time quality);
 * 3. reload trusted suppression resolution, because template identity may have
 *    moved and a rule that used to apply may now match nothing;
 * 4. reload the active investigation under the *current* lens, so finding
 *    bindings are compared against the new policy;
 * 5. only then repaint facets and rows, which is the first step allowed to
 *    read exclusions.
 *
 * Steps run sequentially. No query may reuse pre-change exclusions, so facets
 * and rows must not start before suppression resolution has been reloaded.
 */
export type TimeRevisionRefreshSteps = {
  /** Bump the in-flight request generation; must not be async. */
  invalidateInFlight: () => void;
  refreshSummary: () => Promise<unknown>;
  refreshSuppressionPolicy: () => Promise<unknown>;
  reloadActiveInvestigation: () => Promise<unknown>;
  loadFacets: () => Promise<unknown>;
  loadEvents: () => Promise<unknown>;
};

/** Exact step order asserted by tests and relied on by the Explorer. */
export const TIME_REVISION_REFRESH_ORDER = [
  "invalidateInFlight",
  "refreshSummary",
  "refreshSuppressionPolicy",
  "reloadActiveInvestigation",
  "loadFacets",
  "loadEvents",
] as const;

export async function refreshAfterTimeRevision(
  steps: TimeRevisionRefreshSteps,
): Promise<void> {
  steps.invalidateInFlight();
  await steps.refreshSummary();
  await steps.refreshSuppressionPolicy();
  await steps.reloadActiveInvestigation();
  await steps.loadFacets();
  await steps.loadEvents();
}

/**
 * Serialize revision refreshes and collapse any burst received while a refresh
 * is running into one follow-up pass. `getSteps` reads the latest React
 * callbacks without forcing the cross-webview listener to be re-registered.
 */
export function createCoalescedTimeRevisionRefresh(
  getSteps: () => TimeRevisionRefreshSteps,
  onError: (error: unknown) => void,
): { request: () => void; dispose: () => void } {
  let disposed = false;
  let running = false;
  let pending = false;

  const drain = async () => {
    running = true;
    do {
      pending = false;
      try {
        await refreshAfterTimeRevision(getSteps());
      } catch (error) {
        if (!disposed) onError(error);
      }
    } while (!disposed && pending);
    running = false;
  };

  return {
    request: () => {
      if (disposed) return;
      if (running) {
        pending = true;
        return;
      }
      void drain();
    },
    dispose: () => {
      disposed = true;
      pending = false;
    },
  };
}
