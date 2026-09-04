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
  if (view.availability !== "available" || view.value.nextCursor === null) return null;
  const loading = view.refresh === "loading";
  return (
    <nav className="strategy-kit__pagination" aria-label="Investigation pages">
      <button type="button" onClick={onNextPage} disabled={loading}>
        {loading ? "Loading next page…" : "Load next page"}
      </button>
    </nav>
  );
}
