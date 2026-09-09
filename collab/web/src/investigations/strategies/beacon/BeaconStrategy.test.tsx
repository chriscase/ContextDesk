import type { ArtifactV1, ContributionV1 } from "@cd-collab/contracts/investigation-runtime";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvestigationRuntimeProvider,
  type InvestigationCollectionPageV1,
  type InvestigationRuntimeIdentity,
} from "../../runtime/public.js";
import {
  createDeferred,
  createInvestigationGatewayDouble,
  gatewayOk,
  gatewayUnavailable,
  InvestigationRuntimeGatewayHarness,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
  makePopulatedCase,
  RUNTIME_FIXTURE_IDS,
  type GatewayResult,
  type InvestigationGateway,
} from "../../runtime/testkit/index.js";
import type { InvestigationStrategyShellProps } from "../contract.js";
import { DEFAULT_COLLECTION_QUERY } from "../../../app-location.js";
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
  let shell = { ...SHELL, ...options.shell };
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
    rerenderShell: (shellOverrides: Partial<InvestigationStrategyShellProps>) => {
      shell = { ...shell, ...shellOverrides };
      view.rerender(tree(options.capabilities ?? ["investigation:read", "investigation:write", "run:strategies"]));
    },
  };
}

describe("Beacon rapid-intake strategy", () => {
  it("uses the public collection page for shell-owned browse filters and facets", async () => {
    const selected = makePopulatedCase();
    const page: InvestigationCollectionPageV1 = {
      schemaId: "cd-collab.investigation_collection_page.v1",
      items: [selected],
      nextCursor: null,
      hiddenArchivedCount: 3,
      facets: {
        status: { top: [{ key: "monitoring", count: 1 }], otherCount: 0 },
        entity: { top: [], otherCount: 0 },
        impactIdentity: { top: [], otherCount: 0 },
        contributor: { top: [], otherCount: 0 },
      },
    };
    const queryInvestigations = vi.fn(async (..._args: unknown[]) => gatewayOk(page));
    const onCollectionQueryChange = vi.fn();
    mount({
      gateway: createInvestigationGatewayDouble({ queryInvestigations }),
      shell: {
        collectionQuery: {
          ...DEFAULT_COLLECTION_QUERY,
          q: "checkout",
          status: ["monitoring"],
          includeArchived: true,
        },
        onCollectionQueryChange,
      },
    });

    expect(await screen.findByRole("button", { name: /Checkout latency after 4\.8\.0 rollout/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Imported investigation/u })).toBeNull();
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));
    expect(queryInvestigations.mock.calls[0]?.[0]).toMatchObject({
      q: "checkout",
      status: ["monitoring"],
      includeArchived: true,
    });
    expect(screen.getByText(/3 archived hidden/u)).toBeTruthy();
    const facet = screen.getByRole("button", { name: /monitoring 1/u });
    expect(facet.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find an investigation" }), {
      target: { value: "timeout" },
    });
    expect(onCollectionQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ q: "timeout" }));
    fireEvent.click(facet);
    expect(onCollectionQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: [] }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Include archived" }));
    expect(onCollectionQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ includeArchived: false }));
  });

  it("refreshes the same collection once after detail without reading while focused", async () => {
    const selected = makePopulatedCase();
    const page: InvestigationCollectionPageV1 = {
      schemaId: "cd-collab.investigation_collection_page.v1",
      items: [selected],
      nextCursor: null,
      hiddenArchivedCount: 0,
      facets: {
        status: { top: [], otherCount: 0 },
        entity: { top: [], otherCount: 0 },
        impactIdentity: { top: [], otherCount: 0 },
        contributor: { top: [], otherCount: 0 },
      },
    };
    const queryInvestigations = vi.fn(async (..._args: unknown[]) => gatewayOk(page));
    const gateway = createInvestigationGatewayDouble({ queryInvestigations });
    const collectionQuery = { ...DEFAULT_COLLECTION_QUERY, q: "checkout " };
    const tree = (focusCaseId: string | null) => {
      const shell = { ...SHELL, focusCaseId, collectionQuery };
      return (
        <InvestigationRuntimeGatewayHarness gateway={gateway}>
          <InvestigationRuntimeProvider
            identityKey={ALICE.id}
            identity={ALICE}
            authorityKey="alice-authority"
            capabilities={["investigation:read", "investigation:write", "run:strategies"]}
            readOnly={false}
            active
            focusCaseId={focusCaseId}
            isInvestigationLocation
            onOpenCreated={shell.onOpenCase}
          >
            <BeaconStrategy {...shell} />
          </InvestigationRuntimeProvider>
        </InvestigationRuntimeGatewayHarness>
      );
    };
    const rendered = render(tree(null));
    await screen.findByRole("heading", { name: "Recent signals" });
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(1));

    rendered.rerender(tree(RUNTIME_FIXTURE_IDS.populatedCase));
    await screen.findByRole("heading", { name: selected.title });
    expect(queryInvestigations).toHaveBeenCalledTimes(1);

    rendered.rerender(tree(null));
    await screen.findByRole("heading", { name: "Recent signals" });
    await waitFor(() => expect(queryInvestigations).toHaveBeenCalledTimes(2));
    expect(queryInvestigations.mock.calls[1]?.[0]).toEqual(queryInvestigations.mock.calls[0]?.[0]);

    rendered.rerender(tree(null));
    await screen.findByRole("heading", { name: "Recent signals" });
    expect(queryInvestigations).toHaveBeenCalledTimes(2);
  });

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

  it("records a handoff through the shared panel without inventing workflow state", async () => {
    const handoff = {
      ...makeContributionList().contributions[0]!,
      id: "beacon-handoff",
      kind: "handoff" as const,
      body: "Note: Overnight queue time remains high.\n\nNext action: Recheck the pool.",
    };
    const createContribution = vi.fn(async () => gatewayOk(handoff));
    const gateway = createInvestigationGatewayDouble({ createContribution });
    mount({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Handoff" });

    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Overnight queue time remains high." },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Next action (optional)" }), {
      target: { value: "Recheck the pool." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record handoff" }));

    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(1));
    expect(createContribution).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({
        kind: "handoff",
        body: "Note: Overnight queue time remains high.\n\nNext action: Recheck the pool.",
        privacyClass: "share_safe",
        idempotencyKey: expect.stringMatching(/^handoff-/u),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.textContent).not.toMatch(/priority|SLA|assignment|progress/iu);
  });

  it("does not borrow another contribution's mutation status for handoff feedback", async () => {
    const deferred = createDeferred<GatewayResult<ContributionV1>>();
    const createContribution = vi.fn(() => deferred.promise);
    const gateway = createInvestigationGatewayDouble({ createContribution });
    mount({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Handoff" });

    fireEvent.change(screen.getByRole("textbox", { name: "Hypothesis" }), {
      target: { value: "The rollout is correlated with the timeout increase." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record hypothesis" }));
    await waitFor(() => expect(createContribution).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "Handoff draft remains independent." },
    });
    const handoffButton = screen.getByRole("button", { name: "Record handoff" });
    expect((handoffButton as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Recording the handoff once…")).toBeNull();

    deferred.resolve(gatewayOk({
      ...makeContributionList().contributions[0]!,
      id: "beacon-hypothesis-pending",
      kind: "hypothesis" as const,
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Record hypothesis" })).toBeTruthy());
  });

  it("attaches a log through the shared evidence command", async () => {
    const gateway = createInvestigationGatewayDouble();
    mount({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Supporting material" });
    const file = new File(["gateway timeout"], "gateway.log", { type: "text/plain" });
    const fileInput = screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement;
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

  it("keeps an unknown upload draft blocked until an authoritative refresh enables one explicit retry", async () => {
    const refresh = createDeferred<GatewayResult<readonly ArtifactV1[]>>();
    let evidenceReads = 0;
    const listEvidence = vi.fn(() => {
      evidenceReads += 1;
      return evidenceReads === 2
        ? refresh.promise
        : Promise.resolve(gatewayOk(makeEvidenceList().artifacts));
    });
    const uploadEvidence = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
      })
      .mockResolvedValueOnce(gatewayOk(makeEvidenceUploadSuccess()));
    mount({
      gateway: createInvestigationGatewayDouble({ listEvidence, uploadEvidence }),
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "Supporting material" });
    const file = new File(["gateway timeout"], "gateway.log", { type: "text/plain" });
    const fileInput = screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    const summary = screen.getByRole("textbox", { name: "Why does this matter?" }) as HTMLInputElement;
    fireEvent.change(summary, { target: { value: "Captured during the affected interval." } });
    const firstSubmit = screen.getByRole("button", { name: "Attach evidence" });
    fireEvent.submit(firstSubmit.closest("form")!);

    await waitFor(() => expect(uploadEvidence).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listEvidence).toHaveBeenCalledTimes(2));
    const blocked = await screen.findByRole("button", { name: "Upload blocked until inventory refresh" });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/not confirmed.*being refreshed.*not confirmation.*stored or rolled back/isu);
    expect(fileInput.files?.[0]).toBe(file);
    expect(summary.value).toBe("Captured during the affected interval.");
    fireEvent.submit(blocked.closest("form")!);
    expect(uploadEvidence).toHaveBeenCalledTimes(1);

    await act(async () => refresh.resolve(gatewayOk(makeEvidenceList().artifacts)));
    const retry = await screen.findByRole("button", { name: "Retry upload after checking inventory" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(retry.closest("form")!);
    await waitFor(() => expect(uploadEvidence).toHaveBeenCalledTimes(2));
    expect(uploadEvidence.mock.calls[1]?.[1]).toEqual(uploadEvidence.mock.calls[0]?.[1]);
    expect(uploadEvidence.mock.calls[1]?.[1]).toMatchObject({
      filename: "gateway.log",
      kind: "attachment",
      privacyClass: "share_safe",
      summary: "Captured during the affected interval.",
    });
  });

  it("does not carry a reconciled upload draft into another investigation", async () => {
    const secondCaseId = "11111111-1111-4111-8111-111111111111";
    const firstCase = { ...makePopulatedCase(), title: "First investigation" };
    const secondCase = { ...makePopulatedCase(), id: secondCaseId, title: "Second investigation" };
    const getInvestigation = vi.fn(async (caseId: string) => gatewayOk(caseId === secondCaseId ? secondCase : firstCase));
    const uploadEvidence = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
    }));
    const { rerenderShell } = mount({
      gateway: createInvestigationGatewayDouble({
        listInvestigations: vi.fn(async () => gatewayOk([firstCase, secondCase])),
        getInvestigation,
        uploadEvidence,
      }),
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "First investigation" });
    const fileInput = screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["case A"], "case-a.log", { type: "text/plain" })] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Why does this matter?" }), { target: { value: "Only for case A." } });
    fireEvent.submit(screen.getByRole("button", { name: "Attach evidence" }).closest("form")!);

    await screen.findByRole("button", { name: "Retry upload after checking inventory" });
    rerenderShell({ focusCaseId: secondCaseId });
    await screen.findByRole("heading", { name: "Second investigation" });
    expect(screen.queryByRole("button", { name: /Retry upload|Upload blocked/u })).toBeNull();
    expect((screen.getByRole("textbox", { name: "Why does this matter?" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement).files).toHaveLength(0);
    fireEvent.submit(screen.getByRole("button", { name: "Attach evidence" }).closest("form")!);
    expect(uploadEvidence).toHaveBeenCalledTimes(1);
  });

  it("ignores an unknown upload completion from a previous investigation", async () => {
    const secondCaseId = "22222222-2222-4222-8222-222222222222";
    const completion = createDeferred<GatewayResult<ReturnType<typeof makeEvidenceUploadSuccess>>>();
    const uploadEvidence = vi.fn(() => completion.promise);
    const firstCase = { ...makePopulatedCase(), title: "Original investigation" };
    const secondCase = { ...makePopulatedCase(), id: secondCaseId, title: "Replacement investigation" };
    const getInvestigation = vi.fn(async (caseId: string) => gatewayOk(caseId === secondCaseId ? secondCase : firstCase));
    const { rerenderShell } = mount({
      gateway: createInvestigationGatewayDouble({
        listInvestigations: vi.fn(async () => gatewayOk([firstCase, secondCase])),
        getInvestigation,
        uploadEvidence,
      }),
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "Original investigation" });
    fireEvent.change(screen.getByLabelText(/File \(server-configured limit\)/u), { target: { files: [new File(["old"], "old.log")] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Why does this matter?" }), { target: { value: "Old scope." } });
    fireEvent.submit(screen.getByRole("button", { name: "Attach evidence" }).closest("form")!);
    await waitFor(() => expect(uploadEvidence).toHaveBeenCalledTimes(1));

    rerenderShell({ focusCaseId: secondCaseId });
    await screen.findByRole("heading", { name: "Replacement investigation" });
    await act(async () => completion.resolve({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    }));
    expect(screen.queryByRole("button", { name: /Retry upload|Upload blocked/u })).toBeNull();
    expect(screen.queryByText(/upload result was not confirmed/iu)).toBeNull();
    expect(uploadEvidence).toHaveBeenCalledTimes(1);
  });

  it("keeps an unknown upload blocked when authoritative refresh fails", async () => {
    let evidenceReads = 0;
    const listEvidence = vi.fn(async () => {
      evidenceReads += 1;
      return evidenceReads === 1
        ? gatewayOk(makeEvidenceList().artifacts)
        : gatewayUnavailable<readonly ArtifactV1[]>();
    });
    const uploadEvidence = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
    }));
    mount({
      gateway: createInvestigationGatewayDouble({ listEvidence, uploadEvidence }),
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "Supporting material" });
    const file = new File(["gateway timeout"], "gateway.log", { type: "text/plain" });
    const fileInput = screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    const summary = screen.getByRole("textbox", { name: "Why does this matter?" }) as HTMLInputElement;
    fireEvent.change(summary, { target: { value: "Keep this draft." } });
    fireEvent.submit(screen.getByRole("button", { name: "Attach evidence" }).closest("form")!);

    const blocked = await screen.findByRole("button", { name: "Upload blocked until inventory refresh" });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => /could not be refreshed.*not confirmation.*stored or rolled back/isu.test(alert.textContent ?? ""))).toBe(true));
    expect(fileInput.files?.[0]).toBe(file);
    expect(summary.value).toBe("Keep this draft.");
    fireEvent.submit(blocked.closest("form")!);
    expect(uploadEvidence).toHaveBeenCalledTimes(1);
  });

  it("keeps an ordinary unavailable upload retryable and outside the unknown gate", async () => {
    const uploadEvidence = vi.fn(async () => gatewayUnavailable<ReturnType<typeof makeEvidenceUploadSuccess>>());
    mount({
      gateway: createInvestigationGatewayDouble({ uploadEvidence }),
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "Supporting material" });
    const fileInput = screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "ordinary.log", { type: "text/plain" })] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Why does this matter?" }), { target: { value: "Ordinary failure." } });
    const submit = screen.getByRole("button", { name: "Attach evidence" });
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() => expect(uploadEvidence).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert").textContent).toMatch(/could not be completed right now/u);
    expect(screen.getByRole("alert").textContent).not.toMatch(/not confirmed|stored or rolled back/u);
    expect((screen.getByRole("button", { name: "Attach evidence" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() => expect(uploadEvidence).toHaveBeenCalledTimes(2));
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
    const fileInput = screen.getByLabelText(/File \(server-configured limit\)/u) as HTMLInputElement;
    const privateFile = new File(["private draft"], "authority-change.log", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [privateFile] });
    Object.defineProperty(fileInput, "value", { configurable: true, writable: true, value: "C:\\fakepath\\authority-change.log" });
    rerenderCapabilities(["investigation:read", "investigation:write"]);
    await waitFor(() => expect(privacy.value).toBe(""));
    expect(fileInput.value).toBe("");
    expect(screen.queryByRole("option", { name: "Owner only" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/Choose a privacy level again/u);
    const file = new File(["reviewed share-safe content"], "authority-change.log", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    fireEvent.change(fileInput);
    fireEvent.change(screen.getByRole("textbox", { name: "Why does this matter?" }), { target: { value: "Captured before authority changed." } });
    expect((screen.getByRole("button", { name: "Attach evidence" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(privacy, { target: { value: "share_safe" } });
    expect(screen.queryByRole("alert")).toBeNull();
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
