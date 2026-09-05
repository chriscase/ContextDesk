import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPERATIONS_QUEUE_QUERY, type OperationsQueueLocationQuery } from "../app-location.js";
import {
  InvestigationRuntimeProvider,
  type InvestigationOperationsQueuePageV1,
} from "../investigations/runtime/public.js";
import {
  InvestigationRuntimeGatewayHarness,
  createInvestigationGatewayDouble,
  gatewayOk,
  makeOperationsQueuePage,
  type InvestigationGateway,
} from "../investigations/runtime/testkit/index.js";
import { useOperationsQueue } from "./useOperationsQueue.js";

afterEach(cleanup);

let presentation: ReturnType<typeof useOperationsQueue> | null = null;

function Probe({ query = DEFAULT_OPERATIONS_QUEUE_QUERY }: { readonly query?: OperationsQueueLocationQuery }) {
  presentation = useOperationsQueue(query);
  return (
    <output data-testid="queue-state">
      {presentation.commandAvailability}:{presentation.view.availability}{
        presentation.view.availability === "available" ? `:${presentation.view.refresh}:${presentation.view.value.items.length}` : ""
      }
    </output>
  );
}

function renderProbe(
  gateway: InvestigationGateway,
  query: OperationsQueueLocationQuery = DEFAULT_OPERATIONS_QUEUE_QUERY,
  capabilities: readonly string[] = ["investigation:read"],
) {
  return render(
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey="identity-alice"
        identity={{ id: "identity-alice", username: "alice", displayName: "Alice" }}
        authorityKey="authority-v1"
        capabilities={capabilities}
        readOnly
        active={false}
        focusCaseId={null}
        isInvestigationLocation={false}
        onOpenCreated={vi.fn()}
      >
        <Probe query={query} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>,
  );
}

describe("Operations Queue public-runtime adapter", () => {
  it("does not request the queue when read authority is denied", async () => {
    const queryOperationsQueue = vi.fn(async () => gatewayOk(makeOperationsQueuePage()));
    renderProbe(createInvestigationGatewayDouble({ queryOperationsQueue }), DEFAULT_OPERATIONS_QUEUE_QUERY, []);

    await waitFor(() => expect(screen.getByTestId("queue-state").textContent).toBe("denied:idle"));
    expect(queryOperationsQueue).not.toHaveBeenCalled();
  });

  it("requests only the location-owned dimensions and preserves server order and counts", async () => {
    const page = makeOperationsQueuePage({
      coordinationScopeCounts: { allVisible: 9, mine: 4, unassigned: 2 },
    });
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      async () => gatewayOk(page),
    );
    renderProbe(createInvestigationGatewayDouble({ queryOperationsQueue }), {
      q: " checkout ",
      status: ["monitoring", "open"],
      includeArchived: true,
      coordinationScope: "mine",
    });

    await waitFor(() => expect(screen.getByTestId("queue-state").textContent).toBe("available:available:settled:2"));
    expect(queryOperationsQueue).toHaveBeenCalledTimes(1);
    expect(queryOperationsQueue.mock.calls[0]?.[0]).toMatchObject({
      q: "checkout",
      status: ["monitoring", "open"],
      includeArchived: true,
      coordinationScope: "mine",
      cursor: null,
    });
    expect(queryOperationsQueue.mock.calls[0]?.[0]).not.toHaveProperty("actorId");
    expect(queryOperationsQueue.mock.calls[0]?.[0]).not.toHaveProperty("priority");
    expect(presentation?.view.availability === "available"
      ? presentation.view.value.coordinationScopeCounts
      : null).toEqual({ allVisible: 9, mine: 4, unassigned: 2 });
    expect(presentation?.view.availability === "available"
      ? presentation.view.value.items.map((row) => row.investigation.title)
      : []).toEqual(page.items.map((row) => row.investigation.title));
  });

  it("passes only the server cursor for continuation and preserves previous rows on failure", async () => {
    const first = makeOperationsQueuePage({
      items: [makeOperationsQueuePage().items[0]],
      nextCursor: "eyJwYWdlIjoyfQ",
      coordinationScopeCounts: { allVisible: 2, mine: 1, unassigned: 1 },
    });
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      async (input) => input.cursor
        ? { ok: false as const, error: { kind: "network" as const } }
        : gatewayOk(first),
    );
    renderProbe(createInvestigationGatewayDouble({ queryOperationsQueue }));
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent).toBe("available:available:settled:1"));

    act(() => {
      presentation?.nextPage();
      presentation?.nextPage();
    });
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(2));
    expect(queryOperationsQueue.mock.calls[1]?.[0].cursor).toBe("eyJwYWdlIjoyfQ");
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent).toBe("available:available:failed:1"));
    expect(presentation?.continuationFailed).toBe(true);
  });

  it("appends a successful continuation in exact server sequence", async () => {
    const complete = makeOperationsQueuePage();
    const first = makeOperationsQueuePage({
      items: [complete.items[0]],
      nextCursor: "eyJwYWdlIjoyfQ",
      coordinationScopeCounts: { allVisible: 2, mine: 1, unassigned: 1 },
    });
    const second: InvestigationOperationsQueuePageV1 = makeOperationsQueuePage({
      items: [complete.items[1]],
      nextCursor: null,
      coordinationScopeCounts: { allVisible: 2, mine: 1, unassigned: 1 },
    });
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      async (input) => gatewayOk(input.cursor ? second : first),
    );
    renderProbe(createInvestigationGatewayDouble({ queryOperationsQueue }));
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent).toBe("available:available:settled:1"));

    act(() => presentation?.nextPage());
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent).toBe("available:available:settled:2"));
    expect(presentation?.view.availability === "available"
      ? presentation.view.value.items.map((row) => row.investigation.id)
      : []).toEqual([first.items[0]?.investigation.id, second.items[0]?.investigation.id]);
  });
});
