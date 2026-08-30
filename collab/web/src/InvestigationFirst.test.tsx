import {
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  type ArtifactV1,
  type CaseV1,
  type ContributionV1,
  type InvestigationLifecycleActionSuccessV1,
  type InvestigationLifecycleV1,
} from "@cd-collab/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationFirst } from "./InvestigationFirst.js";
import { InvestigationRuntimeProvider } from "./investigations/runtime/public.js";
import type {
  GatewayResult,
  InvestigationGateway,
} from "./investigations/runtime/gateway.js";
import {
  makeArchiveAllowedLifecycle,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
  makePopulatedCase,
  makeRestoreAllowedLifecycle,
  makeSparseImportedCase,
  RUNTIME_FIXTURE_IDS,
} from "./investigations/runtime/testkit/index.js";
import { createDeferred } from "./investigations/runtime/testkit/promises.js";
import type { InvestigationStrategyShellProps } from "./investigations/strategies/contract.js";

const FULL_CAPABILITIES = ["investigation:read", "investigation:write", "run:strategies"] as const;

function succeeded<T>(value: T): GatewayResult<T> { return { ok: true, value }; }
function unexpected<T>(): Promise<GatewayResult<T>> { return Promise.resolve({ ok: false, error: { kind: "unexpected" } }); }
function unavailable<T>(): GatewayResult<T> { return { ok: false, error: { kind: "unavailable", status: 503 } }; }

function makeLifecycle(investigation: CaseV1): InvestigationLifecycleV1 {
  const template = investigation.status === "archived" ? makeRestoreAllowedLifecycle() : makeArchiveAllowedLifecycle();
  return { ...template, investigationId: investigation.id, status: investigation.status };
}

function makeGateway(overrides: Partial<InvestigationGateway> = {}): InvestigationGateway {
  const populated = makePopulatedCase();
  return {
    listInvestigations: vi.fn(async () => succeeded(makeCaseList().cases)),
    getInvestigation: vi.fn(async () => succeeded(populated)),
    createInvestigation: vi.fn(() => unexpected<CaseV1>()),
    listEvidence: vi.fn(async () => succeeded(makeEvidenceList().artifacts)),
    listContributions: vi.fn(async () => succeeded(makeContributionList().contributions)),
    uploadEvidence: vi.fn(() => unexpected<never>()),
    getLifecycle: vi.fn(async () => succeeded(makeLifecycle(populated))),
    applyLifecycleAction: vi.fn(() => unexpected<never>()),
    ...overrides,
  };
}

const shellDefaults: InvestigationStrategyShellProps = {
  view: "investigations",
  focusCaseId: null,
  stage: "situation",
  onOpenCase: vi.fn(),
  onExitFocus: vi.fn(),
};

function renderStrategy(options: {
  gateway?: InvestigationGateway;
  capabilities?: readonly string[];
  readOnly?: boolean;
  shell?: Partial<InvestigationStrategyShellProps>;
} = {}) {
  const gateway = options.gateway ?? makeGateway();
  const shell = { ...shellDefaults, ...options.shell };
  const capabilities = options.capabilities ?? FULL_CAPABILITIES;
  const readOnly = options.readOnly ?? false;
  const view = render(
    <InvestigationRuntimeProvider
      identityKey="alice"
      authorityKey="alice-authority-v1"
      capabilities={capabilities}
      readOnly={readOnly}
      active
      focusCaseId={shell.focusCaseId}
      isInvestigationLocation
      onOpenCreated={shell.onOpenCase}
      gateway={gateway}
    >
      <InvestigationFirst {...shell} />
    </InvestigationRuntimeProvider>,
  );
  return {
    gateway,
    rerender(shellOverrides: Partial<InvestigationStrategyShellProps>) {
      const nextShell = { ...shell, ...shellOverrides };
      view.rerender(
        <InvestigationRuntimeProvider
          identityKey="alice"
          authorityKey="alice-authority-v1"
          capabilities={capabilities}
          readOnly={readOnly}
          active
          focusCaseId={nextShell.focusCaseId}
          isInvestigationLocation
          onOpenCreated={nextShell.onOpenCase}
          gateway={gateway}
        >
          <InvestigationFirst {...nextShell} />
        </InvestigationRuntimeProvider>,
      );
    },
  };
}

afterEach(() => cleanup());

describe("Investigation First Runtime V1 presentation", () => {
  it("keeps fast capture above browse and distinguishes existing from new combo values", async () => {
    renderStrategy();
    const create = await screen.findByRole("heading", { name: "Create an investigation" });
    const browse = screen.getByRole("heading", { name: "Investigations" });
    expect(create.compareDocumentPosition(browse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByText("Advanced context"));
    const product = screen.getByRole("combobox", { name: "Product or software" });
    fireEvent.change(product, { target: { value: "ContextDesk Storefront" } });
    expect(screen.getByText("Using an existing recorded value.")).toBeTruthy();
    fireEvent.change(product, { target: { value: "A new product" } });
    expect(screen.getByText("New value — it will be recorded exactly as entered.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter investigations by status"), { target: { value: "monitoring" } });
    expect(screen.getByRole("button", { name: /Checkout latency/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Imported investigation/ })).toBeNull();
  });

  it("creates exactly once and lets the provider open the server-confirmed identity", async () => {
    const created = { ...makeSparseImportedCase(), id: "case-server-id", title: "New investigation" };
    const gateway = makeGateway({ createInvestigation: vi.fn(async () => succeeded(created)) });
    const onOpenCase = vi.fn();
    renderStrategy({ gateway, shell: { onOpenCase } });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "New investigation" } });
    fireEvent.change(screen.getByPlaceholderText("Describe the problem without assuming its cause."), { target: { value: "A clear observation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));
    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith("case-server-id"));
    expect(gateway.createInvestigation).toHaveBeenCalledTimes(1);
    expect(gateway.createInvestigation).toHaveBeenCalledWith(expect.objectContaining({ title: "New investigation", problemStatement: "A clear observation", severity: "medium" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("renders a sparse imported detail and preserves the explicit technical handoff", async () => {
    const sparse = makeSparseImportedCase();
    const gateway = makeGateway({
      getInvestigation: vi.fn(async () => succeeded(sparse)),
      listEvidence: vi.fn(async () => succeeded([])),
      listContributions: vi.fn(async () => succeeded([])),
      getLifecycle: vi.fn(async () => succeeded(makeLifecycle(sparse))),
    });
    const onOpenAdvancedTools = vi.fn();
    renderStrategy({ gateway, shell: { focusCaseId: sparse.id, onOpenAdvancedTools } });
    const heading = await screen.findByRole("heading", { name: "Imported investigation" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(5);
    fireEvent.click(screen.getByRole("button", { name: "Open War Room technical tools" }));
    expect(onOpenAdvancedTools).toHaveBeenCalledWith(sparse.id, "analyze");
  });

  it("keeps evidence visible when annotations fail independently", async () => {
    const gateway = makeGateway({ listContributions: vi.fn(async () => unavailable<readonly ContributionV1[]>()) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByText("checkout-timeout.log")).toBeTruthy();
    expect(screen.getAllByText("Annotation not available").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain("Evidence annotations could not be loaded");
    expect(screen.getByRole("button", { name: "Retry evidence annotations" })).toBeTruthy();
  });

  it("describes annotations as loading until their independent lane settles", async () => {
    const contributions = createDeferred<GatewayResult<readonly ContributionV1[]>>();
    const gateway = makeGateway({ listContributions: vi.fn(() => contributions.promise) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByText("checkout-timeout.log")).toBeTruthy();
    expect(screen.getByText("Loading evidence annotations…")).toBeTruthy();
    expect(screen.getAllByText("Annotation loading…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Annotation not available")).toBeNull();

    contributions.resolve(succeeded([]));
    await waitFor(() => expect(screen.queryByText("Loading evidence annotations…")).toBeNull());
    expect(screen.getAllByText("Annotation not available").length).toBeGreaterThan(0);
  });

  it("never describes a failed evidence inventory as empty", async () => {
    const gateway = makeGateway({ listEvidence: vi.fn(async () => unavailable<readonly ArtifactV1[]>()) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Evidence inventory could not be loaded");
    expect(screen.getByText("Count unavailable")).toBeTruthy();
    expect(screen.queryByText("0 items")).toBeNull();
    expect(screen.queryByText("No evidence has been registered yet.")).toBeNull();
  });

  it("submits one file intent and leaves encoding and limits to the runtime controller", async () => {
    const upload = makeEvidenceUploadSuccess();
    const gateway = makeGateway({ uploadEvidence: vi.fn(async () => succeeded(upload)) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), { target: { value: "Operator notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase, expect.objectContaining({ filename: "notes.txt", mediaType: "text/plain", summary: "Operator notes", kind: "attachment", privacyClass: "owner_only", contentBase64: "aGVsbG8=" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("suppresses every mutation affordance for viewers and static read-only builds", async () => {
    renderStrategy({ capabilities: ["investigation:read"], shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    expect(screen.queryByRole("heading", { name: "Add evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    cleanup();
    const archived = { ...makePopulatedCase(), status: "archived" as const };
    renderStrategy({
      readOnly: true,
      gateway: makeGateway({ getInvestigation: vi.fn(async () => succeeded(archived)), getLifecycle: vi.fn(async () => succeeded(makeLifecycle(archived))) }),
      shell: { focusCaseId: archived.id },
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    expect(screen.queryByRole("heading", { name: "Add evidence" })).toBeNull();
    expect(screen.getByText("Archiving and restoring are unavailable in this view.")).toBeTruthy();
  });

  it("shows loading, distinguishes not-found, and retries the focused read", async () => {
    const first = createDeferred<GatewayResult<CaseV1>>();
    let attempts = 0;
    const gateway = makeGateway({
      getInvestigation: vi.fn(() => {
        attempts += 1;
        return attempts === 1 ? first.promise : Promise.resolve(succeeded(makePopulatedCase()));
      }),
    });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByText("Opening investigation…")).toBeTruthy();
    first.resolve({ ok: false, error: { kind: "not_found", status: 404 } });
    expect(await screen.findByText("This investigation could not be found.")).toBeTruthy();
    const unavailableHeading = screen.getByRole("heading", { name: "Investigation unavailable" });
    await waitFor(() => expect(document.activeElement).toBe(unavailableHeading));
    fireEvent.click(screen.getByRole("button", { name: "Retry opening investigation" }));
    expect(await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" })).toBeTruthy();
    expect(gateway.getInvestigation).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed browse load distinct from an empty result and retries it", async () => {
    let attempts = 0;
    const gateway = makeGateway({
      listInvestigations: vi.fn(async () => {
        attempts += 1;
        return attempts === 1 ? unavailable<readonly CaseV1[]>() : succeeded([]);
      }),
    });
    renderStrategy({ gateway });
    expect((await screen.findByRole("alert")).textContent).toContain("Investigations could not be loaded");
    expect(screen.getByText("Count unavailable")).toBeTruthy();
    expect(screen.queryByText("0 shown · 0 total")).toBeNull();
    expect(screen.queryByText(/No investigations match this view/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading investigations" }));
    expect(await screen.findByText("No investigations match this view. Try a different search or create a new one.")).toBeTruthy();
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
  });

  it("keeps selection case-scoped and associates the disabled trash explanation", async () => {
    const { rerender } = renderStrategy({ shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByText("checkout-timeout.log");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    const trash = screen.getByRole("button", { name: "Move selected to trash" });
    expect((trash as HTMLButtonElement).disabled).toBe(true);
    expect(trash.getAttribute("aria-describedby")).toBe("investigation-first-trash-description");
    rerender({ focusCaseId: null });
    const browseHeading = await screen.findByRole("heading", { name: "Investigations" });
    expect(document.activeElement).toBe(browseHeading);
    rerender({ focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase });
    await screen.findByText("checkout-timeout.log");
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("requires two clicks and sends only lifecycle action intent", async () => {
    const current = makePopulatedCase();
    const archived = { ...current, status: "archived" as const };
    const success: InvestigationLifecycleActionSuccessV1 = {
        schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
        investigationId: current.id,
        action: "archive",
        previousStatus: current.status,
        appliedStatus: "archived",
        case: archived,
    };
    const lifecycleRefresh = createDeferred<GatewayResult<InvestigationLifecycleV1>>();
    let lifecycleReads = 0;
    const gateway = makeGateway({
      getLifecycle: vi.fn(() => {
        lifecycleReads += 1;
        return lifecycleReads === 1
          ? Promise.resolve(succeeded(makeLifecycle(current)))
          : lifecycleRefresh.promise;
      }),
      applyLifecycleAction: vi.fn(async () => succeeded(success)),
    });
    renderStrategy({ gateway, shell: { focusCaseId: current.id } });
    await screen.findByRole("button", { name: "Archive investigation" });
    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive investigation" }));
    await waitFor(() => expect(gateway.applyLifecycleAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Refreshing lifecycle options…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
    await act(async () => {
      lifecycleRefresh.resolve(unavailable<InvestigationLifecycleV1>());
    });
    expect(await screen.findByRole("button", { name: "Retry lifecycle information" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Lifecycle information could not be loaded");
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
    const input = vi.mocked(gateway.applyLifecycleAction).mock.calls[0]?.[1];
    expect(input).toEqual({ action: "archive", expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" } });
    expect(input).not.toHaveProperty("targetStatus");
  });
});
