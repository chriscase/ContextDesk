import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathFor, DEFAULT_COLLECTION_QUERY, type CollectionQueryLocation } from "../../app-location.js";
import {
  InvestigationRuntimeProvider,
  type InvestigationCollectionPageV1,
  type ResourceView,
} from "../runtime/public.js";
import {
  createInvestigationGatewayDouble,
  gatewayOk,
  InvestigationRuntimeGatewayHarness,
  makePopulatedCase,
  type InvestigationGateway,
} from "../runtime/testkit/index.js";
import type { InvestigationStrategyShellProps } from "./contract.js";
import { BeaconStrategy } from "./beacon/BeaconStrategy.js";
import { InvestigationFirstStrategy } from "./investigation-first/InvestigationFirstStrategy.js";
import { KeystoneStrategy } from "./keystone/KeystoneStrategy.js";
import { WarRoomCollectionList } from "../war-room/WarRoomCollectionList.js";
import { collectionEmptyMessage, shareableQueryNarrows } from "./collection-discovery.js";

afterEach(cleanup);

const IMPACT = {
  productName: "Fixture Desk",
  version: "4.2",
  build: "",
  component: "queue-worker",
  environment: "",
};

const QUERY: CollectionQueryLocation = {
  ...DEFAULT_COLLECTION_QUERY,
  contributorId: "identity-erin",
  recordedFrom: "2026-08-01T00:00:00.000Z",
  recordedTo: "2026-08-31T23:59:59.999Z",
  impactIdentity: IMPACT,
  entityId: "ent-northwind",
};

function discoveryPage(items: InvestigationCollectionPageV1["items"]): InvestigationCollectionPageV1 {
  return {
    schemaId: "cd-collab.investigation_collection_page.v1",
    items,
    nextCursor: null,
    hiddenArchivedCount: 8,
    facets: {
      status: {
        top: [
          { key: "open", count: 11 },
          { key: "monitoring", count: 0 },
          { key: "resolved", count: 0 },
          { key: "archived", count: 0 },
        ],
        otherCount: 0,
      },
      entity: { top: [{ key: "ent-northwind", count: 5 }], otherCount: 4 },
      impactIdentity: { top: [{ key: "Fixture Desk · 4.2 · queue-worker", count: 4, identity: IMPACT }], otherCount: 7 },
      contributor: { top: [{ key: "identity-erin", count: 3 }], otherCount: 2 },
    },
  };
}

function available(page: InvestigationCollectionPageV1): ResourceView<InvestigationCollectionPageV1> {
  return { availability: "available", value: page, refresh: "settled" };
}

describe("collection discovery empty copy", () => {
  it("treats contributor and recorded-at as filters and leaves archive widening alone", () => {
    expect(shareableQueryNarrows(DEFAULT_COLLECTION_QUERY)).toBe(false);
    expect(shareableQueryNarrows({ ...DEFAULT_COLLECTION_QUERY, includeArchived: true })).toBe(false);
    expect(shareableQueryNarrows({ ...DEFAULT_COLLECTION_QUERY, contributorId: "identity-erin" })).toBe(true);
    expect(shareableQueryNarrows({
      ...DEFAULT_COLLECTION_QUERY,
      recordedFrom: "2026-08-01T00:00:00.000Z",
    })).toBe(true);
    expect(collectionEmptyMessage(false)).toBe("No investigations have been recorded yet.");
    expect(collectionEmptyMessage(true)).not.toMatch(/have been recorded/u);
    expect(collectionEmptyMessage(true, { pageLocal: true })).toMatch(/on this loaded page/u);
  });
});

describe("War Room collection discovery", () => {
  it("shows server facet counts and does not call an empty contributor filter unrecorded", () => {
    const item = { ...makePopulatedCase(), title: "Synthetic checkout investigation" };
    const onQueryChange = vi.fn();
    const onOpenCase = vi.fn();
    const page = discoveryPage([item]);
    render(
      <WarRoomCollectionList
        page={available(page)}
        query={QUERY}
        canRead
        readOnly
        occurredFrom=""
        onOccurredFromChange={vi.fn()}
        onQueryChange={onQueryChange}
        onRefresh={vi.fn()}
        onOpenCase={onOpenCase}
      />,
    );

    expect(screen.getByRole("option", { name: "Fixture Desk · 4.2 · queue-worker (4)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "identity-erin (3)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "ent-northwind (5)" })).toBeTruthy();
    expect(screen.getByText("Other software impact identities: 7")).toBeTruthy();
    expect(screen.getByText("Other contributors: 2")).toBeTruthy();
    expect(screen.getByText("Other entities: 4")).toBeTruthy();
    expect(screen.getByText("8 archived investigations are hidden. Check “Include archived” to show them.")).toBeTruthy();
    expect(screen.getByLabelText("Filter investigations by observed date")).toBeTruthy();
    expect(screen.getByText("Observed from")).toBeTruthy();
    expect((screen.getByLabelText("Filter investigations by recorded date from") as HTMLInputElement).value).toBe("2026-08-01");
    expect((screen.getByLabelText("Filter investigations by recorded date to") as HTMLInputElement).value).toBe("2026-08-31");

    fireEvent.click(screen.getByRole("button", { name: "Synthetic checkout investigation" }));
    expect(onOpenCase).toHaveBeenCalledWith(item.id);

    fireEvent.change(screen.getByLabelText("Filter investigations by contributor"), { target: { value: "" } });
    const next = onQueryChange.mock.calls[0]?.[0] as CollectionQueryLocation;
    expect(next.contributorId).toBeNull();
    expect(next).not.toHaveProperty("cursor");
    expect(next).not.toHaveProperty("limit");
    expect(next).not.toHaveProperty("schemaId");
    const url = pathFor({
      area: "investigations",
      caseId: null,
      stage: "situation",
      collectionQuery: next,
    });
    expect(url).not.toMatch(/cursor|schemaId|limit/u);
  });

  it("keeps contributor-only and recorded-date-only empties distinct from an unrecorded collection", () => {
    const page = discoveryPage([]);
    const { rerender } = render(
      <WarRoomCollectionList
        page={available(page)}
        query={{ ...DEFAULT_COLLECTION_QUERY, contributorId: "identity-erin" }}
        canRead
        readOnly
        onOccurredFromChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    expect(screen.getByText("No investigations match the current search or filter.")).toBeTruthy();
    expect(screen.queryByText(/have been recorded/u)).toBeNull();

    rerender(
      <WarRoomCollectionList
        page={available(page)}
        query={{ ...DEFAULT_COLLECTION_QUERY, recordedFrom: "2026-08-01T00:00:00.000Z" }}
        canRead
        readOnly
        onOccurredFromChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    expect(screen.getByText("No investigations match the current search or filter.")).toBeTruthy();
    expect(screen.queryByText(/on this loaded page/u)).toBeNull();

    rerender(
      <WarRoomCollectionList
        page={available(discoveryPage([]))}
        query={DEFAULT_COLLECTION_QUERY}
        canRead
        readOnly
        occurredFrom="2026-02-01"
        onOccurredFromChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    expect(screen.getByText("No investigations match the current search or filter on this loaded page.")).toBeTruthy();

    rerender(
      <WarRoomCollectionList
        page={available(discoveryPage([]))}
        query={DEFAULT_COLLECTION_QUERY}
        canRead
        readOnly
        onOccurredFromChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    expect(screen.getByText("No investigations have been recorded yet.")).toBeTruthy();
  });

  it("keeps an impact outside the top facets understandable and clearable", () => {
    const outside = {
      productName: "Absent Desk",
      version: "9",
      build: "z",
      component: "worker",
      environment: "lab",
    };
    const onQueryChange = vi.fn();
    render(
      <WarRoomCollectionList
        page={available(discoveryPage([]))}
        query={{ ...DEFAULT_COLLECTION_QUERY, q: "keep-me", impactIdentity: outside }}
        canRead
        readOnly
        onOccurredFromChange={vi.fn()}
        onQueryChange={onQueryChange}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
        cursorRestartNotice="The previous page marker was rejected. These results were loaded again from the start of this search and do not include the discarded page."
      />,
    );
    expect(screen.getByRole("option", {
      name: "Absent Desk · 9 · z · worker · lab (not in the current top matches)",
    })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Absent Desk · 9 · z · worker · lab \(\d+\)/u })).toBeNull();
    expect(screen.getByText(/UTC calendar day/u)).toBeTruthy();
    expect(screen.getByText(/previous page marker was rejected/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {
      name: "Clear Software impact: Absent Desk · 9 · z · worker · lab",
    }));
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({
      impactIdentity: null,
      q: "keep-me",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all collection filters" }));
    const cleared = onQueryChange.mock.calls.at(-1)?.[0] as CollectionQueryLocation;
    expect(cleared).toEqual(DEFAULT_COLLECTION_QUERY);
    expect(Object.keys(cleared).sort()).toEqual([
      "contributorId",
      "entityId",
      "impactIdentity",
      "includeArchived",
      "q",
      "recordedFrom",
      "recordedTo",
      "status",
    ]);
  });

  it("does not keep a reversed recorded range active", () => {
    const onQueryChange = vi.fn();
    render(
      <WarRoomCollectionList
        page={available(discoveryPage([]))}
        query={{
          ...DEFAULT_COLLECTION_QUERY,
          recordedFrom: "2026-08-01T00:00:00.000Z",
          recordedTo: "2026-08-31T23:59:59.999Z",
        }}
        canRead
        readOnly
        onOccurredFromChange={vi.fn()}
        onQueryChange={onQueryChange}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter investigations by recorded date from"), {
      target: { value: "2026-09-15" },
    });
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Clear Recorded from 2026-08-01 UTC" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Recorded from 2026-09-15/u })).toBeNull();
  });

  it("does not show collection actions or prior filters to a denied reader", () => {
    render(
      <WarRoomCollectionList
        page={available(discoveryPage([makePopulatedCase()]))}
        query={QUERY}
        canRead={false}
        readOnly
        onOccurredFromChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    expect(screen.getByText(/no investigation data was requested/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load next page" })).toBeNull();
    expect(screen.queryByLabelText("Filter investigations by contributor")).toBeNull();
    expect(screen.queryByText("Synthetic checkout investigation")).toBeNull();
  });

  it("does not describe an unavailable collection as zero recorded investigations", () => {
    render(
      <WarRoomCollectionList
        page={{ availability: "unavailable", error: { kind: "unavailable", status: 503 } }}
        query={DEFAULT_COLLECTION_QUERY}
        canRead
        readOnly
        onOccurredFromChange={vi.fn()}
        onRefresh={vi.fn()}
        onOpenCase={vi.fn()}
      />,
    );
    expect(screen.getByText(/unavailable right now/u)).toBeTruthy();
    expect(screen.queryByText(/have been recorded/u)).toBeNull();
    expect(screen.queryByText(/match the current search/u)).toBeNull();
  });
});

const PRESENTATIONS: Array<{
  name: string;
  Strategy: ComponentType<InvestigationStrategyShellProps>;
  row: RegExp;
}> = [
  { name: "Investigation First", Strategy: InvestigationFirstStrategy, row: /Synthetic checkout investigation/u },
  { name: "Keystone", Strategy: KeystoneStrategy, row: /Synthetic checkout investigation/u },
  { name: "Beacon", Strategy: BeaconStrategy, row: /Synthetic checkout investigation/u },
];

function mountPresentation(
  Strategy: ComponentType<InvestigationStrategyShellProps>,
  options: {
    readonly capabilities: readonly string[];
    readonly queryInvestigations: NonNullable<InvestigationGateway["queryInvestigations"]>;
    readonly shell?: Partial<InvestigationStrategyShellProps>;
  },
) {
  const onOpenCase = vi.fn();
  const onCollectionQueryChange = vi.fn();
  const gateway = createInvestigationGatewayDouble({
    queryInvestigations: options.queryInvestigations,
  });
  const shell: InvestigationStrategyShellProps = {
    view: "investigations",
    focusCaseId: null,
    stage: "situation",
    onOpenCase,
    onNavigateInvestigation: vi.fn(),
    onExitFocus: vi.fn(),
    collectionQuery: QUERY,
    onCollectionQueryChange,
    ...options.shell,
  };
  render(
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey="alice"
        identity={{ id: "alice", username: "alice", displayName: "Alice" }}
        authorityKey="authority-v1"
        capabilities={options.capabilities}
        readOnly={false}
        active
        focusCaseId={null}
        isInvestigationLocation
        onOpenCreated={onOpenCase}
      >
        <Strategy {...shell} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>,
  );
  return { onOpenCase, onCollectionQueryChange, gateway };
}

describe.each(PRESENTATIONS)("$name collection discovery", ({ Strategy, row }) => {
  it("shows the server page, authoritative counts, and a shareable filter change", async () => {
    const item = { ...makePopulatedCase(), title: "Synthetic checkout investigation" };
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async () => gatewayOk(discoveryPage([item])),
    );
    const mounted = mountPresentation(Strategy, {
      capabilities: ["investigation:read", "investigation:write", "run:strategies"],
      queryInvestigations,
    });
    expect(await screen.findByRole("button", { name: row })).toBeTruthy();
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalled());
    expect(queryInvestigations.mock.calls[0]?.[0]).toMatchObject({
      contributorId: "identity-erin",
      impactIdentity: IMPACT,
      recordedFrom: "2026-08-01T00:00:00.000Z",
      recordedTo: "2026-08-31T23:59:59.999Z",
      entityId: "ent-northwind",
    });
    expect(queryInvestigations.mock.calls[0]?.[0]?.cursor ?? null).toBeNull();
    expect(screen.getByRole("option", { name: "Fixture Desk · 4.2 · queue-worker (4)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "identity-erin (3)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "ent-northwind (5)" })).toBeTruthy();
    expect(screen.getByText("Other software impact identities: 7")).toBeTruthy();
    expect(screen.getByText(/8 archived hidden/u)).toBeTruthy();
    expect(screen.getByText("open").parentElement?.textContent).toMatch(/11/);

    fireEvent.click(screen.getByRole("button", { name: row }));
    expect(mounted.onOpenCase).toHaveBeenCalledWith(item.id);

    fireEvent.change(screen.getByLabelText("Filter investigations by recorded date from"), {
      target: { value: "2026-08-15" },
    });
    const next = mounted.onCollectionQueryChange.mock.calls.at(-1)?.[0] as CollectionQueryLocation;
    expect(next.recordedFrom).toBe("2026-08-15T00:00:00.000Z");
    expect(next).not.toHaveProperty("cursor");
    expect(pathFor({
      area: "investigations",
      caseId: null,
      stage: "situation",
      collectionQuery: next,
    })).not.toMatch(/cursor|schemaId|\blimit\b/u);
  });

  it("does not describe a contributor-only miss as an unrecorded collection", async () => {
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async () => gatewayOk(discoveryPage([])),
    );
    mountPresentation(Strategy, {
      capabilities: ["investigation:read"],
      queryInvestigations,
      shell: {
        collectionQuery: { ...DEFAULT_COLLECTION_QUERY, contributorId: "identity-erin" },
      },
    });
    expect(await screen.findByText("No investigations match the current search or filter.")).toBeTruthy();
    expect(screen.queryByText("No investigations have been recorded yet.")).toBeNull();
    expect(screen.queryByText("No investigations recorded")).toBeNull();
  });

  it("issues no collection request when read is denied", async () => {
    const queryInvestigations = vi.fn<NonNullable<InvestigationGateway["queryInvestigations"]>>(
      async () => gatewayOk(discoveryPage([])),
    );
    mountPresentation(Strategy, {
      capabilities: ["investigation:write"],
      queryInvestigations,
    });
    expect(await screen.findByText(/no investigation data was requested|No investigation data was requested/u)).toBeTruthy();
    await waitFor(() => expect(queryInvestigations).not.toHaveBeenCalled());
    expect(queryInvestigations).not.toHaveBeenCalled();
  });
});
