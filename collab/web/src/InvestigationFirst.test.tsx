import {
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  type ArtifactV1,
  type CaseV1,
  type ContributionV1,
  type InvestigationLifecycleActionSuccessV1,
  type InvestigationLifecycleV1,
} from "@cd-collab/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationFirst } from "./InvestigationFirst.js";
import {
  InvestigationRuntimeProvider,
  type InvestigationRuntimeIdentity,
} from "./investigations/runtime/public.js";
import {
  createDeferred,
  createInvestigationGatewayDouble,
  gatewayOk,
  gatewayUnavailable,
  InvestigationRuntimeGatewayHarness,
  makeArchiveAllowedLifecycle,
  makeCaseList,
  makeEvidenceUploadSuccess,
  makeEvidenceList,
  makePopulatedCase,
  makeRestoreAllowedLifecycle,
  makeSparseImportedCase,
  RUNTIME_FIXTURE_IDS,
  VIEWER_CAPABILITY_FIXTURE,
  type GatewayResult,
  type InvestigationGateway,
} from "./investigations/runtime/testkit/index.js";
import type { InvestigationStrategyShellProps } from "./investigations/strategies/contract.js";

const FULL_CAPABILITIES = [
  "investigation:read",
  "investigation:write",
  "run:strategies",
  "evidence:private:read",
] as const;
const CONTRIBUTOR_CAPABILITIES = [
  "investigation:read",
  "investigation:write",
] as const;

function makeLifecycle(investigation: CaseV1): InvestigationLifecycleV1 {
  const template = investigation.status === "archived" ? makeRestoreAllowedLifecycle() : makeArchiveAllowedLifecycle();
  return { ...template, investigationId: investigation.id, status: investigation.status };
}

const shellDefaults: InvestigationStrategyShellProps = {
  view: "investigations",
  focusCaseId: null,
  stage: "situation",
  onOpenCase: vi.fn(),
  onNavigateInvestigation: vi.fn(),
  onExitFocus: vi.fn(),
};

function renderStrategy(options: {
  gateway?: InvestigationGateway;
  capabilities?: readonly string[];
  readOnly?: boolean;
  identity?: InvestigationRuntimeIdentity;
  identityKey?: string;
  authorityKey?: string;
  shell?: Partial<InvestigationStrategyShellProps>;
} = {}) {
  const gateway = options.gateway ?? createInvestigationGatewayDouble();
  const shell = { ...shellDefaults, ...options.shell };
  let runtimeProps = {
    identityKey: options.identityKey ?? "alice",
    identity: options.identity ?? { id: "alice", username: "alice", displayName: "Alice Nguyen" },
    authorityKey: options.authorityKey ?? "alice-authority-v1",
    capabilities: options.capabilities ?? FULL_CAPABILITIES,
    readOnly: options.readOnly ?? false,
  };
  // Runtime V1 hands strategies no transport seam, so the testkit harness
  // supplies the double from outside the public provider contract.
  const mount = (nextShell: InvestigationStrategyShellProps) => (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey={runtimeProps.identityKey}
        identity={runtimeProps.identity}
        authorityKey={runtimeProps.authorityKey}
        capabilities={runtimeProps.capabilities}
        readOnly={runtimeProps.readOnly}
        active
        focusCaseId={nextShell.focusCaseId}
        isInvestigationLocation
        onOpenCreated={nextShell.onOpenCase}
      >
        <InvestigationFirst {...nextShell} />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>
  );
  const view = render(mount(shell));
  return {
    gateway,
    rerender(
      shellOverrides: Partial<InvestigationStrategyShellProps>,
      runtimeOverrides: Partial<typeof runtimeProps> = {},
    ) {
      runtimeProps = { ...runtimeProps, ...runtimeOverrides };
      view.rerender(mount({ ...shell, ...shellOverrides }));
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
    expect(screen.getByText("Matches a recorded value after removing outer whitespace; that value will be reused.")).toBeTruthy();
    fireEvent.change(product, { target: { value: "contextdesk storefront" } });
    expect(screen.getByText("No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.")).toBeTruthy();
    fireEvent.change(product, { target: { value: "  ContextDesk Storefront  " } });
    expect(screen.getByText("Matches a recorded value after removing outer whitespace; that value will be reused.")).toBeTruthy();
    fireEvent.change(product, { target: { value: "A new product" } });
    expect(screen.getByText("No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter investigations by status"), { target: { value: "monitoring" } });
    expect(screen.getByRole("button", { name: /Checkout latency/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Imported investigation/ })).toBeNull();
  });

  it("creates exactly once and lets the provider open the server-confirmed identity", async () => {
    const created = { ...makeSparseImportedCase(), id: "case-server-id", title: "New investigation" };
    const gateway = createInvestigationGatewayDouble({ createInvestigation: vi.fn(async () => gatewayOk(created)) });
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

  it("keeps a title-only investigation valid and leaves optional values unrecorded", async () => {
    const created = { ...makeSparseImportedCase(), id: "case-title-only", title: "Title-only investigation" };
    const gateway = createInvestigationGatewayDouble({ createInvestigation: vi.fn(async () => gatewayOk(created)) });
    const onOpenCase = vi.fn();
    renderStrategy({ gateway, shell: { onOpenCase } });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "Title-only investigation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith("case-title-only"));
    expect(gateway.createInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Title-only investigation",
        problemStatement: "",
        affectedParties: "",
        impact: "",
        scope: "",
        openQuestions: [],
        investigationContext: null,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(vi.mocked(gateway.createInvestigation).mock.calls[0]?.[0]).not.toHaveProperty("occurredAt");
  });

  it("normalizes padded recorded and new context values before comparison and submission", async () => {
    const created = { ...makeSparseImportedCase(), id: "case-trimmed-context", title: "Trimmed context" };
    const recorded = makePopulatedCase();
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: vi.fn(async () => gatewayOk([{
        ...recorded,
        investigationContext: {
          ...recorded.investigationContext!,
          productName: "  ContextDesk Storefront  ",
        },
      }])),
      createInvestigation: vi.fn(async () => gatewayOk(created)),
    });
    const onOpenCase = vi.fn();
    renderStrategy({ gateway, shell: { onOpenCase } });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "Trimmed context" } });
    fireEvent.click(screen.getByText("Advanced context"));
    fireEvent.change(screen.getByRole("combobox", { name: "Product or software" }), { target: { value: "  ContextDesk Storefront  " } });
    expect(comboHint("Product or software")).toBe("Matches a recorded value after removing outer whitespace; that value will be reused.");
    fireEvent.change(screen.getByRole("combobox", { name: "Build" }), { target: { value: "  never-recorded-build  " } });
    expect(comboHint("Build")).toBe("No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.");
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith("case-trimmed-context"));
    expect(gateway.createInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        investigationContext: expect.objectContaining({
          productName: "ContextDesk Storefront",
          build: "never-recorded-build",
        }),
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(vi.mocked(gateway.createInvestigation).mock.calls[0]?.[0].investigationContext?.productName).not.toMatch(/^\s|\s$/u);
    expect(vi.mocked(gateway.createInvestigation).mock.calls[0]?.[0].investigationContext?.build).not.toMatch(/^\s|\s$/u);
  });

  it("passes occurred-at through for server validation and explains accepted examples", async () => {
    const gateway = createInvestigationGatewayDouble({
      createInvestigation: vi.fn(async () => ({ ok: false as const, error: { kind: "validation" as const, status: 400 as const } })),
    });
    renderStrategy({ gateway });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "Timing needs review" } });
    fireEvent.click(screen.getByText("Advanced context"));
    const occurredAt = screen.getByLabelText(/When did it happen/u);
    const hint = document.getElementById(occurredAt.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toContain("YYYY-MM-DD");
    expect(hint?.textContent).toContain("ISO 8601 date-time with an offset");
    expect(hint?.textContent).toContain("The server validates this value");
    fireEvent.change(occurredAt, { target: { value: "last Thursday" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The submitted values were not accepted, so the investigation was not created. Review the entries and try again.");
    expect(alert.textContent).not.toMatch(/occurred|date|time/iu);
    expect(gateway.createInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: "last Thursday" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    [
      { kind: "conflict" as const, status: 409 as const },
      "The create request conflicted with current server state. Check the investigation list before trying again.",
    ],
    [
      { kind: "not_found" as const, status: 404 as const },
      "The create request could not find the required server resource. Check the investigation list before trying again.",
    ],
    [
      { kind: "network" as const },
      "The connection failed before ContextDesk could confirm the result. Check the investigation list before trying again.",
    ],
    [
      { kind: "auth_lost" as const, status: 403 as const },
      "Your access changed before the investigation could be created. Sign in again to continue.",
    ],
    [
      { kind: "unavailable" as const, status: 503 as const },
      "The service could not complete the create request right now. Check the investigation list before trying again.",
    ],
    [
      { kind: "server_failure" as const, status: 500 },
      "The service could not complete the create request right now. Check the investigation list before trying again.",
    ],
    [
      { kind: "aborted" as const },
      "The create request was canceled before it finished. Check the investigation list before trying again.",
    ],
    [
      { kind: "unexpected_response" as const, status: 418 },
      "The server response could not be verified. Check the investigation list before trying again.",
    ],
    [
      { kind: "protocol" as const, reason: "contract" as const },
      "The server response could not be verified. Check the investigation list before trying again.",
    ],
    [
      { kind: "unexpected" as const },
      "ContextDesk could not confirm the create result safely. Check the investigation list before trying again.",
    ],
  ])("uses truthful create-specific copy for %s failures", async (error, expected) => {
    const gateway = createInvestigationGatewayDouble({
      createInvestigation: vi.fn(async () => ({ ok: false as const, error })),
    });
    renderStrategy({ gateway });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "Create failure proof" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect((await screen.findByRole("alert")).textContent).toBe(expected);
    expect(screen.queryByText(/could not be loaded right now/iu)).toBeNull();
  });

  it("explains a whitespace-only title without issuing a create request", async () => {
    const gateway = createInvestigationGatewayDouble();
    renderStrategy({ gateway });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Add a title before creating the investigation.",
    );
    expect(gateway.createInvestigation).not.toHaveBeenCalled();
  });

  it("keeps a draft across ordinary rerenders but clears it when the authenticated person changes", async () => {
    const { rerender } = renderStrategy();
    await screen.findByRole("heading", { name: "Create an investigation" });
    const title = screen.getByPlaceholderText("Short investigation title");
    fireEvent.change(title, { target: { value: "Alice private draft" } });
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "critical" } });
    fireEvent.change(screen.getByPlaceholderText("Describe the problem without assuming its cause."), { target: { value: "Alice observation" } });
    fireEvent.click(screen.getByText("Advanced context"));
    fireEvent.change(screen.getByRole("combobox", { name: "Product or software" }), { target: { value: "Alice product" } });

    rerender({ stage: "analyze" }, {
      identity: { id: "alice", username: "alice", displayName: "Alice N." },
    });
    expect((screen.getByPlaceholderText("Short investigation title") as HTMLInputElement).value).toBe("Alice private draft");
    expect((screen.getByLabelText("Severity") as HTMLSelectElement).value).toBe("critical");
    expect(document.querySelector(".investigation-first__advanced")?.hasAttribute("open")).toBe(true);

    rerender({}, {
      identityKey: "bob",
      authorityKey: "bob-authority-v1",
      identity: { id: "bob", username: "bob", displayName: "Bob Alvarez" },
    });
    expect((screen.getByPlaceholderText("Short investigation title") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Severity") as HTMLSelectElement).value).toBe("medium");
    expect((screen.getByPlaceholderText("Describe the problem without assuming its cause.") as HTMLTextAreaElement).value).toBe("");
    expect(document.querySelector(".investigation-first__advanced")?.hasAttribute("open")).toBe(false);
    fireEvent.click(screen.getByText("Advanced context"));
    expect((screen.getByRole("combobox", { name: "Product or software" }) as HTMLInputElement).value).toBe("");
  });

  it("scrolls startSignal into view smoothly unless reduced motion is requested", async () => {
    const originalScroll = HTMLElement.prototype.scrollIntoView;
    const originalMatchMedia = window.matchMedia;
    const scrollIntoView = vi.fn();
    let reduceMotion = false;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reduceMotion,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const { rerender } = renderStrategy();
      await screen.findByRole("heading", { name: "Create an investigation" });
      rerender({ startSignal: 1 });
      expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });
      expect(document.activeElement).toBe(screen.getByPlaceholderText("Short investigation title"));

      reduceMotion = true;
      rerender({ startSignal: 2 });
      expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "auto", block: "center", inline: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScroll;
      window.matchMedia = originalMatchMedia;
    }
  });

  it("renders a sparse imported detail and preserves the explicit technical handoff", async () => {
    const sparse = makeSparseImportedCase();
    const gateway = createInvestigationGatewayDouble({
      getInvestigation: vi.fn(async () => gatewayOk(sparse)),
      listEvidence: vi.fn(async () => gatewayOk([])),
      listContributions: vi.fn(async () => gatewayOk([])),
      getLifecycle: vi.fn(async () => gatewayOk(makeLifecycle(sparse))),
    });
    const onOpenAdvancedTools = vi.fn();
    renderStrategy({ gateway, shell: { focusCaseId: sparse.id, onOpenAdvancedTools } });
    const heading = await screen.findByRole("heading", { name: "Imported investigation" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(5);
    fireEvent.click(screen.getByRole("button", { name: "Open War Room technical tools" }));
    expect(onOpenAdvancedTools).toHaveBeenCalledWith(sparse.id, "analyze");
  });

  it("uses the visible sparse-title fallback for focused shell chrome", async () => {
    const sparse = { ...makeSparseImportedCase(), title: "" };
    const onFocusedCaseTitle = vi.fn();
    const gateway = createInvestigationGatewayDouble({
      getInvestigation: vi.fn(async () => gatewayOk(sparse)),
      listEvidence: vi.fn(async () => gatewayOk([])),
      listContributions: vi.fn(async () => gatewayOk([])),
      getLifecycle: vi.fn(async () => gatewayOk(makeLifecycle(sparse))),
    });
    renderStrategy({ gateway, shell: { focusCaseId: sparse.id, onFocusedCaseTitle } });
    const heading = await screen.findByRole("heading", { name: "Untitled investigation" });
    await waitFor(() => expect(onFocusedCaseTitle).toHaveBeenLastCalledWith("Untitled investigation"));
    expect(document.activeElement).toBe(heading);
  });

  it("keeps evidence visible when annotations fail independently", async () => {
    const gateway = createInvestigationGatewayDouble({ listContributions: vi.fn(async () => gatewayUnavailable<readonly ContributionV1[]>()) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByText("checkout-timeout.log")).toBeTruthy();
    expect(screen.getAllByText("Annotation not available").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toContain("Evidence annotations could not be loaded");
    expect(screen.getByRole("button", { name: "Retry evidence annotations" })).toBeTruthy();
  });

  it("keeps each evidence row compact while making the full metadata available on demand", async () => {
    const evidence = makeEvidenceList().artifacts.map((artifact) => ({
      ...artifact,
      expectedHash: "sha256:expected-checksum",
    }));
    const gateway = createInvestigationGatewayDouble({
      listEvidence: vi.fn(async () => gatewayOk(evidence)),
    });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    const filename = await screen.findByText("checkout-timeout.log");
    const row = filename.closest("li");
    expect(row).toBeTruthy();
    const summary = row?.querySelector<HTMLElement>(".investigation-first__evidence-facts");
    expect(summary?.textContent).toContain("log");
    expect(summary?.textContent).toContain("text/plain");
    expect(summary?.textContent).toContain("1.8 KB");
    expect(summary?.textContent).toContain("verified");
    expect(screen.getByRole("checkbox", {
      name: /checkout-timeout\.log log text\/plain 1\.8 KB verified/u,
    })).toBeTruthy();
    const details = row?.querySelector("details");
    expect(details?.open).toBe(false);
    const disclosure = row?.querySelector("summary");
    expect(disclosure?.textContent).toBe("More details about checkout-timeout.log");
    fireEvent.click(disclosure!);
    expect(details?.open).toBe(true);
    expect(row?.textContent).toContain("Gateway timeout excerpt captured during the affected interval.");
    expect(row?.textContent).toContain("Annotation author");
    expect(row?.textContent).toContain("Intake batch");
    expect(row?.textContent).toContain("Content hash");
    expect(row?.textContent).toContain("Expected hash");
    expect(row?.textContent).toContain("sha256:24b005aa8796e5655d4c9cc728fdbcd24542d1ee4eab264b8308efcd350a23d1");
    expect(row?.textContent).toContain("sha256:expected-checksum");
  });

  it("previews text evidence through the runtime and keeps the row metadata visible", async () => {
    const artifactId = RUNTIME_FIXTURE_IDS.evidence;
    const gateway = createInvestigationGatewayDouble({
      previewEvidence: vi.fn(async () => gatewayOk({
        artifactId,
        text: "2026-09-01T12:00:00Z timeout observed",
        truncated: true,
        etag: '"fixture-preview"',
      })),
    });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    const row = (await screen.findByText("checkout-timeout.log")).closest("li");
    expect(row).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = await screen.findByRole("region", { name: "Preview of checkout-timeout.log" });
    expect(preview.textContent).toContain("timeout observed");
    expect(screen.getByText("Showing the first 64 KiB. Use War Room technical tools for the complete file.")).toBeTruthy();
    expect(gateway.previewEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      artifactId,
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(screen.queryByRole("region", { name: "Preview of checkout-timeout.log" })).toBeNull();
  });

  it("does not offer a bytes preview for private evidence without private-read authority", async () => {
    const previewEvidence = vi.fn(async () => gatewayOk({
      artifactId: RUNTIME_FIXTURE_IDS.evidence,
      text: "must not be requested",
      truncated: false,
      etag: null,
    }));
    const gateway = createInvestigationGatewayDouble({ previewEvidence });
    renderStrategy({
      gateway,
      capabilities: CONTRIBUTOR_CAPABILITIES,
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    const row = (await screen.findByText("checkout-timeout.log")).closest("li");
    expect(row).toBeTruthy();
    expect(within(row!).queryByRole("button", { name: "Preview" })).toBeNull();
    expect(within(row!).queryByText("Metadata only")).toBeNull();
    expect(previewEvidence).not.toHaveBeenCalled();
  });

  it("describes annotations as loading until their independent lane settles", async () => {
    const contributions = createDeferred<GatewayResult<readonly ContributionV1[]>>();
    const gateway = createInvestigationGatewayDouble({ listContributions: vi.fn(() => contributions.promise) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByText("checkout-timeout.log")).toBeTruthy();
    expect(screen.getByText("Loading evidence annotations…")).toBeTruthy();
    expect(screen.getAllByText("Annotation loading…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Annotation not available")).toBeNull();

    contributions.resolve(gatewayOk([]));
    await waitFor(() => expect(screen.queryByText("Loading evidence annotations…")).toBeNull());
    expect(screen.getAllByText("Annotation not available").length).toBeGreaterThan(0);
  });

  it("never describes a failed evidence inventory as empty", async () => {
    const gateway = createInvestigationGatewayDouble({ listEvidence: vi.fn(async () => gatewayUnavailable<readonly ArtifactV1[]>()) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    expect(await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Evidence inventory could not be loaded");
    expect(screen.getByText("Count unavailable")).toBeTruthy();
    expect(screen.queryByText("0 items")).toBeNull();
    expect(screen.queryByText("No evidence has been registered yet.")).toBeNull();
  });

  it("submits one file intent and leaves encoding and limits to the runtime controller", async () => {
    const upload = makeEvidenceUploadSuccess();
    const gateway = createInvestigationGatewayDouble({ uploadEvidence: vi.fn(async () => gatewayOk(upload)) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), { target: { value: "Operator notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase, expect.objectContaining({ filename: "notes.txt", mediaType: "text/plain", summary: "Operator notes", kind: "attachment", privacyClass: "owner_only", contentBase64: "aGVsbG8=" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("omits file_server_ref from the bytes-only form and still submits a valid kind", async () => {
    const upload = makeEvidenceUploadSuccess();
    const gateway = createInvestigationGatewayDouble({ uploadEvidence: vi.fn(async () => gatewayOk(upload)) });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const kindSelect = screen.getByLabelText("Kind") as HTMLSelectElement;
    expect([...kindSelect.options].map((option) => option.value)).toEqual([
      "attachment",
      "log",
      "email",
    ]);
    expect(kindSelect.querySelector('option[value="file_server_ref"]')).toBeNull();
    fireEvent.change(kindSelect, { target: { value: "log" } });
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), {
      target: { value: "Operator notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({ kind: "log", privacyClass: "owner_only" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("defaults a privileged session to owner_only and keeps contributors on share_safe", async () => {
    const upload = makeEvidenceUploadSuccess();
    const gateway = createInvestigationGatewayDouble({
      uploadEvidence: vi.fn(async () => gatewayOk(upload)),
    });
    renderStrategy({
      gateway,
      capabilities: CONTRIBUTOR_CAPABILITIES,
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const privacy = screen.getByLabelText("Privacy") as HTMLSelectElement;
    expect(privacy.value).toBe("share_safe");
    expect([...privacy.options].map((option) => option.value)).toEqual(["share_safe"]);
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), {
      target: { value: "Operator notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({ privacyClass: "share_safe" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    cleanup();

    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const privileged = screen.getByLabelText("Privacy") as HTMLSelectElement;
    expect(privileged.value).toBe("owner_only");
    expect([...privileged.options].map((option) => option.value)).toEqual([
      "owner_only",
      "share_safe",
    ]);
  });

  it("clamps owner_only to share_safe before submit when private-read is revoked", async () => {
    const upload = makeEvidenceUploadSuccess();
    const gateway = createInvestigationGatewayDouble({
      uploadEvidence: vi.fn(async () => gatewayOk(upload)),
    });
    const view = renderStrategy({
      gateway,
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase },
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const privacy = screen.getByLabelText("Privacy") as HTMLSelectElement;
    expect(privacy.value).toBe("owner_only");
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), {
      target: { value: "Operator notes" },
    });

    view.rerender({}, {
      capabilities: CONTRIBUTOR_CAPABILITIES,
      authorityKey: "alice-authority-no-private",
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const clamped = screen.getByLabelText("Privacy") as HTMLSelectElement;
    expect(clamped.value).toBe("share_safe");
    expect([...clamped.options].map((option) => option.value)).toEqual(["share_safe"]);
    fireEvent.change(clamped, { target: { value: "owner_only" } });
    expect(clamped.value).toBe("share_safe");
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), {
      target: { value: "Operator notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    await waitFor(() => expect(gateway.uploadEvidence).toHaveBeenCalledTimes(1));
    expect(gateway.uploadEvidence).toHaveBeenCalledWith(
      RUNTIME_FIXTURE_IDS.populatedCase,
      expect.objectContaining({ privacyClass: "share_safe" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("states that an unknown upload outcome was not confirmed and does not invite a blind retry", async () => {
    const gateway = createInvestigationGatewayDouble({
      uploadEvidence: vi.fn(async () => ({
        ok: false as const,
        error: { kind: "unavailable" as const, status: 503 as const, reason: "commit_outcome_unknown" as const },
      })),
    });
    renderStrategy({ gateway, shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase } });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });
    fireEvent.change(screen.getByPlaceholderText("What is this file and why does it matter?"), {
      target: { value: "Operator notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to evidence inventory" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not confirmed/i);
    expect(alert.textContent).toMatch(/being refreshed/i);
    expect(alert.textContent).toMatch(/check it before uploading again/i);
    expect(alert.textContent).not.toMatch(/try again/i);
    await waitFor(() => expect(gateway.listEvidence).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(vi.mocked(gateway.listInvestigations).mock.calls.length).toBeGreaterThan(1));
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
      gateway: createInvestigationGatewayDouble({ getInvestigation: vi.fn(async () => gatewayOk(archived)), getLifecycle: vi.fn(async () => gatewayOk(makeLifecycle(archived))) }),
      shell: { focusCaseId: archived.id },
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    expect(screen.queryByRole("heading", { name: "Add evidence" })).toBeNull();
    expect(screen.getByText("Archiving and restoring are unavailable in this view.")).toBeTruthy();
  });

  it("offers a viewer browsing the list no create heading and no submit control", async () => {
    renderStrategy({
      capabilities: VIEWER_CAPABILITY_FIXTURE.capabilities,
      readOnly: VIEWER_CAPABILITY_FIXTURE.staticReadOnly,
      shell: { focusCaseId: null },
    });
    await screen.findByRole("button", { name: /Checkout latency/ });
    expect(screen.queryByRole("heading", { name: "Create an investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create investigation" })).toBeNull();
    expect(screen.queryByPlaceholderText("Short investigation title")).toBeNull();
    expect(document.querySelectorAll("button[type=\"submit\"]")).toHaveLength(0);
    expect(document.querySelectorAll("form")).toHaveLength(0);
  });

  it("shows loading, distinguishes not-found, and retries the focused read", async () => {
    const first = createDeferred<GatewayResult<CaseV1>>();
    let attempts = 0;
    const gateway = createInvestigationGatewayDouble({
      getInvestigation: vi.fn(() => {
        attempts += 1;
        return attempts === 1 ? first.promise : Promise.resolve(gatewayOk(makePopulatedCase()));
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
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: vi.fn(async () => {
        attempts += 1;
        return attempts === 1 ? gatewayUnavailable<readonly CaseV1[]>() : gatewayOk([]);
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

  it("calls the list unavailable rather than loading when read authority is absent", async () => {
    const gateway = createInvestigationGatewayDouble();
    renderStrategy({ gateway, capabilities: ["investigation:write", "run:strategies"] });
    const notice = await screen.findByText(/does not include reading investigations/);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("No investigation data was requested.");
    expect(screen.queryByText("Loading investigations…")).toBeNull();
    expect(screen.queryByText("Counting investigations…")).toBeNull();
    expect(screen.getByText("Count unavailable")).toBeTruthy();
    const browse = screen.getByRole("heading", { name: "Investigations" }).closest("section");
    expect(browse?.getAttribute("aria-busy")).toBe("false");
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
  });

  it("refuses the focused record without a request when read authority is absent", async () => {
    const gateway = createInvestigationGatewayDouble();
    const onExitFocus = vi.fn();
    const { rerender } = renderStrategy({
      gateway,
      capabilities: ["investigation:write", "run:strategies"],
      shell: { focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase, onExitFocus },
    });

    const heading = await screen.findByRole("heading", { name: "Investigation unavailable in this view" });
    // Nothing was asked for, so nothing can be arriving.
    expect(screen.queryByText("Opening investigation…")).toBeNull();
    expect(heading.closest("section")?.getAttribute("aria-busy")).toBe("false");
    const notice = screen.getByText(/does not include reading investigations/);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("No investigation data was requested.");
    expect(screen.queryByRole("button", { name: "Retry opening investigation" })).toBeNull();
    expect(gateway.getInvestigation).not.toHaveBeenCalled();
    expect(gateway.listEvidence).not.toHaveBeenCalled();
    expect(gateway.listContributions).not.toHaveBeenCalled();
    expect(gateway.getLifecycle).not.toHaveBeenCalled();

    // A terminal arrival still lands the reader on the heading exactly once.
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const back = screen.getByRole("button", { name: "Back to investigations" });
    (back as HTMLButtonElement).focus();
    rerender({ focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase });
    expect(document.activeElement).toBe(back);

    fireEvent.click(back);
    expect(onExitFocus).toHaveBeenCalledTimes(1);
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
    const gateway = createInvestigationGatewayDouble({
      getLifecycle: vi.fn(() => {
        lifecycleReads += 1;
        return lifecycleReads === 1
          ? Promise.resolve(gatewayOk(makeLifecycle(current)))
          : lifecycleRefresh.promise;
      }),
      applyLifecycleAction: vi.fn(async () => gatewayOk(success)),
    });
    renderStrategy({ gateway, shell: { focusCaseId: current.id } });
    await screen.findByRole("button", { name: "Archive investigation" });
    fireEvent.click(screen.getByRole("button", { name: "Archive investigation" }));
    expect(gateway.applyLifecycleAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm archive investigation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive investigation" }));
    await waitFor(() => expect(gateway.applyLifecycleAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Refreshing lifecycle options…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
    await act(async () => {
      lifecycleRefresh.resolve(gatewayUnavailable<InvestigationLifecycleV1>());
    });
    expect(await screen.findByRole("button", { name: "Retry lifecycle information" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Lifecycle information could not be loaded");
    expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
    const input = vi.mocked(gateway.applyLifecycleAction).mock.calls[0]?.[1];
    expect(input).toEqual({ action: "archive", expected: { status: "monitoring", legalHold: false, restoreTarget: "monitoring" } });
    expect(input).not.toHaveProperty("targetStatus");
  });

  function comboHint(name: string): string {
    const field = screen.getByRole("combobox", { name });
    return document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
  }

  it("leaves the context fields on combobox semantics the browser can actually honor", async () => {
    renderStrategy();
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.click(screen.getByText("Advanced context"));
    const product = screen.getByRole("combobox", { name: "Product or software" });

    // The datalist popup is the browser's to own, so the markup must not claim
    // an expanded state, owned options, or an active option it cannot report.
    expect(product.tagName).toBe("INPUT");
    expect(product.getAttribute("list")).toBe("investigation-first-productName-options");
    for (const attribute of ["role", "aria-expanded", "aria-controls", "aria-autocomplete", "aria-activedescendant", "aria-owns"]) {
      expect(product.getAttribute(attribute)).toBeNull();
    }
    const options = document.getElementById("investigation-first-productName-options");
    expect(options?.tagName).toBe("DATALIST");
    expect([...options!.querySelectorAll("option")].map((option) => option.getAttribute("value"))).toContain("ContextDesk Storefront");
    const hint = document.getElementById(product.getAttribute("aria-describedby") ?? "");
    expect(hint?.getAttribute("aria-live")).toBe("polite");

    // Keyboard: an ordinary focusable text input with nothing intercepting the
    // keys the native popup needs.
    (product as HTMLInputElement).focus();
    expect(document.activeElement).toBe(product);
    expect(product.getAttribute("tabindex")).toBeNull();
    expect((product as HTMLInputElement).disabled).toBe(false);
    fireEvent.keyDown(product, { key: "ArrowDown" });
    fireEvent.keyDown(product, { key: "Escape" });
    fireEvent.keyDown(product, { key: "Enter" });
    expect((product as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(product);
    expect(comboHint("Product or software")).toBe("Choose a recorded value or enter a new one. Outer whitespace will be removed when saved.");
    fireEvent.change(product, { target: { value: "ContextDesk Storefront" } });
    expect(comboHint("Product or software")).toBe("Matches a recorded value after removing outer whitespace; that value will be reused.");
  });

  it("stops calling a typed value new when the recorded values could not be read", async () => {
    let attempts = 0;
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: vi.fn(async () => {
        attempts += 1;
        return attempts === 1 ? gatewayUnavailable<readonly CaseV1[]>() : gatewayOk(makeCaseList().cases);
      }),
    });
    renderStrategy({ gateway });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.click(screen.getByText("Advanced context"));
    fireEvent.change(screen.getByRole("combobox", { name: "Product or software" }), { target: { value: "ContextDesk Storefront" } });

    expect(comboHint("Product or software")).toBe("Recorded values are unavailable, so this cannot be compared. Outer whitespace will be removed when it is saved.");
    expect(screen.queryByText(/saved as a new value/iu)).toBeNull();
    expect(screen.queryByText(/value will be reused/iu)).toBeNull();
    const retry = screen.getByRole("button", { name: "Retry recorded values" });
    expect(screen.getByText(/Recorded values could not be loaded/).textContent).toContain("Creating an investigation still works.");

    fireEvent.click(retry);
    await waitFor(() => expect(comboHint("Product or software")).toBe("Matches a recorded value after removing outer whitespace; that value will be reused."));
    expect(screen.queryByRole("button", { name: "Retry recorded values" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Product or software" }), { target: { value: "A product nobody recorded" } });
    expect(comboHint("Product or software")).toBe("No recorded value matches after removing outer whitespace. This will be saved as a new value without outer whitespace.");
    expect(gateway.listInvestigations).toHaveBeenCalledTimes(2);
  });

  it("keeps combo guidance truthful while the catalog loads and when it is empty", async () => {
    const pending = createDeferred<GatewayResult<readonly CaseV1[]>>();
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: vi.fn(() => pending.promise),
    });
    renderStrategy({ gateway });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.click(screen.getByText("Advanced context"));
    expect(comboHint("Product or software")).toBe("Recorded values are still loading, so this cannot be compared yet. Outer whitespace will be removed when it is saved.");
    fireEvent.change(screen.getByRole("combobox", { name: "Product or software" }), { target: { value: "ContextDesk Storefront" } });
    expect(comboHint("Product or software")).toBe("Recorded values are still loading, so this cannot be compared yet. Outer whitespace will be removed when it is saved.");

    pending.resolve(gatewayOk([]));
    await waitFor(() => expect(comboHint("Product or software")).toBe("No recorded values yet. This will be saved as a new value after removing outer whitespace."));
    fireEvent.change(screen.getByRole("combobox", { name: "Product or software" }), { target: { value: "" } });
    expect(comboHint("Product or software")).toBe("No recorded values yet; enter a new value. Outer whitespace will be removed when saved.");
  });

  it("still captures an investigation while the recorded values are unavailable", async () => {
    const created = { ...makeSparseImportedCase(), id: "case-created-blind", title: "Captured without the catalog" };
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: vi.fn(async () => gatewayUnavailable<readonly CaseV1[]>()),
      createInvestigation: vi.fn(async () => gatewayOk(created)),
    });
    const onOpenCase = vi.fn();
    renderStrategy({ gateway, shell: { onOpenCase } });
    await screen.findByRole("heading", { name: "Create an investigation" });
    fireEvent.click(screen.getByText("Advanced context"));
    fireEvent.change(screen.getByPlaceholderText("Short investigation title"), { target: { value: "Captured without the catalog" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Build" }), { target: { value: "2026.02.03.9" } });
    fireEvent.click(screen.getByRole("button", { name: "Create investigation" }));

    await waitFor(() => expect(onOpenCase).toHaveBeenCalledWith("case-created-blind"));
    expect(gateway.createInvestigation).toHaveBeenCalledTimes(1);
    expect(gateway.createInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Captured without the catalog", investigationContext: expect.objectContaining({ build: "2026.02.03.9" }) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps focus in the open record when its title changes under the reader", async () => {
    const current = makePopulatedCase();
    const renamed: CaseV1 = { ...current, status: "archived", title: "Checkout latency after 4.8.0 rollout (renamed)" };
    const success: InvestigationLifecycleActionSuccessV1 = {
      schemaId: INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
      investigationId: current.id,
      action: "archive",
      previousStatus: current.status,
      appliedStatus: "archived",
      case: renamed,
    };
    let caseReads = 0;
    const gateway = createInvestigationGatewayDouble({
      getInvestigation: vi.fn(async () => {
        caseReads += 1;
        return gatewayOk(caseReads === 1 ? current : renamed);
      }),
      getLifecycle: vi.fn(async () => gatewayOk(makeLifecycle(current))),
      applyLifecycleAction: vi.fn(async () => gatewayOk(success)),
    });
    const onFocusedCaseTitle = vi.fn();
    renderStrategy({ gateway, shell: { focusCaseId: current.id, onFocusedCaseTitle } });

    const heading = await screen.findByRole("heading", { name: current.title });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    const back = screen.getByRole("button", { name: /Back to investigations/ });
    (back as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(back);

    fireEvent.click(await screen.findByRole("button", { name: "Archive investigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm archive investigation" }));
    await screen.findByRole("heading", { name: renamed.title });

    // The record was renamed under the reader; focus stays where they put it.
    expect(document.activeElement).toBe(back);
    await waitFor(() => expect(onFocusedCaseTitle).toHaveBeenCalledWith(renamed.title));
  });

  it("never offers lifecycle loading or retry where lifecycle management is unavailable", async () => {
    const archived = { ...makePopulatedCase(), status: "archived" as const };
    const pending = createDeferred<GatewayResult<InvestigationLifecycleV1>>();
    const viewerGateway = createInvestigationGatewayDouble({
      getInvestigation: vi.fn(async () => gatewayOk(archived)),
      getLifecycle: vi.fn(() => pending.promise),
    });
    renderStrategy({
      gateway: viewerGateway,
      capabilities: VIEWER_CAPABILITY_FIXTURE.capabilities,
      shell: { focusCaseId: archived.id },
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    const expectTruthfulOnly = () => {
      expect(screen.getByText("Archiving and restoring are unavailable in this view.")).toBeTruthy();
      expect(screen.queryByText("Loading lifecycle options…")).toBeNull();
      expect(screen.queryByText("Refreshing lifecycle options…")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry lifecycle information" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Restore investigation" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Archive investigation" })).toBeNull();
    };
    expectTruthfulOnly();

    await act(async () => {
      pending.resolve(gatewayUnavailable<InvestigationLifecycleV1>());
    });
    expectTruthfulOnly();
    cleanup();

    renderStrategy({
      readOnly: true,
      gateway: createInvestigationGatewayDouble({
        getInvestigation: vi.fn(async () => gatewayOk(archived)),
        getLifecycle: vi.fn(async () => gatewayUnavailable<InvestigationLifecycleV1>()),
      }),
      shell: { focusCaseId: archived.id },
    });
    await screen.findByRole("heading", { name: "Checkout latency after 4.8.0 rollout" });
    await waitFor(() => expect(screen.getByText("Archiving and restoring are unavailable in this view.")).toBeTruthy());
    expectTruthfulOnly();
  });
});
