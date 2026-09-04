import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationRuntimeGatewayHarness,
  createInvestigationGatewayDouble,
  gatewayOk,
  makeCaseList,
  type InvestigationGateway,
} from "../runtime/testkit/index.js";
import {
  InvestigationRuntimeProvider,
  useInvestigationRuntime,
  type InvestigationCollectionPageV1,
} from "../runtime/public.js";
import { DEFAULT_COLLECTION_QUERY, type CollectionQueryLocation } from "../../app-location.js";
import { useWarRoomCollectionQuery } from "./useWarRoomCollectionQuery.js";

afterEach(cleanup);

function page(): InvestigationCollectionPageV1 {
  return {
    schemaId: "cd-collab.investigation_collection_page.v1",
    items: makeCaseList().cases,
    nextCursor: null,
    hiddenArchivedCount: 0,
    facets: {
      status: { top: [], otherCount: 0 },
      entity: { top: [], otherCount: 0 },
      impactIdentity: { top: [], otherCount: 0 },
      contributor: { top: [], otherCount: 0 },
    },
  };
}

function Probe({ query }: { readonly query?: CollectionQueryLocation }) {
  const collection = useWarRoomCollectionQuery(query);
  const runtime = useInvestigationRuntime();
  return (
    <output data-testid="war-room-query">
      {`${runtime.resources.investigationCollectionQuery?.q ?? "idle"}:${collection.view.availability}`}
    </output>
  );
}

function renderProbe(gateway: InvestigationGateway, query?: CollectionQueryLocation) {
  return render(
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey="alice"
        identity={{ id: "alice", username: "alice", displayName: "Alice" }}
        authorityKey="authority-v1"
        capabilities={["investigation:read"]}
        readOnly={false}
        active
        focusCaseId={null}
        isInvestigationLocation
        onOpenCreated={vi.fn()}
      >
        <Probe {...(query ? { query } : {})} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>,
  );
}

describe("War Room collection query adapter", () => {
  it("maps shell filters to the public runtime command once", async () => {
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async () => gatewayOk(page()),
    );
    renderProbe(createInvestigationGatewayDouble({ queryInvestigations }), {
      ...DEFAULT_COLLECTION_QUERY,
      q: "checkout",
      status: ["monitoring"],
      includeArchived: true,
    });
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));
    expect(queryInvestigations.mock.calls[0]?.[0]).toMatchObject({
      q: "checkout",
      status: ["monitoring"],
      includeArchived: true,
    });
  });

  it("does not query when the shell has no collection location", () => {
    const queryInvestigations = vi.fn();
    renderProbe(createInvestigationGatewayDouble({ queryInvestigations }));
    expect(queryInvestigations).not.toHaveBeenCalled();
  });
});
