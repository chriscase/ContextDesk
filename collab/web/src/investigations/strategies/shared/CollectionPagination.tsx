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
  const available = view.availability === "available";
  const hasNextPage = available && view.value.nextCursor !== null;
  const loading = available && view.refresh === "loading";

  useEffect(() => {
    if (continuationStarted && available && !loading && !hasNextPage) {
      completionRef.current?.focus();
    }
  }, [available, continuationStarted, hasNextPage, loading]);

  if (!available || (!hasNextPage && !continuationStarted)) return null;
  if (!hasNextPage) {
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
          setContinuationStarted(true);
          onNextPage();
        }}
        disabled={loading}
        aria-describedby="collection-pagination-status"
      >
        {loading ? "Loading next page…" : "Load next page"}
      </button>
      <span id="collection-pagination-status" className="sr-only" role="status" aria-live="polite">
        {loading ? "Loading more investigations. Previously loaded investigations remain available." : ""}
      </span>
    </nav>
  );
}
