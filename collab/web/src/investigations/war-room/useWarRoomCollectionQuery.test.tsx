import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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

function pageWithCursor(nextCursor: string | null): InvestigationCollectionPageV1 {
  return { ...page(), nextCursor };
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

  it("re-reads the same canonical query after returning from investigation detail", async () => {
    const query: CollectionQueryLocation = {
      ...DEFAULT_COLLECTION_QUERY,
      q: "Investigation First ",
      status: ["open", "resolved"],
    };
    const reorderedQuery: CollectionQueryLocation = {
      ...query,
      status: ["resolved", "open"],
    };
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async () => gatewayOk(page()),
    );
    const gateway = createInvestigationGatewayDouble({ queryInvestigations });
    const rendered = renderProbe(gateway, query);
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));

    rendered.rerender(
      <InvestigationRuntimeGatewayHarness gateway={gateway}>
        <InvestigationRuntimeProvider
          identityKey="alice"
          identity={{ id: "alice", username: "alice", displayName: "Alice" }}
          authorityKey="authority-v1"
          capabilities={["investigation:read"]}
          readOnly={false}
          active
          focusCaseId="case-1"
          isInvestigationLocation
          onOpenCreated={vi.fn()}
        >
          <Probe />
        </InvestigationRuntimeProvider>
      </InvestigationRuntimeGatewayHarness>,
    );
    expect(queryInvestigations).toHaveBeenCalledTimes(1);

    rendered.rerender(
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
          <Probe query={reorderedQuery} />
        </InvestigationRuntimeProvider>
      </InvestigationRuntimeGatewayHarness>,
    );
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(2));
    expect(queryInvestigations.mock.calls[1]?.[0]).toEqual(queryInvestigations.mock.calls[0]?.[0]);
    expect(queryInvestigations.mock.calls[1]?.[0].q).toBe("Investigation First");
  });

  it("does not refresh an active query with hidden dimensions on list re-entry", async () => {
    type QueryFn = NonNullable<InvestigationGateway["queryInvestigations"]>;
    const queryInvestigations = vi.fn<QueryFn>(async () => gatewayOk(page()));
    const gateway = createInvestigationGatewayDouble({ queryInvestigations });
    let seedQuery: ((input: Parameters<QueryFn>[0]) => void) | null | undefined;
    function FenceProbe({ query }: { readonly query?: CollectionQueryLocation }) {
      const collection = useWarRoomCollectionQuery(query);
      const runtime = useInvestigationRuntime();
      seedQuery = runtime.commands.queryInvestigations;
      return <output data-testid="fence-state">{
        `${collection.view.availability}:${runtime.resources.investigationCollection.status}`
      }</output>;
    }
    const provider = (child: ReactNode) => (
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
          {child}
        </InvestigationRuntimeProvider>
      </InvestigationRuntimeGatewayHarness>
    );
    const rendered = render(provider(<FenceProbe />));

    act(() => seedQuery?.({
      q: "checkout",
      impactIdentity: {
        productName: "ContextDesk",
        version: "1",
        build: "",
        component: "web",
        environment: "test",
      },
      limit: 25,
    }));
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("fence-state").textContent).toBe("idle:ready"));

    rendered.rerender(provider(<FenceProbe query={{ ...DEFAULT_COLLECTION_QUERY, q: "checkout" }} />));
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(2));
    expect(queryInvestigations.mock.calls[0]?.[0]).toMatchObject({
      impactIdentity: { productName: "ContextDesk" },
      limit: 25,
    });
    expect(queryInvestigations.mock.calls[1]?.[0]).toMatchObject({
      impactIdentity: null,
      limit: 50,
    });
  });

  it("continues with the runtime cursor without changing shell query state", async () => {
    let resolveContinuation: ((value: ReturnType<typeof gatewayOk<InvestigationCollectionPageV1>>) => void) | undefined;
    const continuation = new Promise<ReturnType<typeof gatewayOk<InvestigationCollectionPageV1>>>((resolve) => {
      resolveContinuation = resolve;
    });
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async (input) => input.cursor
        ? continuation
        : gatewayOk(pageWithCursor("eyJwYWdlIjoyfQ")),
    );
    let nextPage: (() => void) | undefined;
    let refresh: (() => void) | undefined;
    function ProbeWithNext() {
      const collection = useWarRoomCollectionQuery(DEFAULT_COLLECTION_QUERY);
      nextPage = collection.nextPage;
      refresh = collection.refresh;
      return <output data-testid="cursor-page">{
        collection.view.availability === "available"
          ? `${collection.view.refresh}:${collection.view.value.items.length}`
          : collection.view.availability
      }</output>;
    }
    render(
      <InvestigationRuntimeGatewayHarness gateway={createInvestigationGatewayDouble({ queryInvestigations })}>
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
          <ProbeWithNext />
        </InvestigationRuntimeProvider>
      </InvestigationRuntimeGatewayHarness>,
    );
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("cursor-page").textContent).toMatch(/^settled:/u));
    nextPage?.();
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(2));
    nextPage?.();
    expect(queryInvestigations).toHaveBeenCalledTimes(2);
    expect(queryInvestigations.mock.calls[1]?.[0]).toMatchObject({ cursor: "eyJwYWdlIjoyfQ" });
    expect(queryInvestigations.mock.calls[1]?.[0]).toMatchObject({ includeArchived: false });
    expect(screen.getByTestId("cursor-page").textContent).toMatch(/^loading:/u);

    resolveContinuation?.(gatewayOk({ ...page(), items: [], nextCursor: null }));
    await waitFor(() => expect(screen.getByTestId("cursor-page").textContent).toMatch(/^settled:/u));
    refresh?.();
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(3));
    expect(queryInvestigations.mock.calls[2]?.[0].cursor).toBeNull();
  });

  it("retries a failed continuation only after another click and appends its page", async () => {
    const [firstItem, secondItem] = makeCaseList().cases;
    let continuationAttempts = 0;
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async (input) => {
        if (!input.cursor) {
          return gatewayOk({
            ...page(),
            items: [firstItem!],
            nextCursor: "eyJwYWdlIjoyfQ",
          });
        }
        continuationAttempts += 1;
        return continuationAttempts === 1
          ? { ok: false, error: { kind: "network" } }
          : gatewayOk({ ...page(), items: [secondItem!], nextCursor: null });
      },
    );
    let nextPage: (() => void) | undefined;
    function RetryProbe() {
      const collection = useWarRoomCollectionQuery({
        ...DEFAULT_COLLECTION_QUERY,
        q: "checkout ",
      });
      nextPage = collection.nextPage;
      return <output data-testid="retry-page">{
        collection.view.availability === "available"
          ? `${collection.view.refresh}:${collection.view.value.items.length}`
          : collection.view.availability
      }</output>;
    }
    render(
      <InvestigationRuntimeGatewayHarness gateway={createInvestigationGatewayDouble({ queryInvestigations })}>
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
          <RetryProbe />
        </InvestigationRuntimeProvider>
      </InvestigationRuntimeGatewayHarness>,
    );

    await waitFor(() => expect(screen.getByTestId("retry-page").textContent).toBe("settled:1"));
    nextPage?.();
    await waitFor(() => expect(screen.getByTestId("retry-page").textContent).toBe("failed:1"));
    expect(queryInvestigations).toHaveBeenCalledTimes(2);

    nextPage?.();
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId("retry-page").textContent).toBe("settled:2"));
    expect(queryInvestigations.mock.calls[1]?.[0].cursor).toBe("eyJwYWdlIjoyfQ");
    expect(queryInvestigations.mock.calls[2]?.[0]).toEqual(queryInvestigations.mock.calls[1]?.[0]);
    expect(queryInvestigations.mock.calls[2]?.[0].q).toBe("checkout");
  });
});
