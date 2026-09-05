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
  return render(probeTree(gateway, query, capabilities));
}

function probeTree(
  gateway: InvestigationGateway,
  query: OperationsQueueLocationQuery,
  capabilities: readonly string[] = ["investigation:read"],
  identityKey = "identity-alice",
  authorityKey = "authority-v1",
) {
  return (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey={identityKey}
        identity={{ id: identityKey, username: identityKey, displayName: identityKey }}
        authorityKey={authorityKey}
        capabilities={capabilities}
        readOnly
        active={false}
        focusCaseId={null}
        isInvestigationLocation={false}
        onOpenCreated={vi.fn()}
      >
        <Probe query={query} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>
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

  it("withholds the previous query page as soon as location filters change", async () => {
    let resolveSecond: ((value: ReturnType<typeof gatewayOk<InvestigationOperationsQueuePageV1>>) => void) | null = null;
    const first = makeOperationsQueuePage();
    const second = makeOperationsQueuePage({ items: [first.items[1]!] });
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      (input) => input.q === "second"
        ? new Promise((resolve) => { resolveSecond = resolve; })
        : Promise.resolve(gatewayOk(first)),
    );
    const gateway = createInvestigationGatewayDouble({ queryOperationsQueue });
    const initial = { ...DEFAULT_OPERATIONS_QUEUE_QUERY, q: "first" };
    const next = { ...DEFAULT_OPERATIONS_QUEUE_QUERY, q: "second" };
    const rendered = renderProbe(gateway, initial);
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent)
      .toBe("available:available:settled:2"));

    rendered.rerender(probeTree(gateway, next));
    expect(screen.getByTestId("queue-state").textContent).toBe("available:loading");
    expect(presentation?.view.availability).toBe("loading");
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(2));

    act(() => resolveSecond?.(gatewayOk(second)));
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent)
      .toBe("available:available:settled:1"));
  });

  it.each([
    ["identity", "identity-bob", "authority-v1"],
    ["authority", "identity-alice", "authority-v2"],
  ] as const)("requests page one after a %s change and ignores the late prior response", async (
    _dimension,
    nextIdentityKey,
    nextAuthorityKey,
  ) => {
    const oldPage = makeOperationsQueuePage();
    const newPage = makeOperationsQueuePage({ items: [oldPage.items[1]!] });
    let calls = 0;
    let resolveOld: ((value: ReturnType<typeof gatewayOk<InvestigationOperationsQueuePageV1>>) => void) | null = null;
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      (_input, options) => {
        calls += 1;
        return calls === 1
          ? new Promise((resolve) => {
            resolveOld = resolve;
            options.signal.addEventListener("abort", () => undefined, { once: true });
          })
          : Promise.resolve(gatewayOk(newPage));
      },
    );
    const gateway = createInvestigationGatewayDouble({ queryOperationsQueue });
    const rendered = render(probeTree(
      gateway,
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      ["investigation:read"],
      "identity-alice",
      "authority-v1",
    ));
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(1));
    const oldSignal = queryOperationsQueue.mock.calls[0]?.[1].signal;

    rendered.rerender(probeTree(
      gateway,
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      ["investigation:read"],
      nextIdentityKey,
      nextAuthorityKey,
    ));

    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);
    expect(queryOperationsQueue.mock.calls[1]?.[0].cursor).toBeNull();
    await waitFor(() => expect(presentation?.view.availability === "available"
      ? presentation.view.value.items.map((row) => row.investigation.id)
      : []).toEqual([newPage.items[0]?.investigation.id]));

    act(() => resolveOld?.(gatewayOk(oldPage)));
    await waitFor(() => expect(presentation?.view.availability === "available"
      ? presentation.view.value.items.map((row) => row.investigation.id)
      : []).toEqual([newPage.items[0]?.investigation.id]));
    expect(queryOperationsQueue).toHaveBeenCalledTimes(2);
  });

  it("publishes distinct outcomes when repeated continuations reuse one frozen failure", async () => {
    const first = makeOperationsQueuePage({
      items: [makeOperationsQueuePage().items[0]],
      nextCursor: "eyJwYWdlIjoyfQ",
      coordinationScopeCounts: { allVisible: 2, mine: 1, unassigned: 1 },
    });
    let continuationCalls = 0;
    const sharedFailure = Object.freeze({
      ok: false as const,
      error: Object.freeze({ kind: "network" as const }),
    });
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      async (input) => {
        if (!input.cursor) return gatewayOk(first);
        continuationCalls += 1;
        return continuationCalls <= 2
          ? sharedFailure
          : gatewayOk(makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjozfQ" }));
      },
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
    await waitFor(() => expect(presentation?.continuationOutcome).toBe(1));

    act(() => presentation?.nextPage());
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(presentation?.continuationOutcome).toBe(2));
    expect(presentation?.continuationFailed).toBe(true);

    act(() => presentation?.nextPage());
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(presentation?.continuationOutcome).toBe(3));
    expect(presentation?.continuationFailed).toBe(false);
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
    await waitFor(() => expect(presentation?.continuationOutcome).toBe(1));
  });

  it("recovers a concealed continuation failure with an explicit first-page retry", async () => {
    const first = makeOperationsQueuePage({ nextCursor: "eyJwYWdlIjoyfQ" });
    let call = 0;
    const queryOperationsQueue = vi.fn<NonNullable<InvestigationGateway["queryOperationsQueue"]>>(
      async () => {
        call += 1;
        if (call === 2) return { ok: false as const, error: { kind: "not_found" as const, status: 404 } };
        return gatewayOk(first);
      },
    );
    renderProbe(createInvestigationGatewayDouble({ queryOperationsQueue }));
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent)
      .toBe("available:available:settled:2"));

    act(() => presentation?.nextPage());
    await waitFor(() => expect(screen.getByTestId("queue-state").textContent)
      .toBe("available:unavailable"));
    await waitFor(() => expect(presentation?.continuationInFlight).toBe(false));

    act(() => presentation?.refresh());
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(3));
    expect(queryOperationsQueue.mock.calls[2]?.[0].cursor).toBeNull();
  });
});
