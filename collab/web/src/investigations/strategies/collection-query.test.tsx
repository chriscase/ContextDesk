import {
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  parseInvestigationCollectionPage,
} from "@cd-collab/contracts/investigation-collection";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import {
  DEFAULT_COLLECTION_QUERY,
  parsePathname,
  pathFor,
  sameLocation,
  type CollectionQueryLocation,
} from "../../app-location.js";
import { useInvestigationCollectionQuery } from "./collection-query.js";

afterEach(() => cleanup());
type QueryFn = NonNullable<InvestigationGateway["queryInvestigations"]>;

function emptyFacets() {
  return {
    status: { top: [], otherCount: 0 },
    entity: { top: [], otherCount: 0 },
    impactIdentity: { top: [], otherCount: 0 },
    contributor: { top: [], otherCount: 0 },
  };
}

function pageFixture() {
  return parseInvestigationCollectionPage({
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items: makeCaseList().cases,
    nextCursor: null,
    hiddenArchivedCount: 0,
    facets: emptyFacets(),
  });
}

function pageFixtureWithCursor(nextCursor: string): ReturnType<typeof pageFixture> {
  return parseInvestigationCollectionPage({
    ...pageFixture(),
    nextCursor,
  });
}

function Probe({ query }: { readonly query?: CollectionQueryLocation }) {
  const collection = useInvestigationCollectionQuery(query);
  const runtime = useInvestigationRuntime();
  return <output data-testid="query-state">{`${collection.enabled}:${runtime.resources.investigationCollectionQuery?.q ?? "idle"}`}</output>;
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

describe("investigation collection query shell adapter", () => {
  it("round-trips approved list filters and omits runtime cursor details", () => {
    const location = parsePathname(
      "/investigations",
      "?q=checkout&status=resolved&status=open&includeArchived=true&entityId=service:checkout&contributorId=alice&recordedFrom=2026-02-01T00:00:00.000Z",
    );
    expect(location).toMatchObject({ area: "investigations", caseId: null });
    expect((location as { collectionQuery?: CollectionQueryLocation }).collectionQuery?.status).toEqual([
      "open",
      "resolved",
    ]);
    const url = pathFor(location);
    expect(url).toContain("q=checkout");
    expect(url).toContain("status=open");
    expect(url).toContain("status=resolved");
    expect(url).not.toContain("cursor");
    expect(url).not.toContain("schemaId");
    const reparsed = new URL(url, "https://contextdesk.invalid");
    expect(parsePathname(reparsed.pathname, reparsed.search)).toEqual(location);
  });

  it("treats omitted and explicit defaults as the same list location", () => {
    const omitted = parsePathname("/investigations");
    const explicit = {
      ...omitted,
      collectionQuery: DEFAULT_COLLECTION_QUERY,
    };
    expect(sameLocation(omitted, explicit)).toBe(true);
    expect(pathFor(explicit)).toBe("/investigations");
  });

  it("keeps trailing search whitespace distinct while a controlled input is being edited", () => {
    const base = {
      area: "investigations" as const,
      caseId: null,
      stage: "situation" as const,
      collectionQuery: { ...DEFAULT_COLLECTION_QUERY, q: "Investigation First" },
    };
    const editing = {
      ...base,
      collectionQuery: { ...DEFAULT_COLLECTION_QUERY, q: "Investigation First " },
    };
    expect(sameLocation(base, editing)).toBe(false);
    expect(pathFor(editing)).toBe("/investigations?q=Investigation+First");
  });

  it("fails closed for malformed filters and leaves a canonical bare list route", () => {
    const location = parsePathname("/investigations", "?status=unknown&includeArchived=yes");
    expect(location).toEqual({ area: "investigations", caseId: null, stage: "situation" });
    expect(pathFor(location)).toBe("/investigations");
  });

  it("invokes the additive runtime command with normalized shell filters", async () => {
    const queryInvestigations = vi.fn<QueryFn>(
      async (_input, _options) => gatewayOk(pageFixture()),
    );
    const gateway = createInvestigationGatewayDouble({ queryInvestigations });
    renderProbe(gateway, {
      ...DEFAULT_COLLECTION_QUERY,
      q: "checkout",
      status: ["monitoring"],
    });
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));
    expect(queryInvestigations.mock.calls[0]?.[0]).toMatchObject({
      q: "checkout",
      status: ["monitoring"],
      includeArchived: false,
    });
  });

  it("continues with the runtime cursor without changing shell query state", async () => {
    let resolveContinuation: ((value: ReturnType<typeof gatewayOk<InvestigationCollectionPageV1>>) => void) | undefined;
    const continuation = new Promise<ReturnType<typeof gatewayOk<InvestigationCollectionPageV1>>>((resolve) => {
      resolveContinuation = resolve;
    });
    const queryInvestigations = vi.fn<QueryFn>(async (input) => input.cursor
      ? continuation
      : gatewayOk(pageFixtureWithCursor("eyJwYWdlIjoyfQ")));
    let nextPage: (() => void) | undefined;
    let refresh: (() => void) | undefined;
    function ProbeWithNext() {
      const collection = useInvestigationCollectionQuery({
        ...DEFAULT_COLLECTION_QUERY,
        q: "checkout",
      });
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
    expect(queryInvestigations.mock.calls[1]?.[0]).toMatchObject({
      q: "checkout",
      cursor: "eyJwYWdlIjoyfQ",
    });
    expect(screen.getByTestId("cursor-page").textContent).toMatch(/^loading:/u);

    resolveContinuation?.(gatewayOk({ ...pageFixture(), items: [], nextCursor: null }));
    await waitFor(() => expect(screen.getByTestId("cursor-page").textContent).toMatch(/^settled:/u));
    refresh?.();
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(3));
    expect(queryInvestigations.mock.calls[2]?.[0].cursor).toBeNull();
  });

  it("does not invoke or expose a query when the shell has no list query", async () => {
    const queryInvestigations = vi.fn<QueryFn>();
    const gateway = createInvestigationGatewayDouble({ queryInvestigations });
    renderProbe(gateway);
    await waitFor(() => expect(document.querySelector("[data-testid=query-state]")?.textContent).toBe("false:idle"));
    expect(queryInvestigations).not.toHaveBeenCalled();
    expect(gateway.listInvestigations).toHaveBeenCalled();
  });
});
