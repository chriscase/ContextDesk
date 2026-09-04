import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InvestigationCollectionPageV1 } from "../runtime/public.js";
import { DEFAULT_COLLECTION_QUERY } from "../../app-location.js";
import { WarRoomCollectionList } from "./WarRoomCollectionList.js";

const PAGE: InvestigationCollectionPageV1 = {
  schemaId: "cd-collab.investigation_collection_page.v1",
  items: [],
  nextCursor: null,
  hiddenArchivedCount: 0,
  facets: {
    status: { top: [], otherCount: 0 },
    entity: { top: [{ key: "entity-northwind", count: 3 }], otherCount: 1 },
    impactIdentity: { top: [], otherCount: 0 },
    contributor: { top: [{ key: "alice", count: 2 }], otherCount: 0 },
  },
};

describe("War Room collection facet controls", () => {
  it("uses server-provided entity and contributor buckets without local recomputation", () => {
    const onQueryChange = vi.fn();
    render(
      <WarRoomCollectionList
        page={{ availability: "available", value: PAGE, refresh: "settled" }}
        query={DEFAULT_COLLECTION_QUERY}
        canRead
        readOnly={false}
        onQueryChange={onQueryChange}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("More filters"));
    expect(screen.getByText("1 more entity value is outside the top results.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /entity-northwind\s+3/u }));
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ entityId: "entity-northwind" }));
  });
});
