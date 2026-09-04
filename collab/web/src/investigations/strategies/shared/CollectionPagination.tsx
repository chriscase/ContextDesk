import { useEffect, useRef, useState } from "react";

/** The small state shape needed by the presentation-only continuation control. */
export type CollectionPageView =
  | { readonly availability: "idle" | "loading" | "unavailable" }
  | {
      readonly availability: "available";
      readonly value: { readonly nextCursor: string | null };
      readonly refresh: "settled" | "loading" | "failed";
    };

export interface CollectionPaginationProps {
  readonly view: CollectionPageView;
  readonly onNextPage: () => void;
}

/**
 * A small, strategy-neutral continuation control. The cursor remains a
 * Runtime-owned detail: this component only renders the server's availability
 * signal and invokes the presentation adapter's already-authorized command.
 */
export function CollectionPagination({ view, onNextPage }: CollectionPaginationProps) {
  const [continuationStarted, setContinuationStarted] = useState(false);
  const completionRef = useRef<HTMLParagraphElement>(null);
  const completionFocusedRef = useRef(false);
  const available = view.availability === "available";
  const hasNextPage = available && view.value.nextCursor !== null;
  const loading = available && view.refresh === "loading";
  const continuationBusy = continuationStarted && (!available || loading);

  useEffect(() => {
    if (
      continuationStarted
      && !completionFocusedRef.current
      && available
      && !loading
      && !hasNextPage
    ) {
      completionFocusedRef.current = true;
      completionRef.current?.focus();
    }
  }, [available, continuationStarted, hasNextPage, loading]);

  if (!available && !continuationStarted) return null;
  if (available && !hasNextPage && !continuationStarted) return null;
  if (available && !hasNextPage && continuationStarted && !loading) {
    return (
      <nav className="strategy-kit__pagination" aria-label="Investigation pages">
        <p ref={completionRef} role="status" tabIndex={-1}>All loaded investigations are shown.</p>
      </nav>
    );
  }
  return (
    <nav className="strategy-kit__pagination" aria-label="Investigation pages">
      <button
        type="button"
        onClick={() => {
          if (continuationBusy) return;
          setContinuationStarted(true);
          onNextPage();
        }}
        aria-disabled={continuationBusy}
        aria-describedby="collection-pagination-status"
      >
        {continuationBusy ? "Loading next page…" : "Load next page"}
      </button>
      <span id="collection-pagination-status" className="sr-only" role="status" aria-live="polite">
        {continuationBusy ? "Loading more investigations. Previously loaded investigations remain available." : ""}
      </span>
    </nav>
  );
}
