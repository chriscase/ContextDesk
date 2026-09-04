import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollectionPagination,
  CollectionFacetFilters,
  StrategyActionRow,
  StrategyBadge,
  StrategyHero,
  StrategyPanel,
  StrategyStateNotice,
  StrategySurface,
} from "./index.js";
import type { InvestigationCollectionPageV1 } from "../../runtime/public.js";

const PAGE_WITH_CURSOR: InvestigationCollectionPageV1 = {
  schemaId: "cd-collab.investigation_collection_page.v1",
  items: [],
  nextCursor: "opaque-next-page",
  hiddenArchivedCount: 0,
  facets: {
    status: { top: [], otherCount: 0 },
    entity: { top: [], otherCount: 0 },
    impactIdentity: { top: [], otherCount: 0 },
    contributor: { top: [], otherCount: 0 },
  },
};

afterEach(cleanup);

describe("shared investigation strategy presentation kit", () => {
  it("provides labelled, composable presentation without behavior authority", () => {
    render(
      <StrategySurface className="example-strategy" labelledBy="example-title">
        <StrategyHero
          eyebrow="Read-only view"
          title="Example strategy"
          titleId="example-title"
          description={<p>Recorded data only.</p>}
          actions={<button type="button">Leave view</button>}
        />
        <StrategyPanel
          title="Recorded evidence"
          titleId="example-evidence"
          actions={<StrategyBadge tone="success">available</StrategyBadge>}
        >
          <StrategyStateNotice tone="warning" title="Refresh incomplete">
            The last available value remains visible.
          </StrategyStateNotice>
          <StrategyActionRow><button type="button">Retry</button></StrategyActionRow>
        </StrategyPanel>
      </StrategySurface>,
    );

    expect(screen.getByRole("heading", { name: "Example strategy" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recorded evidence" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("last available value");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("renders a keyboard-accessible continuation and disables it during refresh", () => {
    const onNextPage = vi.fn();
    const { rerender } = render(
      <CollectionPagination
        view={{ availability: "available", value: PAGE_WITH_CURSOR, refresh: "settled" }}
        onNextPage={onNextPage}
      />,
    );
    const button = screen.getByRole("button", { name: "Load next page" });
    expect(screen.getByRole("navigation", { name: "Investigation pages" })).toBeTruthy();
    button.click();
    expect(onNextPage).toHaveBeenCalledTimes(1);

    rerender(
      <CollectionPagination
        view={{ availability: "available", value: PAGE_WITH_CURSOR, refresh: "loading" }}
        onNextPage={onNextPage}
      />,
    );
    expect(screen.getByRole("button", { name: "Loading next page…" })).toHaveProperty("disabled", true);
  });

  it("does not invent a continuation when the Runtime has no cursor", () => {
    const onNextPage = vi.fn();
    render(
      <CollectionPagination
        view={{ availability: "available", value: { ...PAGE_WITH_CURSOR, nextCursor: null }, refresh: "settled" }}
        onNextPage={onNextPage}
      />,
    );
    expect(screen.queryByRole("navigation", { name: "Investigation pages" })).toBeNull();
  });

  it("exposes server-owned entity and contributor facets without inventing values", () => {
    const onQueryChange = vi.fn();
    const { rerender } = render(
      <CollectionFacetFilters
        query={{ entityId: null, contributorId: null }}
        entity={{ top: [{ key: "payments-api", count: 4 }], otherCount: 2 }}
        contributor={{ top: [{ key: "alice", count: 3 }], otherCount: 0 }}
        onQueryChange={onQueryChange}
      />,
    );

    expect(screen.getByText("More filters")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Entity" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Contributor" })).toBeTruthy();
    expect(screen.getByText("2 more entity values are outside the top results.")).toBeTruthy();

    const entity = screen.getByRole("button", { name: /payments-api\s+4/u });
    expect(entity.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(entity);
    expect(onQueryChange).toHaveBeenLastCalledWith({ entityId: "payments-api" });
    rerender(
      <CollectionFacetFilters
        query={{ entityId: "payments-api", contributorId: null }}
        entity={{ top: [{ key: "payments-api", count: 4 }], otherCount: 2 }}
        contributor={{ top: [{ key: "alice", count: 3 }], otherCount: 0 }}
        onQueryChange={onQueryChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /payments-api\s+4/u }));
    expect(onQueryChange).toHaveBeenLastCalledWith({ entityId: null });
  });

  it("keeps a selected value clearable when the server no longer returns its bucket", () => {
    const onQueryChange = vi.fn();
    render(
      <CollectionFacetFilters
        query={{ entityId: "retired-service", contributorId: null }}
        entity={{ top: [], otherCount: 0 }}
        onQueryChange={onQueryChange}
      />,
    );

    const selected = screen.getByRole("button", { name: /retired-service.*selected/u });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(selected);
    expect(onQueryChange).toHaveBeenCalledWith({ entityId: null });
  });

  it("supports contributor selection and clears both active facets together", () => {
    const onQueryChange = vi.fn();
    render(
      <CollectionFacetFilters
        query={{ entityId: "entity-northwind", contributorId: null }}
        entity={{ top: [{ key: "entity-northwind", count: 2 }], otherCount: 0 }}
        contributor={{ top: [{ key: "alice", count: 1 }], otherCount: 0 }}
        onQueryChange={onQueryChange}
      />,
    );

    fireEvent.click(screen.getByText("More filters"));
    fireEvent.click(screen.getByRole("button", { name: /alice\s+1/u }));
    expect(onQueryChange).toHaveBeenLastCalledWith({ contributorId: "alice" });
    fireEvent.click(screen.getByRole("button", { name: "Clear advanced filters" }));
    expect(onQueryChange).toHaveBeenLastCalledWith({ entityId: null, contributorId: null });
  });

  it("uses singular copy for one omitted server bucket", () => {
    render(
      <CollectionFacetFilters
        query={{ entityId: null, contributorId: null }}
        entity={{ top: [], otherCount: 1 }}
        onQueryChange={vi.fn()}
      />,
    );
    expect(screen.getByText("1 more entity value is outside the top results.")).toBeTruthy();
  });
});
