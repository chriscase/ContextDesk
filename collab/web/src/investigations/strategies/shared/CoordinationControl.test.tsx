import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinationControl, type CoordinationControlProps } from "./CoordinationControl.js";
import type {
  CoordinationActionCommand,
  CoordinationActionInput,
  CoordinationFailureKind,
  CoordinationRecord,
} from "./coordination.js";

const ALICE = { identityId: "identity-alice", username: "alice" };
const BOB = { identityId: "identity-bob", username: "bob" };
const CAROL = { identityId: "identity-carol", username: "carol" };

function record(
  coordinator: typeof ALICE | null = null,
  overrides: Partial<CoordinationRecord> = {},
): CoordinationRecord {
  return {
    investigationId: "case-1",
    coordinator,
    revision: coordinator === null ? 0 : 4,
    updatedAt: coordinator === null ? null : "2026-09-04T18:30:00.000Z",
    updatedBy: coordinator === null ? null : ALICE,
    archived: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount(overrides: Partial<CoordinationControlProps> = {}) {
  const props: CoordinationControlProps = {
    investigationId: "case-1",
    investigationStatus: "monitoring",
    participants: [ALICE, BOB],
    resource: { status: "ready", value: record() },
    mutation: { status: "idle" },
    identity: { id: ALICE.identityId, username: ALICE.username },
    canCoordinateSelf: true,
    canCoordinateParticipants: false,
    applyAction: vi.fn(async () => ({ status: "succeeded" as const })),
    refreshCoordination: vi.fn(),
    ...overrides,
  };
  const view = render(<CoordinationControl {...props} />);
  return { ...view, props };
}

function calls(command: CoordinationActionCommand): readonly CoordinationActionInput[] {
  return vi.mocked(command).mock.calls.map(([input]) => input);
}

function confirm(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

afterEach(() => cleanup());

describe("shared coordination control", () => {
  it("shows only recorded facts for empty, present, and unlisted coordinators", () => {
    const view = mount({ participants: [BOB] });
    expect(screen.getByText("Who is recorded as coordinating this investigation.")).toBeTruthy();
    expect(screen.getByText("No coordinator is recorded.")).toBeTruthy();
    expect(screen.getByText("Revision 0")).toBeTruthy();
    expect(screen.queryByText("Recorded update")).toBeNull();
    expect(screen.queryByText("Recorded by")).toBeNull();

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "ready", value: record(ALICE) }} />);
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("identity-alice")).toBeTruthy();
    expect(screen.getByText("Revision 4")).toBeTruthy();
    expect(screen.getByText("Not listed among this investigation’s recorded participants.")).toBeTruthy();
    expect(screen.getByText("Recorded update")).toBeTruthy();
    expect(screen.getByText("Recorded by")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b(stale|missing|ineligible|offline|inactive|priority|SLA|rank|lease)\b/iu);
  });

  it("distinguishes idle, first load, denied, failed, refresh, and refresh failure", () => {
    const view = mount({ resource: { status: "idle" } });
    expect(screen.getByRole("status").textContent).toBe("Coordination has not started loading.");

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "loading" }} />);
    expect(screen.getByText("Loading recorded coordination…")).toBeTruthy();
    expect(screen.queryByText("No coordinator is recorded.")).toBeNull();

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "failed", error: "denied" }} />);
    expect(screen.getByRole("status").textContent).toContain("access changed");
    expect(screen.queryByRole("button", { name: "Retry coordination" })).toBeNull();

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "failed", error: "unavailable" }} />);
    expect(screen.getByRole("status").textContent).toContain("could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Retry coordination" }));
    expect(view.props.refreshCoordination).toHaveBeenCalledTimes(1);

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "loading", previous: record(ALICE) }} />);
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("Refreshing recorded coordination…")).toBeTruthy();
    expect(screen.getByText("Coordination changes require a confirmed current record.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release my coordination" })).toBeNull();

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "failed", error: "unavailable", previous: record(ALICE) }} />);
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("could not be loaded");
    expect(screen.getByText("Coordination changes require a confirmed current record.")).toBeTruthy();
  });

  it("keeps self claim and release behind their exact record and capability gates", async () => {
    const claim = vi.fn(async () => ({ status: "succeeded" as const }));
    const view = mount({ applyAction: claim });
    const trigger = screen.getByRole("button", { name: "Claim coordination" });
    fireEvent.click(trigger);
    expect(claim).not.toHaveBeenCalled();
    const confirmClaim = screen.getByRole("button", { name: "Confirm claim coordination" });
    expect(document.activeElement).toBe(confirmClaim);
    const descriptionId = confirmClaim.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)?.textContent).toBe(
      "Claim coordination for yourself?",
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    confirm("Confirm claim coordination");
    await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
    expect(calls(claim)[0]).toMatchObject({ action: "claim_self" });
    expect(calls(claim)[0]).not.toHaveProperty("targetIdentityId");

    view.rerender(<CoordinationControl {...view.props} resource={{ status: "ready", value: record(ALICE) }} />);
    expect(screen.queryByRole("button", { name: "Claim coordination" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Release my coordination" }));
    confirm("Confirm release my coordination");
    await waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    expect(calls(claim)[1]).toMatchObject({ action: "release_self" });
    expect(calls(claim)[1]).not.toHaveProperty("targetIdentityId");

    view.rerender(<CoordinationControl {...view.props} canCoordinateSelf={false} resource={{ status: "ready", value: record(ALICE) }} />);
    expect(screen.queryByRole("button", { name: /claim|release my/iu })).toBeNull();
  });

  it("uses 0, 1, and many recorded participants as hints and releases an unlisted holder", async () => {
    const command = vi.fn(async () => ({ status: "succeeded" as const }));
    const view = mount({
      participants: [],
      canCoordinateSelf: false,
      canCoordinateParticipants: true,
      applyAction: command,
      resource: { status: "ready", value: record(ALICE) },
    });
    fireEvent.click(screen.getByText("Participant coordination"));
    const emptySelect = screen.getByRole("combobox", { name: "Participant" });
    expect((emptySelect as HTMLSelectElement).disabled).toBe(true);
    expect(within(emptySelect).getByRole("option").textContent).toBe("No recorded participants");
    expect(screen.getByText("Not listed among this investigation’s recorded participants.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release recorded coordinator" }));
    confirm("Confirm release recorded coordinator");
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(calls(command)[0]).toMatchObject({ action: "release_participant", targetIdentityId: ALICE.identityId });

    view.rerender(<CoordinationControl {...view.props} participants={[BOB]} resource={{ status: "ready", value: record() }} />);
    fireEvent.click(screen.getByText("Participant coordination"));
    expect(screen.getAllByRole("option")).toHaveLength(1);

    view.rerender(<CoordinationControl {...view.props} participants={[BOB, CAROL]} resource={{ status: "ready", value: record() }} />);
    fireEvent.click(screen.getByText("Participant coordination"));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Participant" }), { target: { value: CAROL.identityId } });
    fireEvent.click(screen.getByRole("button", { name: "Review participant assignment" }));
    const confirmAssignment = screen.getByRole("button", { name: "Confirm participant assignment" });
    expect(document.activeElement).toBe(confirmAssignment);
    expect(
      document.getElementById(confirmAssignment.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("Record carol (identity-carol) as coordinator?");
    fireEvent.click(confirmAssignment);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(calls(command)[1]).toMatchObject({ action: "assign_participant", targetIdentityId: CAROL.identityId });
  });

  it("keeps archived and command-unavailable facts readable but nonwritable", () => {
    const archived = mount({
      investigationStatus: "archived",
      resource: { status: "ready", value: record(ALICE, { archived: true }) },
      canCoordinateParticipants: true,
    });
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("Coordination cannot change while this investigation is archived.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /coordination/iu })).toBeNull();
    expect(screen.queryByRole("button", { name: "Release recorded coordinator" })).toBeNull();
    expect(screen.queryByRole("button", { name: /confirm/iu })).toBeNull();

    archived.rerender(<CoordinationControl
      {...archived.props}
      investigationStatus="monitoring"
      resource={{ status: "ready", value: record(ALICE) }}
      applyAction={null}
    />);
    expect(screen.getByText("Coordination changes are unavailable in this view.")).toBeTruthy();

    archived.rerender(<CoordinationControl
      {...archived.props}
      investigationStatus="monitoring"
      resource={{ status: "ready", value: record(ALICE) }}
      canCoordinateSelf={false}
      canCoordinateParticipants={false}
    />);
    expect(screen.getByText(/changes are unavailable with your current access/iu)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release recorded coordinator" })).toBeNull();
    expect(screen.queryByRole("button", { name: /confirm/iu })).toBeNull();
  });

  it("retries only an explicit unknown outcome with the exact key and payload", async () => {
    const command = vi.fn(async () => ({ status: "failed" as const, error: "outcome_unknown" as const }));
    const refresh = vi.fn();
    mount({
      participants: [BOB, CAROL],
      canCoordinateSelf: false,
      canCoordinateParticipants: true,
      applyAction: command,
      refreshCoordination: refresh,
    });
    fireEvent.click(screen.getByText("Participant coordination"));
    fireEvent.click(screen.getByRole("button", { name: "Review participant assignment" }));
    confirm("Confirm participant assignment");
    await screen.findByRole("button", { name: "Retry exact action" });
    const first = calls(command)[0];
    expect((screen.getByRole("button", { name: "Review participant assignment" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh coordination" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact action" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(calls(command)[1]).toEqual(first);

    fireEvent.change(screen.getByRole("combobox", { name: "Participant" }), { target: { value: CAROL.identityId } });
    expect(screen.queryByRole("button", { name: "Retry exact action" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review participant assignment" }));
    confirm("Confirm participant assignment");
    await waitFor(() => expect(command).toHaveBeenCalledTimes(3));
    expect(calls(command)[2]).toMatchObject({ action: "assign_participant", targetIdentityId: CAROL.identityId });
    expect(calls(command)[2]?.idempotencyKey).not.toBe(first?.idempotencyKey);
  });

  it("allows only one command while a confirmed action is pending", async () => {
    const pending = deferred<{ status: "succeeded" }>();
    const command = vi.fn(() => pending.promise);
    mount({ applyAction: command });
    fireEvent.click(screen.getByRole("button", { name: "Claim coordination" }));
    const submit = screen.getByRole("button", { name: "Confirm claim coordination" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recording one coordination action…")).toBeTruthy();
    await act(async () => pending.resolve({ status: "succeeded" }));
    expect(await screen.findByText("Coordination was updated.")).toBeTruthy();
  });

  it.each<[CoordinationFailureKind, RegExp]>([
    ["changed", /record changed/iu],
    ["refused", /action was refused/iu],
    ["validation", /was not accepted/iu],
    ["auth_lost", /access changed/iu],
    ["not_found", /no longer available/iu],
    ["definitive", /could not be completed/iu],
  ])("uses bounded copy and never retains a retry for %s", async (error, copy) => {
    const command = vi.fn(async () => ({ status: "failed" as const, error }));
    mount({ applyAction: command });
    fireEvent.click(screen.getByRole("button", { name: "Claim coordination" }));
    confirm("Confirm claim coordination");
    expect((await screen.findByRole("alert")).textContent).toMatch(copy);
    expect(screen.queryByRole("button", { name: "Retry exact action" })).toBeNull();
  });

  it.each([
    ["investigationId", { investigationId: "case-2" }],
    ["identity", { identity: { id: BOB.identityId, username: BOB.username } }],
    ["capability", { canCoordinateSelf: false }],
  ] as const)("fences an in-flight result when %s changes", async (_label, update) => {
    const pending = deferred<{ status: "failed"; error: "outcome_unknown" }>();
    const command = vi.fn(() => pending.promise);
    const view = mount({ applyAction: command });
    fireEvent.click(screen.getByRole("button", { name: "Claim coordination" }));
    confirm("Confirm claim coordination");
    view.rerender(<CoordinationControl {...view.props} {...update} />);
    await act(async () => pending.resolve({ status: "failed", error: "outcome_unknown" }));
    expect(screen.queryByRole("button", { name: "Retry exact action" })).toBeNull();
    expect(screen.queryByText(/may have been recorded/iu)).toBeNull();
  });

  it("makes no command call while the resource is denied or otherwise not ready", () => {
    const command = vi.fn(async () => ({ status: "succeeded" as const }));
    const denied = mount({ applyAction: command, resource: { status: "failed", error: "denied" } });
    expect(screen.queryByRole("button", { name: /claim|assign|release/iu })).toBeNull();
    denied.rerender(<CoordinationControl {...denied.props} resource={{ status: "loading", previous: record() }} />);
    expect(screen.queryByRole("button", { name: /claim|assign|release/iu })).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });
});
