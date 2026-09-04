import {
  INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
  INVESTIGATION_ACTIVITY_NOTICES,
  INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
  INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID,
  INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID,
  type InvestigationActivityItemV1,
  type InvestigationResourceLocatorV1,
} from "@cd-collab/contracts/investigation-activity";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCaseList } from "../investigations/runtime/testkit/fixtures.js";
import type { OverviewGateway } from "./gateway.js";
import { ActivityCenter } from "./ActivityCenter.js";

afterEach(cleanup);

const CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function activity(overlay: Partial<InvestigationActivityItemV1> = {}): InvestigationActivityItemV1 {
  const pathname = `/investigations/${CASE_ID}/situation?section=discussion&item=${ITEM_ID}&kind=comment#discussion`;
  return {
    schemaId: INVESTIGATION_ACTIVITY_ITEM_SCHEMA_ID,
    activityId: "ab".repeat(32), occurredAt: "2026-09-03T12:00:00.000Z", orderTieBreak: 1,
    actorId: "actor-1", actorLabel: "Avery", investigationId: CASE_ID,
    investigationTitle: "Gateway resets", activityKind: "handoff_recorded",
    summary: "recorded a shift handoff",
    locator: { schemaId: INVESTIGATION_RESOURCE_LOCATOR_SCHEMA_ID, version: 1,
      installationId: "inst-syntheticnorth", investigationId: CASE_ID,
      kind: "discussion_message", resourceId: ITEM_ID, pathname },
    resolvedRoute: pathname, provenanceClass: "human", privacyVisibility: "member",
    revision: null, sourceEventId: `${CASE_ID}:1`, humanFinding: true, ...overlay,
  };
}

function gatewayWith(overrides: Partial<OverviewGateway> = {}): OverviewGateway {
  return {
    listInvestigations: vi.fn(async () => ({ ok: true as const, value: makeCaseList().cases })),
    listActivity: vi.fn(async () => ({ ok: true as const, value: {
      schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID,
      items: [activity()], nextCursor: null, notices: [...INVESTIGATION_ACTIVITY_NOTICES],
    } })),
    resolve: vi.fn(async (locator: InvestigationResourceLocatorV1) => ({ ok: true as const, value: {
      schemaId: INVESTIGATION_RESOURCE_RESOLVE_SCHEMA_ID, locator,
      resourceKind: locator.kind, resourceLabel: "Shift handoff",
      investigationTitle: "Gateway resets", revision: null, authorized: true as const,
    } })),
    ...overrides,
  };
}

const baseProps = {
  canRead: true, identityKey: "alice", authorityKey: "interactive:viewer",
  onOpenRoute: vi.fn(), onOpenInvestigations: vi.fn(),
};

describe("ActivityCenter", () => {
  it("is a distinct recorded-activity surface with handoffs and authorized navigation", async () => {
    const onOpenRoute = vi.fn();
    const gateway = gatewayWith();
    render(<ActivityCenter {...baseProps} gateway={gateway} onOpenRoute={onOpenRoute} />);
    expect(screen.getByRole("heading", { name: "Operating picture" })).toBeTruthy();
    expect((await screen.findAllByText("recorded a shift handoff")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Recorded handoffs" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("link", { name: /Gateway resets/ })[0]!);
    await waitFor(() => expect(gateway.resolve).toHaveBeenCalledTimes(1));
    expect(onOpenRoute).toHaveBeenCalledWith(expect.stringContaining(`/investigations/${CASE_ID}/situation`));
  });

  it("makes no data request and renders a truthful nonbusy state when reading is denied", () => {
    const gateway = gatewayWith();
    render(<ActivityCenter {...baseProps} canRead={false} gateway={gateway} />);
    expect(screen.getByRole("heading", { name: "Overview unavailable" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/no investigation or activity data was requested/i);
    expect(gateway.listActivity).not.toHaveBeenCalled();
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
    expect(gateway.resolve).not.toHaveBeenCalled();
  });

  it("distinguishes a failed read from an empty filtered result and offers retry", async () => {
    const listActivity = vi.fn<OverviewGateway["listActivity"]>()
      .mockResolvedValueOnce({ ok: false, error: { kind: "network" } })
      .mockResolvedValueOnce({ ok: true, value: {
        schemaId: INVESTIGATION_ACTIVITY_PAGE_SCHEMA_ID, items: [], nextCursor: null,
        notices: [...INVESTIGATION_ACTIVITY_NOTICES],
      } });
    render(<ActivityCenter {...baseProps} gateway={gatewayWith({ listActivity })} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be refreshed/i);
    expect(screen.queryByText(/No activity has been recorded yet/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No activity has been recorded yet.")).toBeTruthy();
  });

  it("applies server-owned filters without silently selecting assigned-to-me", async () => {
    const gateway = gatewayWith();
    render(<ActivityCenter {...baseProps} gateway={gateway} />);
    await screen.findAllByText("recorded a shift handoff");
    fireEvent.change(screen.getByLabelText("Activity"), { target: { value: "handoff_recorded" } });
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "situation" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(gateway.listActivity).toHaveBeenLastCalledWith(
      { filter: { activityKind: "handoff_recorded", stage: "situation" } }, expect.any(AbortSignal),
    ));
  });
});
