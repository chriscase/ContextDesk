import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Workstreams } from "./Workstreams.js";
import type { WorkFocus } from "./app-location.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const CASE_ID = "11111111-1111-4111-8111-111111111111";

const LONG_LOG = Array.from(
  { length: 14 },
  (_, index) =>
    `2026-08-24T06:14:${String(index).padStart(2, "0")}Z checkout-service WARN request ${index} exceeded 30000ms waiting on inventory-client`,
).join("\n");

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function workstream(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "cd-collab.workstream_view.v1",
    key: "run-1:reviewer-lane",
    caseId: CASE_ID,
    label: "Reviewer workstream — fixture-reviewer-a",
    purpose: "What caused the checkout timeout and what should we inspect next?",
    operatorKind: "ai_assisted",
    operatorLabel: "AI-assisted workstream — output is analysis, never a human finding",
    assignedTo: "dana",
    strategyLabel: "Standard synthetic strategy",
    role: "reviewer",
    inputs: {
      question: "What caused the checkout timeout and what should we inspect next?",
      snapshotLabel: "Frozen evidence set 1",
      snapshotEvidenceCount: 2,
      snapshotFrozenAt: "2026-08-24T06:13:00.000Z",
      sameSnapshot: true,
      snapshotProofLabel: "Ran against the exact frozen evidence set, proven by the host.",
    },
    statusCode: "completed",
    lifecycle: "settled",
    statusLabel: "Completed",
    statusDetail: "Finished and recorded its findings. Read them against the evidence yourself.",
    startedAt: "2026-08-24T06:14:10.000Z",
    finishedAt: "2026-08-24T06:14:25.000Z",
    findings: "Checkout waited on the inventory call for the full timeout window before failing.",
    outcome: "Recorded a written finding; it cited 1 evidence item and left 1 thing unknown.",
    evidenceCited: [
      {
        evidenceId: "artifact-1",
        label: "checkout.log",
        kind: "log",
        summary: "Synthetic checkout timeout excerpt.",
        inFrozenSnapshot: true,
        verification: "verified",
        resolved: true,
      },
    ],
    unknowns: ["pool saturation window"],
    activity: [
      {
        at: "2026-08-24T06:14:00.000Z",
        label: "Run queued",
        actor: "dana",
        detail: "Asked: What caused the checkout timeout and what should we inspect next?",
      },
      {
        at: "2026-08-24T06:14:25.000Z",
        label: "This workstream settled as completed",
        actor: "ContextDesk host",
        detail: null,
      },
    ],
    rerun: { isRerun: false, parentKey: null, note: "Not a rerun — this is the first recorded attempt." },
    agreementNotice: "Agreement is not proof of correctness.",
    technical: {
      workstreamKey: "run-1:reviewer-lane",
      runId: "run-1",
      candidateId: "reviewer-lane",
      snapshotId: "snapshot-1",
      snapshotFingerprint: "f".repeat(64),
      requestFingerprint: "a".repeat(64),
      taskFingerprint: "task-fingerprint",
      strategyId: "contextdesk.standard.synthetic",
      modelId: "fixture-reviewer-a",
      modelVersion: null,
      provider: "synthetic",
      profileId: null,
      outputHash: "b".repeat(64),
      benchmarkRunId: null,
      parentRunId: null,
      errorCode: null,
      privacyClass: "share_safe",
    },
    ...overrides,
  };
}

function stubApi(options: {
  workstreams?: unknown[];
  evidenceBytes?: string | null;
  listOk?: boolean;
} = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/workstreams")) {
        if (options.listOk === false) return { ok: false, status: 500, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({
            schemaId: "cd-collab.workstream_list.v1",
            caseId: CASE_ID,
            workstreams: options.workstreams ?? [workstream()],
          }),
        };
      }
      if (url.includes("/evidence/") && url.endsWith("/bytes")) {
        if (options.evidenceBytes === null) return { ok: false, status: 404, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({
            contentBase64: base64(options.evidenceBytes ?? "checkout request timed out\n"),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  return calls;
}

function focus(lane: string | null): WorkFocus {
  return {
    section: "workstreams",
    item: lane,
    itemKind: lane ? "workstream" : null,
    lane,
    experiment: null,
  };
}

describe("Workstreams list", () => {
  it("presents human labels, the question asked, and the owner — not identifiers", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} />);

    expect(await screen.findByRole("heading", { name: "Workstreams" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Standard synthetic strategy" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    expect(screen.getByText(/requested by dana/)).toBeTruthy();
    expect(screen.getByText(/Frozen evidence set 1 · 2 evidence items/)).toBeTruthy();

    const surface = document.querySelector(".workstreams") as HTMLElement;
    expect(surface.textContent).not.toContain("run-1:reviewer-lane");
    expect(surface.textContent).not.toContain("f".repeat(64));
    expect(surface.textContent).not.toContain("contextdesk.standard.synthetic");
  });

  it("gives every workstream a real shareable address", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} />);
    const link = await screen.findByRole("link", {
      name: "Reviewer workstream — fixture-reviewer-a",
    });
    expect(link.getAttribute("href")).toBe(
      `/investigations/${CASE_ID}/analyze?section=workstreams&item=run-1%3Areviewer-lane&kind=workstream&lane=run-1%3Areviewer-lane#workstreams`,
    );
  });

  it("asks the shell to navigate rather than jumping the page", async () => {
    stubApi();
    const onDeepNavigate = vi.fn();
    render(<Workstreams caseId={CASE_ID} onDeepNavigate={onDeepNavigate} />);
    fireEvent.click(
      await screen.findByRole("link", { name: "Reviewer workstream — fixture-reviewer-a" }),
    );
    expect(onDeepNavigate).toHaveBeenCalledWith({
      section: "workstreams",
      item: "run-1:reviewer-lane",
      itemKind: "workstream",
      lane: "run-1:reviewer-lane",
      experiment: null,
    });
  });

  it("states plainly when no workstream has run", async () => {
    stubApi({ workstreams: [] });
    render(<Workstreams caseId={CASE_ID} />);
    expect(await screen.findByText(/No workstream has run on this investigation yet/)).toBeTruthy();
  });

  it("reports a failed load without inventing content", async () => {
    stubApi({ listOk: false });
    render(<Workstreams caseId={CASE_ID} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Workstreams could not be loaded");
  });
});

describe("focused workstream", () => {
  it("opens a locator route that identifies the workstream as a typed item", async () => {
    stubApi();
    render(
      <Workstreams
        caseId={CASE_ID}
        routeFocus={{
          section: "workstreams",
          item: "run-1:reviewer-lane",
          itemKind: "workstream",
          lane: null,
          experiment: null,
        }}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
  });

  it("shows purpose, owner, inputs, findings, unknowns, and ordered history", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);

    expect(
      await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    expect(screen.getByText(/Asked to find out:/)).toBeTruthy();
    expect(screen.getByText("dana")).toBeTruthy();
    expect(
      screen.getByText("Ran against the exact frozen evidence set, proven by the host."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Checkout waited on the inventory call/),
    ).toBeTruthy();
    expect(screen.getByText("pool saturation window")).toBeTruthy();
    expect(screen.getByText("Agreement is not proof of correctness.")).toBeTruthy();

    const activity = document.querySelector(".workstreams__activity") as HTMLElement;
    const steps = [...activity.querySelectorAll(".workstreams__activity-label")].map(
      (node) => node.textContent,
    );
    expect(steps).toEqual(["Run queued", "This workstream settled as completed"]);
    expect(activity.querySelectorAll("time").length).toBe(2);
  });

  it("keeps identifiers out of the reading view but complete in Technical details", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" });

    const technical = document.querySelector(".workstreams__technical") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    const detail = document.querySelector(".workstreams__detail") as HTMLElement;
    const readable = detail.textContent!.replace(technical.textContent!, "");
    expect(readable).not.toContain("run-1:reviewer-lane");
    expect(readable).not.toContain("snapshot-1");
    expect(readable).not.toContain("f".repeat(64));
    expect(readable).not.toContain("task-fingerprint");

    expect(technical.textContent).toContain("run-1:reviewer-lane");
    expect(technical.textContent).toContain("snapshot-1");
    expect(technical.textContent).toContain("f".repeat(64));
    expect(technical.textContent).toContain("task-fingerprint");
    expect(technical.textContent).toContain("b".repeat(64));
  });

  it("names the technical disclosure for assistive technology", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" });
    expect(
      screen.getByText("Technical details — identifiers, fingerprints, and hashes"),
    ).toBeTruthy();
  });

  it("reads the cited evidence and shows a bounded, expandable excerpt", async () => {
    stubApi({ evidenceBytes: LONG_LOG });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);

    expect(await screen.findByRole("heading", { name: "checkout.log" })).toBeTruthy();
    expect(screen.getByText(/in the frozen evidence set/)).toBeTruthy();
    expect(screen.getByText("Synthetic checkout timeout excerpt.")).toBeTruthy();

    const expand = await screen.findByText(/Expand complete log or stack trace · 14 lines/);
    const details = expand.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const preview = document.querySelector(".experiment-lab__artifact-preview") as HTMLElement;
    expect(preview.textContent).not.toContain("request 13");
    fireEvent.click(details.querySelector("summary")!);
    expect(
      (details.querySelector(".experiment-lab__artifact-full") as HTMLElement).textContent,
    ).toBe(LONG_LOG);
    expect(details.querySelector("summary")?.getAttribute("aria-label")).toContain("checkout.log");
  });

  it("offers a keyboard-reachable copy control for the complete text", async () => {
    stubApi({ evidenceBytes: LONG_LOG });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);

    const copy = await screen.findByRole("button", { name: "Copy checkout.log text" });
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LONG_LOG));
    expect(await screen.findByText("Copied to the clipboard.")).toBeTruthy();
  });

  it("says so when the recorded bytes are unavailable instead of guessing", async () => {
    stubApi({ evidenceBytes: null });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    expect(
      await screen.findByText(/recorded bytes are not available to this view/),
    ).toBeTruthy();
  });

  it("marks an unresolved citation without reconstructing it", async () => {
    stubApi({
      workstreams: [
        workstream({
          evidenceCited: [
            {
              evidenceId: "artifact-gone",
              label: "Evidence no longer registered",
              kind: "unknown",
              summary: null,
              inFrozenSnapshot: false,
              verification: "not recorded",
              resolved: false,
            },
          ],
        }),
      ],
    });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    expect(
      await screen.findByText(/will not reconstruct the record from an identifier/),
    ).toBeTruthy();
  });

  it("fails closed on an address that names a workstream this investigation does not have", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-9:missing-lane")} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not part of this investigation");
    expect(screen.getByRole("link", { name: "Back to all workstreams" })).toBeTruthy();
  });

  it("opens an existing workstream when a job-level locator names the run, not a missing card", async () => {
    stubApi();
    render(
      <Workstreams
        caseId={CASE_ID}
        routeFocus={{
          section: "workstreams",
          item: "run-1",
          itemKind: "workstream",
          lane: null,
          experiment: null,
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("returns to the list through a real route, not history state", async () => {
    stubApi();
    const onDeepNavigate = vi.fn();
    render(
      <Workstreams
        caseId={CASE_ID}
        routeFocus={focus("run-1:reviewer-lane")}
        onDeepNavigate={onDeepNavigate}
      />,
    );
    const back = await screen.findByRole("link", { name: "All workstreams" });
    expect(back.getAttribute("href")).toBe(
      `/investigations/${CASE_ID}/analyze?section=workstreams#workstreams`,
    );
    fireEvent.click(back);
    expect(onDeepNavigate).toHaveBeenCalledWith({
      section: "workstreams",
      item: null,
      itemKind: null,
      lane: null,
      experiment: null,
    });
  });

  it("links a rerun to the workstream it reran", async () => {
    stubApi({
      workstreams: [
        workstream({
          rerun: {
            isRerun: true,
            parentKey: "run-0:reviewer-lane",
            note: "Rerun of an earlier workstream in this investigation.",
          },
        }),
      ],
    });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    const link = await screen.findByRole("link", { name: "Open the workstream this reran" });
    expect(link.getAttribute("href")).toContain("lane=run-0%3Areviewer-lane");
  });

  it("does not claim proof for an unproven evidence binding", async () => {
    stubApi({
      workstreams: [
        workstream({
          inputs: {
            ...workstream().inputs,
            sameSnapshot: null,
            snapshotProofLabel:
              "Whether it ran against the exact frozen evidence set is not yet proven.",
          },
        }),
      ],
    });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    expect(await screen.findByText(/is not yet proven/)).toBeTruthy();
  });

  it("does not present an empty unknown list as certainty", async () => {
    stubApi({ workstreams: [workstream({ unknowns: [] })] });
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    expect(
      await screen.findByText(
        "Nothing was recorded as unknown. That is not the same as nothing being unknown.",
      ),
    ).toBeTruthy();
  });

  it("moves keyboard focus to the opened workstream record", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    await screen.findByRole("heading", { name: "Reviewer workstream — fixture-reviewer-a" });
    await waitFor(() => {
      const detail = document.querySelector("[data-route-item='run-1:reviewer-lane']");
      expect(document.activeElement).toBe(detail);
    });
  });

  it("keeps each cited evidence item individually addressable", async () => {
    stubApi();
    render(<Workstreams caseId={CASE_ID} routeFocus={focus("run-1:reviewer-lane")} />);
    await screen.findByRole("heading", { name: "checkout.log" });
    const item = document.querySelector(
      "[data-route-item='artifact-1'][data-route-kind='evidence']",
    ) as HTMLElement;
    expect(item).toBeTruthy();
    expect(within(item).getByRole("heading", { name: "checkout.log" })).toBeTruthy();
  });
});
