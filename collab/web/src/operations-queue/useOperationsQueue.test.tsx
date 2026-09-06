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
  makePopulatedCase,
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
  readOnly = true,
) {
  return render(probeTree(gateway, query, capabilities, "identity-alice", "authority-v1", readOnly));
}

function probeTree(
  gateway: InvestigationGateway,
  query: OperationsQueueLocationQuery,
  capabilities: readonly string[] = ["investigation:read"],
  identityKey = "identity-alice",
  authorityKey = "authority-v1",
  readOnly = true,
) {
  return (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey={identityKey}
        identity={{ id: identityKey, username: identityKey, displayName: identityKey }}
        authorityKey={authorityKey}
        capabilities={capabilities}
        readOnly={readOnly}
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

  it("bridges the public self-coordination command without adding a per-row read", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => gatewayOk({
      schemaId: "cd-collab.investigation_coordination_action_success.v1" as const,
      investigationId: page.items[1]!.investigation.id,
      action: "claim_self" as const,
      targetIdentityId: null,
      previousRevision: 0,
      previousCoordinator: null,
      applied: page.items[1]!.coordination,
    }));
    const getCoordination = vi.fn(async () => gatewayOk(page.items[0]!.coordination));
    const queryOperationsQueue = vi.fn(async () => gatewayOk(page));
    const gateway = createInvestigationGatewayDouble({
      queryOperationsQueue,
      getCoordination,
      applyCoordinationAction,
    });
    renderProbe(
      gateway,
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      ["investigation:read", "investigation:write", "investigation:coordinate"],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));
    await act(async () => {
      await expect(presentation?.selfCoordination.apply(
        page.items[1]!.investigation.id,
        "claim_self",
      )).resolves.toMatchObject({ status: "succeeded" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledWith(
      page.items[1]!.investigation.id,
      expect.objectContaining({ action: "claim_self", expectedRevision: 0 }),
      expect.objectContaining({ actorIdentityId: "identity-alice" }),
    );
    expect(getCoordination).not.toHaveBeenCalled();
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

const PARTICIPANT_WRITE = ["investigation:read", "investigation:coordinate"] as const;
const UNKNOWN_COMMIT = Object.freeze({
  kind: "unavailable" as const,
  status: 503 as const,
  reason: "commit_outcome_unknown" as const,
});

function coordinationSuccess(
  page: ReturnType<typeof makeOperationsQueuePage>,
  action: "assign_participant" | "release_participant",
  targetIdentityId: string,
) {
  const row = page.items[0]!;
  return {
    schemaId: "cd-collab.investigation_coordination_action_success.v1" as const,
    investigationId: row.investigation.id,
    action,
    targetIdentityId,
    previousRevision: row.coordination.revision,
    previousCoordinator: row.coordination.coordinator,
    applied: row.coordination,
  };
}

function pageWithCoordinatorOutsideParticipants() {
  const page = makeOperationsQueuePage();
  const populated = makePopulatedCase();
  return makeOperationsQueuePage({
    items: [
      {
        investigation: {
          ...populated,
          participants: populated.participants.filter(
            (participant) => participant.identityId !== "identity-alice",
          ),
        },
        coordination: page.items[0]!.coordination,
      },
      page.items[1],
    ],
  });
}

describe("Operations Queue participant-coordination presentation", () => {
  it("returns not_ready with zero writes when the participant command is absent, denied, or read-only", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn();
    const getCoordination = vi.fn();
    const queryOperationsQueue = vi.fn(async () => gatewayOk(page));
    const row = page.items[0]!;
    const assign = async () => presentation?.participantCoordination.apply(
      row.investigation.id,
      "assign_participant",
      "identity-ravi",
    );

    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      ["investigation:read"],
      true,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));
    expect(presentation?.participantCoordination.available).toBe(false);
    await act(async () => {
      await expect(assign()).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    });

    cleanup();
    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      ["investigation:read", "investigation:write"],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));
    expect(presentation?.participantCoordination.available).toBe(false);
    expect(presentation?.selfCoordination.available).toBe(true);
    await act(async () => {
      await expect(assign()).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    });

    cleanup();
    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      true,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));
    expect(presentation?.participantCoordination.available).toBe(false);
    await act(async () => {
      await expect(assign()).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    });

    expect(applyCoordinationAction).not.toHaveBeenCalled();
    expect(getCoordination).not.toHaveBeenCalled();
  });

  it("assigns a recorded participant through the runtime command using the visible row revision", async () => {
    const page = makeOperationsQueuePage();
    const row = page.items[0]!;
    const applyCoordinationAction = vi.fn(async () => gatewayOk(
      coordinationSuccess(page, "assign_participant", "identity-ravi"),
    ));
    const getCoordination = vi.fn();
    const queryOperationsQueue = vi.fn(async () => gatewayOk(page));
    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));
    expect(presentation?.participantCoordination.available).toBe(true);
    expect(presentation?.selfCoordination.available).toBe(false);

    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-ravi",
      )).resolves.toMatchObject({ status: "succeeded" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledWith(
      row.investigation.id,
      expect.objectContaining({
        action: "assign_participant",
        targetIdentityId: "identity-ravi",
        expectedRevision: row.coordination.revision,
      }),
      expect.objectContaining({ actorIdentityId: "identity-alice" }),
    );
    expect(getCoordination).not.toHaveBeenCalled();
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(2));
  });

  it("returns not_ready with zero writes for an unlisted assign, a non-coordinator release, and an off-page row", async () => {
    const page = makeOperationsQueuePage();
    const row = page.items[0]!;
    const applyCoordinationAction = vi.fn();
    const getCoordination = vi.fn();
    renderProbe(
      createInvestigationGatewayDouble({
        queryOperationsQueue: vi.fn(async () => gatewayOk(page)),
        getCoordination,
        applyCoordinationAction,
      }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));

    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-eve",
      )).resolves.toEqual({ status: "ignored", reason: "not_ready" });
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "release_participant",
        "identity-ravi",
      )).resolves.toEqual({ status: "ignored", reason: "not_ready" });
      await expect(presentation?.participantCoordination.apply(
        "missing-investigation",
        "assign_participant",
        "identity-ravi",
      )).resolves.toEqual({ status: "ignored", reason: "not_ready" });
    });
    expect(applyCoordinationAction).not.toHaveBeenCalled();
    expect(getCoordination).not.toHaveBeenCalled();
  });

  it("releases the recorded coordinator even when they are absent from participants", async () => {
    const page = pageWithCoordinatorOutsideParticipants();
    const row = page.items[0]!;
    expect(row.coordination.coordinator?.identityId).toBe("identity-alice");
    expect(row.investigation.participants.map((participant) => participant.identityId))
      .not.toContain("identity-alice");
    const applyCoordinationAction = vi.fn(async () => gatewayOk(
      coordinationSuccess(page, "release_participant", "identity-alice"),
    ));
    const getCoordination = vi.fn();
    renderProbe(
      createInvestigationGatewayDouble({
        queryOperationsQueue: vi.fn(async () => gatewayOk(page)),
        getCoordination,
        applyCoordinationAction,
      }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));

    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "release_participant",
        "identity-alice",
      )).resolves.toMatchObject({ status: "succeeded" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledWith(
      row.investigation.id,
      expect.objectContaining({
        action: "release_participant",
        targetIdentityId: "identity-alice",
        expectedRevision: row.coordination.revision,
      }),
      expect.objectContaining({ actorIdentityId: "identity-alice" }),
    );
    expect(getCoordination).not.toHaveBeenCalled();
  });

  it.each([
    ["succeeded", (page: ReturnType<typeof makeOperationsQueuePage>) => gatewayOk(
      coordinationSuccess(page, "assign_participant", "identity-ravi"),
    )],
    ["coordination_changed", (page: ReturnType<typeof makeOperationsQueuePage>) => ({
      ok: false as const,
      error: {
        kind: "coordination_changed" as const,
        status: 409 as const,
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant" as const,
        targetIdentityId: "identity-ravi",
        current: page.items[0]!.coordination,
      },
    })],
    ["coordination_refused", (page: ReturnType<typeof makeOperationsQueuePage>) => ({
      ok: false as const,
      error: {
        kind: "coordination_refused" as const,
        status: 409 as const,
        investigationId: page.items[0]!.investigation.id,
        action: "assign_participant" as const,
        targetIdentityId: "identity-ravi",
        reason: "already_coordinator" as const,
        detail: "The investigation already has a coordinator.",
        current: page.items[0]!.coordination,
      },
    })],
  ])("refreshes the server queue on %s without a per-row coordination read", async (_label, response) => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => response(page));
    const getCoordination = vi.fn();
    const queryOperationsQueue = vi.fn(async () => gatewayOk(page));
    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));

    await act(async () => {
      await presentation?.participantCoordination.apply(
        page.items[0]!.investigation.id,
        "assign_participant",
        "identity-ravi",
      );
    });
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(2));
    expect(getCoordination).not.toHaveBeenCalled();
  });

  it("retries an unknown 503 with the exact frozen payload and key", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: UNKNOWN_COMMIT })
      .mockResolvedValueOnce(gatewayOk(coordinationSuccess(page, "assign_participant", "identity-ravi")));
    const getCoordination = vi.fn();
    const queryOperationsQueue = vi.fn(async () => gatewayOk(page));
    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));

    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        page.items[0]!.investigation.id,
        "assign_participant",
        "identity-ravi",
      )).resolves.toMatchObject({ status: "failed", error: UNKNOWN_COMMIT });
    });
    expect(queryOperationsQueue).toHaveBeenCalledTimes(1);
    await act(async () => {
      await expect(presentation?.participantCoordination.retry())
        .resolves.toMatchObject({ status: "succeeded" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
    expect(applyCoordinationAction.mock.calls[0]?.[1]).toBe(applyCoordinationAction.mock.calls[1]?.[1]);
    expect(Object.isFrozen(applyCoordinationAction.mock.calls[0]?.[1])).toBe(true);
    expect(applyCoordinationAction.mock.calls[0]?.[1]).toEqual({
      action: "assign_participant",
      targetIdentityId: "identity-ravi",
      expectedRevision: page.items[0]!.coordination.revision,
      idempotencyKey: applyCoordinationAction.mock.calls[0]?.[1].idempotencyKey,
    });
    expect(getCoordination).not.toHaveBeenCalled();
    await waitFor(() => expect(queryOperationsQueue).toHaveBeenCalledTimes(2));
  });

  it("rejects same-key target or action mismatch with zero additional POSTs", async () => {
    const page = makeOperationsQueuePage();
    const row = page.items[0]!;
    const applyCoordinationAction = vi.fn(async () => ({
      ok: false as const,
      error: UNKNOWN_COMMIT,
    }));
    const getCoordination = vi.fn();
    renderProbe(
      createInvestigationGatewayDouble({
        queryOperationsQueue: vi.fn(async () => gatewayOk(page)),
        getCoordination,
        applyCoordinationAction,
      }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));

    await act(async () => {
      await presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-ravi",
      );
    });
    let targetMismatch;
    await act(async () => {
      targetMismatch = await presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-alice",
      );
    });
    expect(targetMismatch).toEqual({
      status: "failed",
      error: { kind: "input", field: "idempotencyKey", reason: "intent_mismatch" },
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();

    await act(async () => {
      await presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-ravi",
      );
    });
    let actionMismatch;
    await act(async () => {
      actionMismatch = await presentation?.participantCoordination.apply(
        row.investigation.id,
        "release_participant",
        "identity-alice",
      );
    });
    expect(actionMismatch).toEqual({
      status: "failed",
      error: { kind: "input", field: "idempotencyKey", reason: "intent_mismatch" },
    });
    expect(applyCoordinationAction).toHaveBeenCalledTimes(2);
    expect(getCoordination).not.toHaveBeenCalled();
  });

  it("reports auth-loss and conceals apply 404 without invalidating the queue or reading per-row coordination", async () => {
    const page = makeOperationsQueuePage();
    const row = page.items[0]!;
    const getCoordination = vi.fn();
    const queryOperationsQueue = vi.fn(async () => gatewayOk(page));
    const applyCoordinationAction = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: { kind: "auth_lost" as const, status: 401 as const } })
      .mockResolvedValueOnce({ ok: false as const, error: { kind: "not_found" as const, status: 404 as const } })
      .mockResolvedValueOnce({ ok: false as const, error: { kind: "not_found" as const, status: 404 as const } });
    renderProbe(
      createInvestigationGatewayDouble({ queryOperationsQueue, getCoordination, applyCoordinationAction }),
      DEFAULT_OPERATIONS_QUEUE_QUERY,
      [...PARTICIPANT_WRITE],
      false,
    );
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));

    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-ravi",
      )).resolves.toEqual({ status: "failed", error: { kind: "auth_lost", status: 401 } });
    });
    expect(presentation?.view.availability).toBe("available");
    expect(queryOperationsQueue).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-ravi",
      )).resolves.toEqual({ status: "failed", error: { kind: "not_found", status: 404 } });
    });
    expect(presentation?.view.availability).toBe("available");
    await act(async () => {
      await expect(presentation?.participantCoordination.apply(
        row.investigation.id,
        "assign_participant",
        "identity-ravi",
      )).resolves.toEqual({ status: "failed", error: { kind: "not_found", status: 404 } });
    });
    expect(queryOperationsQueue).toHaveBeenCalledTimes(1);
    expect(getCoordination).not.toHaveBeenCalled();
  });

  it("clears retained participant intent when the location query scope changes", async () => {
    const page = makeOperationsQueuePage();
    const applyCoordinationAction = vi.fn(async () => ({
      ok: false as const,
      error: UNKNOWN_COMMIT,
    }));
    const getCoordination = vi.fn();
    const gateway = createInvestigationGatewayDouble({
      queryOperationsQueue: vi.fn(async () => gatewayOk(page)),
      getCoordination,
      applyCoordinationAction,
    });
    const rendered = renderProbe(gateway, DEFAULT_OPERATIONS_QUEUE_QUERY, [...PARTICIPANT_WRITE], false);
    await waitFor(() => expect(presentation?.view.availability).toBe("available"));
    await act(async () => {
      await presentation?.participantCoordination.apply(
        page.items[0]!.investigation.id,
        "assign_participant",
        "identity-ravi",
      );
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();

    rendered.rerender(probeTree(
      gateway,
      { ...DEFAULT_OPERATIONS_QUEUE_QUERY, q: "other" },
      [...PARTICIPANT_WRITE],
      "identity-alice",
      "authority-v1",
      false,
    ));
    await waitFor(() => expect(presentation?.participantCoordination.action).toBeNull());
    await act(async () => {
      await expect(presentation?.participantCoordination.retry())
        .resolves.toEqual({ status: "ignored", reason: "not_ready" });
    });
    expect(applyCoordinationAction).toHaveBeenCalledOnce();
  });
});
