import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationRuntimeProvider,
  type InvestigationRuntimeIdentity,
} from "../../runtime/public.js";
import {
  createInvestigationGatewayDouble,
  gatewayOk,
  InvestigationRuntimeGatewayHarness,
  makeContributionList,
  makePopulatedCase,
  RUNTIME_FIXTURE_IDS,
  type InvestigationGateway,
} from "../../runtime/testkit/index.js";
import type { InvestigationStrategyShellProps } from "../contract.js";
import {
  COMPONENT_SURFACE_REQUIREMENT_IDS,
  runComponentConformance,
} from "../testkit/conformance.js";
import { BeaconStrategy } from "./BeaconStrategy.js";

afterEach(cleanup);

const ALICE: InvestigationRuntimeIdentity = Object.freeze({
  id: "alice",
  username: "alice",
  displayName: "Alice Nguyen",
});
const SHELL: InvestigationStrategyShellProps = {
  view: "investigations",
  focusCaseId: null,
  stage: "situation",
  onOpenCase: vi.fn(),
  onNavigateInvestigation: vi.fn(),
  onExitFocus: vi.fn(),
};

function mount(options: {
  readonly gateway?: InvestigationGateway;
  readonly shell?: Partial<InvestigationStrategyShellProps>;
  readonly capabilities?: readonly string[];
  readonly identity?: InvestigationRuntimeIdentity;
} = {}) {
  const gateway = options.gateway ?? createInvestigationGatewayDouble();
  const shell = { ...SHELL, ...options.shell };
  const tree = (
    capabilities: readonly string[],
    identity: InvestigationRuntimeIdentity = options.identity ?? ALICE,
  ) => (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey={identity.id}
        identity={identity}
        authorityKey="alice-authority"
        capabilities={capabilities}
        readOnly={false}
        active
        focusCaseId={shell.focusCaseId}
        isInvestigationLocation
        onOpenCreated={shell.onOpenCase}
      >
        <BeaconStrategy {...shell} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>
  );
  const view = render(tree(options.capabilities ?? ["investigation:read", "investigation:write", "run:strategies"]));
  return {
    gateway,
    shell,
    rerenderCapabilities: (capabilities: readonly string[]) => view.rerender(tree(capabilities)),
    rerenderIdentity: (identity: InvestigationRuntimeIdentity) =>
      view.rerender(tree(options.capabilities ?? ["investigation:read", "investigation:write", "run:strategies"], identity)),
  };
}

describe("Beacon rapid-intake strategy", () => {
  it("meets every strategy-neutral Runtime component requirement", async () => {
    const report = await runComponentConformance({
      label: "Beacon rapid intake",
      component: BeaconStrategy,
      controls: {
        openRecord: (title) => new RegExp(title.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        back: /^Back to investigations$/u,
        retryInvestigations: /^Retry$/u,
      },
    });
    expect(report.evaluated.map(({ id }) => id)).toEqual(COMPONENT_SURFACE_REQUIREMENT_IDS);
  }, 60_000);

  it("creates a sparse investigation through the public command and opens the authoritative row", async () => {
    const created = { ...makePopulatedCase(), id: "beacon-created", title: "Checkout signal", problemStatement: "Timeouts started after rollout." };
    const gateway = createInvestigationGatewayDouble({
      createInvestigation: vi.fn(async () => gatewayOk(created)),
    });
    const onOpenCase = vi.fn();
    mount({ gateway, shell: { onOpenCase } });
    await screen.findByRole("heading", { name: "Recent signals" });
    fireEvent.click(screen.getByText("Optional technical context"));
    fireEvent.change(screen.getByRole("combobox", { name: "Product" }), { target: { value: "ContextDesk Storefront" } });
    expect(screen.getByText("Existing recorded value selected.")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Build" }), { target: { value: "new-build-2026.09" } });
    expect(screen.getByText("New value; it will be recorded exactly as entered.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Investigation title" }), { target: { value: created.title } });
    fireEvent.change(screen.getByRole("textbox", { name: "What did you observe?" }), { target: { value: created.problemStatement } });
    fireEvent.click(screen.getByRole("button", { name: "Create and open" }));
    await waitFor(() => expect(gateway.createInvestigation).toHaveBeenCalledTimes(1));
    expect(gateway.createInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: created.title,
        problemStatement: created.problemStatement,
        investigationContext: expect.objectContaining({ productName: "ContextDesk Storefront", build: "new-build-2026.09" }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onOpenCase).toHaveBeenCalledWith(created.id);
  });

  it("keeps append and promotions as three separate caller actions", async () => {
    const recordedEntry = { ...makeContributionList().contributions[0]!, id: "beacon-entry", kind: "note" as const, body: "Timeout rate is increasing." };
    const recordedHypothesis = { ...recordedEntry, id: "beacon-hypothesis", kind: "hypothesis" as const, body: "The rollout is correlated with the timeout increase." };
    const updated = { ...makePopulatedCase(), problemStatement: "Timeout rate increased after the rollout.", situationVersion: makePopulatedCase().situationVersion + 1 };
    const createContribution = vi.fn()
      .mockResolvedValueOnce(gatewayOk(recordedEntry))
      .mockResolvedValueOnce(gatewayOk(recordedHypothesis));
    const updateSituation = vi.fn(async () => gatewayOk(updated));
    const gateway = createInvestigationGatewayDouble({ createContribution, updateSituation });
    mount({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: makePopulatedCase().title });

    fireEvent.change(screen.getByRole("textbox", { name: "What happened next?" }), { target: { value: recordedEntry.body } });
    fireEvent.click(screen.getByRole("button", { name: "Record entry" }));
    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(1));
    expect(updateSituation).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: "New problem statement" }), { target: { value: updated.problemStatement } });
    fireEvent.click(screen.getByRole("button", { name: "Promote to Situation" }));
    await waitFor(() => expect(updateSituation).toHaveBeenCalledTimes(1));
    expect(createContribution).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("textbox", { name: "Hypothesis" }), { target: { value: recordedHypothesis.body } });
    fireEvent.change(screen.getByRole("combobox", { name: "Source entry (optional)" }), { target: { value: makeContributionList().contributions[0]!.id } });
    const recordHypothesis = screen.getByRole("button", { name: "Record hypothesis" });
    await waitFor(() => expect((recordHypothesis as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(recordHypothesis);
    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(2));
    expect(createContribution.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      kind: "hypothesis",
      body: recordedHypothesis.body,
      hypothesisLinks: [{ kind: "contribution", id: makeContributionList().contributions[0]!.id }],
    }));
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("attaches a log through the shared evidence command", async () => {
    const gateway = createInvestigationGatewayDouble();
    mount({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Supporting material" });
    const file = new File(["gateway timeout"], "gateway.log", { type: "text/plain" });
    const fileInput = screen.getByLabelText(/File \(up to/u) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByRole("textbox", { name: "Why does this matter?" }), { target: { value: "Captured during the affected interval." } });
    const attach = screen.getByRole("button", { name: "Attach evidence" });
    fireEvent.submit(attach.closest("form")!);
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({ filename: "gateway.log", mediaType: "text/plain", kind: "attachment", summary: "Captured during the affected interval." }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("drops an owner-only upload draft when private-read authority is removed", async () => {
    const gateway = createInvestigationGatewayDouble();
    const { rerenderCapabilities } = mount({
      gateway,
      capabilities: ["investigation:read", "investigation:write", "evidence:private:read"],
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    const privacy = await screen.findByRole("combobox", { name: "Privacy" }) as HTMLSelectElement;
    expect(privacy.value).toBe("owner_only");
    rerenderCapabilities(["investigation:read", "investigation:write"]);
    await waitFor(() => expect(privacy.value).toBe(""));
    expect(screen.queryByRole("option", { name: "Owner only" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Choose a privacy level again/u);
    const file = new File(["private draft"], "authority-change.log", { type: "text/plain" });
    const fileInput = screen.getByLabelText(/File \(up to/u) as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByRole("textbox", { name: "Why does this matter?" }), { target: { value: "Captured before authority changed." } });
    expect((screen.getByRole("button", { name: "Attach evidence" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(privacy, { target: { value: "share_safe" } });
    fireEvent.submit(screen.getByRole("button", { name: "Attach evidence" }).closest("form")!);
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({ privacyClass: "share_safe" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("clears browser-local intake drafts when the authenticated identity changes", async () => {
    const { rerenderIdentity } = mount();
    const title = await screen.findByRole("textbox", { name: "Investigation title" }) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Alice's unfinished signal" } });
    expect(title.value).toBe("Alice's unfinished signal");
    rerenderIdentity({ id: "bob", username: "bob", displayName: "Bob Singh" });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Investigation title" }) as HTMLInputElement).value).toBe(""));
  });

  it("preserves a draft when only the same identity's descriptive profile changes", async () => {
    const { rerenderIdentity } = mount();
    const title = await screen.findByRole("textbox", { name: "Investigation title" }) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Same user's unfinished signal" } });
    rerenderIdentity({ ...ALICE, displayName: "Alice N." });
    expect((screen.getByRole("textbox", { name: "Investigation title" }) as HTMLInputElement).value)
      .toBe("Same user's unfinished signal");
  });

  it("focuses a truthful, non-busy denied detail without issuing a read", async () => {
    const gateway = createInvestigationGatewayDouble();
    mount({
      gateway,
      capabilities: [],
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    const heading = await screen.findByRole("heading", { name: "Investigation unavailable in this view" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByRole("status").textContent).toMatch(/no record data was requested/u);
    expect(screen.queryByText(/Opening investigation/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
    expect(gateway.getInvestigation).not.toHaveBeenCalled();
    expect(gateway.listEvidence).not.toHaveBeenCalled();
    expect(gateway.listContributions).not.toHaveBeenCalled();
    expect(gateway.getLifecycle).not.toHaveBeenCalled();
  });
});
