import type { ContributionV1 } from "@cd-collab/contracts/investigation-runtime";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationRuntimeProvider,
  useInvestigationRuntime,
  type InvestigationRuntime,
  type InvestigationRuntimeIdentity,
  type CaseV1,
} from "../../runtime/public.js";
import {
  createDeferred,
  createInvestigationGatewayDouble,
  gatewayOk,
  gatewayUnavailable,
  InvestigationRuntimeGatewayHarness,
  makeCaseList,
  makeContributionList,
  makePopulatedCase,
  RUNTIME_FIXTURE_IDS,
  type GatewayResult,
  type InvestigationGateway,
} from "../../runtime/testkit/index.js";
import type { InvestigationStrategyShellProps } from "../contract.js";
import { KeystoneStrategy } from "./KeystoneStrategy.js";

const FULL_CAPABILITIES = ["investigation:read", "investigation:write", "run:strategies"] as const;
const ALICE = Object.freeze({ id: "alice", username: "alice", displayName: "Alice Nguyen" });

const SHELL: InvestigationStrategyShellProps = {
  view: "investigations",
  focusCaseId: null,
  stage: "situation",
  onOpenCase: vi.fn(),
  onNavigateInvestigation: vi.fn(),
  onExitFocus: vi.fn(),
};

function RuntimeSink({ sink }: { readonly sink: { current: InvestigationRuntime | null } }) {
  sink.current = useInvestigationRuntime();
  return null;
}

function mountStrategy(options: {
  readonly gateway?: InvestigationGateway;
  readonly capabilities?: readonly string[];
  readonly readOnly?: boolean;
  readonly identity?: InvestigationRuntimeIdentity;
  readonly shell?: Partial<InvestigationStrategyShellProps>;
} = {}) {
  const gateway = options.gateway ?? createInvestigationGatewayDouble();
  const initialShell = { ...SHELL, ...options.shell };
  const runtimeSink: { current: InvestigationRuntime | null } = { current: null };
  const tree = (
    shell: InvestigationStrategyShellProps,
    identity: InvestigationRuntimeIdentity,
  ) => (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey={identity.id}
        identity={identity}
        authorityKey={`${identity.id}-authority`}
        capabilities={options.capabilities ?? FULL_CAPABILITIES}
        readOnly={options.readOnly ?? false}
        active
        focusCaseId={shell.focusCaseId}
        isInvestigationLocation
        onOpenCreated={shell.onOpenCase}
      >
        <RuntimeSink sink={runtimeSink} />
        <KeystoneStrategy {...shell} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>
  );
  let currentShell = initialShell;
  let currentIdentity = options.identity ?? ALICE;
  const view = render(tree(currentShell, currentIdentity));
  return {
    gateway,
    runtime() {
      if (runtimeSink.current === null) throw new Error("runtime did not render");
      return runtimeSink.current;
    },
    rerender(
      shell: Partial<InvestigationStrategyShellProps> = {},
      identity: InvestigationRuntimeIdentity = currentIdentity,
    ) {
      currentShell = { ...currentShell, ...shell };
      currentIdentity = identity;
      view.rerender(tree(currentShell, currentIdentity));
    },
  };
}

afterEach(() => cleanup());

describe("Keystone engineer strategy", () => {
  it("keeps server collection order through sparse-safe search and status filtering", async () => {
    const onOpenCase = vi.fn();
    const mounted = mountStrategy({ shell: { onOpenCase } });
    const rows = makeCaseList().cases;
    const buttons = await screen.findAllByRole("button", { name: /investigation|checkout/iu });
    expect(buttons[0]?.textContent).toContain(rows[0]?.title);
    expect(buttons[1]?.textContent).toContain(rows[1]?.title);
    expect(screen.getByText("Not recorded")).toBeTruthy();

    const search = screen.getByRole("searchbox", { name: "Search investigations" });
    fireEvent.change(search, { target: { value: "checkout" } });
    expect(screen.queryByRole("button", { name: /Imported investigation/u })).toBeNull();
    expect(screen.getByRole("button", { name: /Checkout latency/u })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), {
      target: { value: "open" },
    });
    expect(screen.getByText("No matching investigations")).toBeTruthy();

    act(() => search.focus());
    mounted.rerender({ startSignal: 42 });
    expect(document.activeElement).toBe(search);
    expect(onOpenCase).not.toHaveBeenCalled();
    expect(mounted.gateway.createInvestigation).not.toHaveBeenCalled();
    expect(mounted.gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(mounted.gateway.applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("shows the evidence grid, linked reasoning, and canonical record without write controls in read-only mode", async () => {
    const onNavigateInvestigation = vi.fn();
    const mounted = mountStrategy({
      shell: {
        focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase,
        onNavigateInvestigation,
      },
      readOnly: true,
    });
    const detailHeading = await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    await waitFor(() => expect(document.activeElement).toBe(detailHeading));
    expect(await screen.findByRole("button", { name: "checkout-timeout.log" })).toBeTruthy();
    expect(screen.getAllByText("Gateway timeout excerpt captured during the affected interval.").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "checkout-timeout.log" }));
    expect(screen.getByText("text/plain")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(onNavigateInvestigation).toHaveBeenLastCalledWith({
      investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
      stage: "capture",
    });
    const detailsTab = screen.getByRole("tab", { name: "Details" });
    act(() => detailsTab.focus());
    fireEvent.keyDown(detailsTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Reasoning" }));
    expect(screen.getByRole("tab", { name: "Reasoning" }).getAttribute("aria-selected")).toBe("true");
    expect(onNavigateInvestigation).toHaveBeenLastCalledWith({
      investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
      stage: "analyze",
    });
    expect(screen.getAllByText("Gateway timeout excerpt captured during the affected interval.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
    expect(onNavigateInvestigation).toHaveBeenLastCalledWith({
      investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
      stage: "situation",
    });
    expect(screen.getByText("Checkout requests exceed the recorded latency objective.")).toBeTruthy();
    expect(screen.getByText("2026.02.03.4")).toBeTruthy();
    expect(document.querySelectorAll("form")).toHaveLength(0);
    expect(mounted.gateway.createInvestigation).not.toHaveBeenCalled();
    expect(mounted.gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(mounted.gateway.applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("records a working-set hypothesis and a bounded situation correction through Runtime commands", async () => {
    const contribution = {
      ...makeContributionList().contributions[0]!,
      id: "contribution-keystone-hypothesis",
      kind: "hypothesis" as const,
      body: "The timeout aligns with the rollout window.",
      hypothesisLinks: [{ kind: "artifact" as const, id: RUNTIME_FIXTURE_IDS.evidence }],
    };
    const updated = {
      ...makePopulatedCase(),
      situationVersion: makePopulatedCase().situationVersion + 1,
      problemStatement: "Checkout requests exceed the revised latency objective.",
    };
    const gateway = createInvestigationGatewayDouble({
      createContribution: vi.fn(async () => gatewayOk(contribution)),
      updateSituation: vi.fn(async () => gatewayOk(updated)),
    });
    const onNavigateInvestigation = vi.fn();
    const mounted = mountStrategy({
      gateway,
      shell: {
        focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase,
        onNavigateInvestigation,
      },
    });

    const evidenceButton = await screen.findByRole("button", { name: "checkout-timeout.log" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Add checkout-timeout\.log to working set/u }));
    fireEvent.click(screen.getByRole("tab", { name: "Reasoning" }));
    const hypothesis = screen.getByRole("textbox", { name: "Hypothesis" });
    fireEvent.change(hypothesis, { target: { value: contribution.body } });
    fireEvent.click(screen.getByRole("button", { name: "Record hypothesis" }));
    await waitFor(() => expect(gateway.createContribution).toHaveBeenCalledTimes(1));
    expect(gateway.createContribution).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        kind: "hypothesis",
        body: contribution.body,
        hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fireEvent.click(evidenceButton);
    expect(onNavigateInvestigation).toHaveBeenLastCalledWith({
      investigationId: RUNTIME_FIXTURE_IDS.populatedCase,
      stage: "capture",
    });
    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit situation" }));
    const problem = screen.getByRole("textbox", { name: "Problem statement" });
    fireEvent.change(problem, { target: { value: updated.problemStatement } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(gateway.updateSituation).toHaveBeenCalledTimes(1));
    expect(gateway.updateSituation).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({
        expectedVersion: makePopulatedCase().situationVersion,
        problemStatement: updated.problemStatement,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText(updated.problemStatement)).toBeTruthy();
    expect(mounted.gateway.createInvestigation).not.toHaveBeenCalled();
    expect(mounted.gateway.uploadEvidence).not.toHaveBeenCalled();
    expect(mounted.gateway.applyLifecycleAction).not.toHaveBeenCalled();
  });

  it("keeps same-case drafts mounted across canonical inspector tab changes", async () => {
    const mounted = mountStrategy({
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("button", { name: "checkout-timeout.log" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Add checkout-timeout\.log to working set/u }));
    fireEvent.click(screen.getByRole("tab", { name: "Reasoning" }));
    const hypothesis = screen.getByRole("textbox", { name: "Hypothesis" });
    fireEvent.change(hypothesis, { target: { value: "Draft retained across tabs" } });

    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit situation" }));
    const impact = screen.getByRole("textbox", { name: "Impact" });
    fireEvent.change(impact, { target: { value: "Draft impact retained across tabs" } });

    fireEvent.click(screen.getByRole("tab", { name: "Reasoning" }));
    expect((screen.getByRole("textbox", { name: "Hypothesis" }) as HTMLTextAreaElement).value).toBe(
      "Draft retained across tabs",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Record" }));
    expect((screen.getByRole("textbox", { name: "Impact" }) as HTMLTextAreaElement).value).toBe(
      "Draft impact retained across tabs",
    );
    expect(mounted.gateway.createContribution).not.toHaveBeenCalled();
    expect(mounted.gateway.updateSituation).not.toHaveBeenCalled();
  });

  it("labels focused loading state as a status before the record arrives", async () => {
    const pending = createDeferred<GatewayResult<CaseV1>>();
    const gateway = createInvestigationGatewayDouble({
      getInvestigation: vi.fn(() => pending.promise),
    });
    mountStrategy({
      gateway,
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Opening investigation");
    expect(status.closest(".strategy-kit__notice")?.getAttribute("aria-busy")).toBe("true");

    pending.resolve(gatewayOk(makeCaseList().cases[0]!));
    expect(await screen.findByRole("heading", { name: "Imported investigation" })).toBeTruthy();
  });

  it("fences the in-memory working set by identity and investigation", async () => {
    const mounted = mountStrategy({ shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    const checkbox = await screen.findByRole("checkbox", {
      name: "Add checkout-timeout.log to working set",
    });
    fireEvent.click(checkbox);
    expect(screen.getByText("Temporary for this signed-in identity and investigation. Nothing is saved or sent.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear working set" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Remove checkout-timeout.log from working set" }) as HTMLInputElement).checked).toBe(true);

    mounted.rerender({}, { id: "ravi", username: "ravi", displayName: "Ravi Shah" });
    await waitFor(() => expect(screen.getByText("No evidence selected")).toBeTruthy());
    expect((screen.getByRole("checkbox", { name: "Add checkout-timeout.log to working set" }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps evidence usable when contribution annotations fail independently", async () => {
    let attempts = 0;
    const gateway = createInvestigationGatewayDouble({
      listContributions: vi.fn(async () => {
        attempts += 1;
        return gatewayUnavailable<readonly ContributionV1[]>();
      }),
    });
    mountStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByRole("button", { name: "checkout-timeout.log" })).toBeTruthy();
    expect(screen.getByText("Annotation is unavailable.")).toBeTruthy();
    expect(screen.getAllByRole("alert").some((node) => node.textContent?.includes("Linked annotations unavailable"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry recorded contributions" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(screen.getByRole("button", { name: "checkout-timeout.log" })).toBeTruthy();
  });

  it("distinguishes stale success while retaining the last collection", async () => {
    const pending = createDeferred<GatewayResult<readonly CaseV1[]>>();
    let calls = 0;
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(gatewayOk(makeCaseList().cases))
          : pending.promise;
      }),
    });
    const mounted = mountStrategy({ gateway });
    expect(await screen.findByRole("button", { name: /Checkout latency/u })).toBeTruthy();
    act(() => mounted.runtime().refresh.investigations());
    expect(await screen.findByText("Refreshing collection")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Checkout latency/u })).toBeTruthy();

    pending.resolve(gatewayUnavailable<readonly CaseV1[]>());
    expect(await screen.findByText("Collection refresh incomplete")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Checkout latency/u })).toBeTruthy();
  });

  it("makes denied detail truthful and issues no reads or retries", async () => {
    const gateway = createInvestigationGatewayDouble();
    const onExitFocus = vi.fn();
    mountStrategy({
      gateway,
      capabilities: [],
      shell: { focusCaseId: "case-not-readable", onExitFocus },
    });
    const heading = screen.getByRole("heading", { name: "Investigation reading unavailable" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText(/No investigation data was requested/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to investigations" }));
    expect(onExitFocus).toHaveBeenCalledTimes(1);
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
    expect(gateway.getInvestigation).not.toHaveBeenCalled();
    expect(gateway.listEvidence).not.toHaveBeenCalled();
    expect(gateway.listContributions).not.toHaveBeenCalled();
    expect(gateway.getLifecycle).not.toHaveBeenCalled();
  });
});
