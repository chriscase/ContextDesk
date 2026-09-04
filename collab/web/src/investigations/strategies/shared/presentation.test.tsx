import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CollectionPagination,
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

  it("keeps focus recoverable through continuation loading and completion", async () => {
    const onNextPage = vi.fn();
    const { rerender } = render(
      <CollectionPagination
        view={{ availability: "available", value: PAGE_WITH_CURSOR, refresh: "settled" }}
        onNextPage={onNextPage}
      />,
    );
    const button = screen.getByRole("button", { name: "Load next page" });
    expect(screen.getByRole("navigation", { name: "Investigation pages" })).toBeTruthy();
    button.focus();
    button.click();
    expect(onNextPage).toHaveBeenCalledTimes(1);

    rerender(
      <CollectionPagination
        view={{ availability: "available", value: PAGE_WITH_CURSOR, refresh: "loading" }}
        onNextPage={onNextPage}
      />,
    );
    const loadingButton = screen.getByRole("button", { name: "Loading next page…" });
    expect(loadingButton.getAttribute("aria-disabled")).toBe("true");
    expect(loadingButton).toBe(document.activeElement);
    loadingButton.click();
    expect(onNextPage).toHaveBeenCalledTimes(1);

    rerender(
      <CollectionPagination
        view={{
          availability: "available",
          value: PAGE_WITH_CURSOR,
          refresh: "failed",
        }}
        onNextPage={onNextPage}
      />,
    );
    const retryContinuation = screen.getByRole("button", { name: "Load next page" });
    expect(retryContinuation).toBe(document.activeElement);
    retryContinuation.click();

    rerender(
      <CollectionPagination
        view={{ availability: "available", value: PAGE_WITH_CURSOR, refresh: "loading" }}
        onNextPage={onNextPage}
      />,
    );

    rerender(
      <CollectionPagination
        view={{ availability: "available", value: { ...PAGE_WITH_CURSOR, nextCursor: null }, refresh: "settled" }}
        onNextPage={onNextPage}
      />,
    );
    const completion = screen.getByRole("status", { name: "" });
    await waitFor(() => expect(completion).toBe(document.activeElement));
    expect(completion.textContent).toContain("All loaded investigations are shown");

    const unrelatedControl = document.createElement("button");
    document.body.append(unrelatedControl);
    unrelatedControl.focus();
    rerender(
      <CollectionPagination
        view={{ availability: "available", value: { ...PAGE_WITH_CURSOR, nextCursor: null }, refresh: "loading" }}
        onNextPage={onNextPage}
      />,
    );
    rerender(
      <CollectionPagination
        view={{ availability: "available", value: { ...PAGE_WITH_CURSOR, nextCursor: null }, refresh: "settled" }}
        onNextPage={onNextPage}
      />,
    );
    expect(unrelatedControl).toBe(document.activeElement);
    unrelatedControl.remove();
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
});
