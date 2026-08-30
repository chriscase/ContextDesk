/**
 * Strategy-neutral conformance profile and component-surface runner.
 *
 * Runtime V1 lets the shell mount any presentation strategy. That freedom is
 * only safe if every strategy — the shipped ones and the switchable ones that
 * come later — is held to the same baseline. This module is that baseline.
 *
 * Three properties make it a conformance kit rather than a helper library:
 *
 * - **No strategy identity.** Nothing here reads a `UiStrategyId`, a
 *   registration, a CSS class, or a copy string owned by one strategy. A
 *   target supplies a component and accessible-name matchers for the generic
 *   affordances the profile needs; the runner then verifies those matchers
 *   resolve to real, keyboard-operable controls. `label` exists only for
 *   failure messages and is never branched on.
 * - **No waivers.** The profile is a frozen list, the component checks are a
 *   total `Record` over the component-surface ids, and the report is compared
 *   against the profile by the caller. A strategy cannot decline a state, and
 *   a requirement cannot be silently skipped.
 * - **Public boundary only.** Evidence comes from the Runtime V1 public
 *   surface (`runtime/public.js`), the versioned presentation contract
 *   callbacks, the sanctioned transport seam, and the accessible DOM. No
 *   controller, request slot, or other private implementation detail is read.
 *
 * Requirements that need a real layout, cascade, or media-query engine are
 * declared `browser` and are deliberately not evaluated here; jsdom would
 * answer them untruthfully. `collab/e2e/src/investigation-strategy/
 * conformance.ts` is their harness. The runner reports them as deferred so a
 * run always states what ran and what could not.
 *
 * Test-only. `collab/web/src/investigations/dependency-boundary.test.ts`
 * rejects any production import of this directory, so it never reaches a
 * shipped bundle.
 */
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { expect, vi, type Mock } from "vitest";
import {
  InvestigationRuntimeProvider,
  useInvestigationRuntime,
  type InvestigationRuntime,
} from "../../runtime/public.js";
import {
  InvestigationRuntimeGatewayHarness,
  RUNTIME_FIXTURE_IDS,
  createInvestigationGatewayDouble,
  gatewayOk,
  gatewayUnavailable,
  makePopulatedCase,
  makeSparseImportedCase,
  type InvestigationGateway,
} from "../../runtime/testkit/index.js";
import type { InvestigationStrategyComponent } from "../contract.js";

export const INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID =
  "cd-collab.investigation_strategy_conformance.v1" as const;

/** Where a requirement can be answered truthfully. */
export type ConformanceSurface = "component" | "browser";

export interface ConformanceRequirement {
  readonly id: string;
  readonly surfaces: readonly ConformanceSurface[];
  readonly claim: string;
  readonly failsWhen: string;
}

/**
 * The baseline every Runtime V1 presentation strategy owes its users.
 *
 * Order is meaningful: reports and the browser harness both render it, so a
 * reviewer reads the same sequence in both places.
 */
const REQUIREMENTS = [
  {
    id: "sparse-record",
    surfaces: ["component"],
    claim:
      "A record imported before the context contract renders as a valid record.",
    failsWhen:
      "A sparse record is presented as an error, or an absent optional value leaks as undefined, NaN, or [object Object].",
  },
  {
    id: "loading",
    surfaces: ["component"],
    claim:
      "An unsettled read is reported as in progress, not as an empty or failed result.",
    failsWhen:
      "A pending read raises an alert, or offers a retry for a request that has not finished.",
  },
  {
    id: "read-denied-zero-calls",
    surfaces: ["component"],
    claim:
      "Without read authority the strategy explains the refusal and every gateway read stays uncalled.",
    failsWhen:
      "Any gateway read is issued without read authority, the refusal is dressed as a transport error, or a retry invites a request that cannot be permitted.",
  },
  {
    id: "read-failure-vs-empty",
    surfaces: ["component"],
    claim:
      "An empty collection and a failed read are distinguishable, and only the failure offers a retry that actually re-requests.",
    failsWhen:
      "An empty result is announced as a failure, a failure is announced as empty, or the offered retry does not reach the gateway again.",
  },
  {
    id: "read-only-no-writes",
    surfaces: ["component"],
    claim:
      "In read-only mode every Runtime V1 write command is withheld and no gateway write is issued.",
    failsWhen:
      "A write command is exposed, or submitting anything the strategy still renders reaches a gateway write.",
  },
  {
    id: "detail-arrival-focus",
    surfaces: ["component"],
    claim:
      "Arriving at a record moves focus into the revealed detail exactly once, and a later render or refresh of the same record never takes focus back.",
    failsWhen:
      "Arrival leaves focus on the document body, moves it more than once, or a same-identity re-render steals focus from where the reader put it.",
  },
  {
    id: "back-focus-return",
    surfaces: ["component"],
    claim:
      "Leaving a record returns focus into the collection view rather than dropping it on the document body.",
    failsWhen:
      "The exit control does not report through the presentation contract, or focus is lost after the record closes.",
  },
  {
    id: "semantic-roles-and-labels",
    surfaces: ["component", "browser"],
    claim:
      "Headings exist and do not skip levels, and every interactive control has a non-empty accessible name.",
    failsWhen:
      "A control is unnamed, a heading level is skipped, or an authored role stands in for a control that is not focusable.",
  },
  {
    id: "canonical-navigation",
    surfaces: ["component", "browser"],
    claim:
      "Opening a record reports through the presentation contract; the strategy never writes history or exposes a transport URL.",
    failsWhen:
      "The strategy mutates location or history itself, or renders an absolute or /api/ address.",
  },
  {
    id: "keyboard-equivalents",
    surfaces: ["component", "browser"],
    claim:
      "Every core affordance is a natively operable, focusable control, so it answers the platform keyboard.",
    failsWhen:
      "A core affordance is an unfocusable element with a click handler, is disabled when it should act, or carries a positive tabindex.",
  },
  {
    id: "reflow-560",
    surfaces: ["browser"],
    claim:
      "At 560 effective CSS pixels the core flow reflows without page-level horizontal scrolling.",
    failsWhen:
      "The document scrolls horizontally, or a core control leaves the viewport.",
  },
  {
    id: "reflow-390",
    surfaces: ["browser"],
    claim:
      "At 390 effective CSS pixels the core flow reflows without page-level horizontal scrolling.",
    failsWhen:
      "The document scrolls horizontally, or a core control leaves the viewport.",
  },
  {
    id: "forced-colors",
    surfaces: ["browser"],
    claim:
      "Under forced colors controls keep a system-drawn boundary and a visible keyboard focus indicator.",
    failsWhen:
      "A control loses its border, or focus becomes invisible because the indicator was painted with an overridden color.",
  },
  {
    id: "reduced-motion",
    surfaces: ["browser"],
    claim:
      "Under reduced motion no visible element animates or transitions, and scrolling is not smoothed.",
    failsWhen:
      "Any visible element keeps a nonzero animation or transition duration.",
  },
  {
    id: "no-drag-only-core-flow",
    surfaces: ["component", "browser"],
    claim:
      "No core action is reachable only by dragging; any draggable element is itself a named, focusable control.",
    failsWhen:
      "A core step requires a pointer drag with no keyboard-operable equivalent.",
  },
] as const satisfies readonly ConformanceRequirement[];

export type ConformanceRequirementId = (typeof REQUIREMENTS)[number]["id"];

// `as const` is a compile-time promise only. Freeze the catalog for real so a
// runner cannot rewrite a claim it is about to be judged against.
for (const requirement of REQUIREMENTS) {
  Object.freeze(requirement.surfaces);
  Object.freeze(requirement);
}
Object.freeze(REQUIREMENTS);

export const INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE = Object.freeze({
  schemaId: INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID,
  version: 1,
  requirements: REQUIREMENTS,
} as const);

/**
 * Requirements whose only truthful evidence is a real browser engine.
 *
 * `collab/e2e/src/investigation-strategy/conformance.ts` mirrors this exact
 * literal and reads this file to prove the two have not drifted, so the list
 * must stay a plain array of quoted ids on their own lines.
 */
export const BROWSER_SURFACE_REQUIREMENT_IDS = [
  "semantic-roles-and-labels",
  "canonical-navigation",
  "keyboard-equivalents",
  "reflow-560",
  "reflow-390",
  "forced-colors",
  "reduced-motion",
  "no-drag-only-core-flow",
] as const;

/** Requirements this runner answers in jsdom. */
export const COMPONENT_SURFACE_REQUIREMENT_IDS = [
  "sparse-record",
  "loading",
  "read-denied-zero-calls",
  "read-failure-vs-empty",
  "read-only-no-writes",
  "detail-arrival-focus",
  "back-focus-return",
  "semantic-roles-and-labels",
  "canonical-navigation",
  "keyboard-equivalents",
  "no-drag-only-core-flow",
] as const;

export type ComponentSurfaceRequirementId =
  (typeof COMPONENT_SURFACE_REQUIREMENT_IDS)[number];
export type BrowserSurfaceRequirementId =
  (typeof BROWSER_SURFACE_REQUIREMENT_IDS)[number];

export function conformanceRequirement(
  id: ConformanceRequirementId,
): ConformanceRequirement {
  const found = REQUIREMENTS.find((requirement) => requirement.id === id);
  if (!found) throw new Error(`unknown conformance requirement ${id}`);
  return found;
}

/** Escape a fixture value so it can be matched as a literal accessible name. */
export function literalName(value: string): RegExp {
  return new RegExp(value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

/**
 * How to find the generic affordances the profile needs, expressed as
 * accessible-name matchers rather than selectors so a strategy cannot satisfy
 * the runner with an element assistive technology could not name. Every field
 * is required: declaring a matcher is not a way to opt out of a requirement,
 * and the runner independently verifies each one resolves to exactly one
 * enabled, natively operable control.
 */
export interface StrategyConformanceControls {
  readonly openRecord: (investigationTitle: string) => RegExp;
  readonly back: RegExp;
  readonly retryInvestigations: RegExp;
}

export interface StrategyConformanceTarget {
  /** Used only in failure messages. The runner never branches on it. */
  readonly label: string;
  readonly component: InvestigationStrategyComponent;
  readonly controls: StrategyConformanceControls;
}

export interface ConformanceEvidence {
  readonly id: ComponentSurfaceRequirementId;
  readonly claim: string;
  readonly observed: string;
}

export interface ConformanceReport {
  readonly schemaId: typeof INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID;
  readonly profileVersion: number;
  readonly target: string;
  readonly surface: "component";
  readonly evaluated: readonly ConformanceEvidence[];
  readonly deferredToBrowser: readonly BrowserSurfaceRequirementId[];
}

const GATEWAY_READS = [
  "listInvestigations",
  "getInvestigation",
  "listEvidence",
  "listContributions",
  "getLifecycle",
] as const;

const GATEWAY_WRITES = [
  "createInvestigation",
  "uploadEvidence",
  "createContribution",
  "updateSituation",
  "applyLifecycleAction",
] as const;

type GatewayMethod =
  | (typeof GATEWAY_READS)[number]
  | (typeof GATEWAY_WRITES)[number];

const FULL_CAPABILITIES: readonly string[] = Object.freeze([
  "investigation:read",
  "investigation:write",
  "run:strategies",
]);

const NO_CAPABILITIES: readonly string[] = Object.freeze([]);

const NATIVELY_OPERABLE_TAGS = new Set([
  "A",
  "BUTTON",
  "INPUT",
  "SELECT",
  "SUMMARY",
  "TEXTAREA",
]);

const INTERACTIVE_SELECTOR =
  "a[href], button, input:not([type='hidden']), select, textarea, summary, [role='button'], [role='link']";

const PLACEHOLDER_LEAKS = /undefined|\bNaN\b|\[object Object\]/u;

function noop(): void {
  // The shell owns navigation; conformance never asserts on this callback.
}

/** A read that is issued and never answers, for the in-progress baseline. */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

function mockOf(gateway: InvestigationGateway, method: GatewayMethod): Mock {
  return gateway[method] as unknown as Mock;
}

function callCount(gateway: InvestigationGateway, method: GatewayMethod): number {
  return mockOf(gateway, method).mock.calls.length;
}

function readCalls(gateway: InvestigationGateway): Record<string, number> {
  return Object.fromEntries(
    GATEWAY_READS.map((method) => [method, callCount(gateway, method)]),
  );
}

function writeCalls(gateway: InvestigationGateway): Record<string, number> {
  return Object.fromEntries(
    GATEWAY_WRITES.map((method) => [method, callCount(gateway, method)]),
  );
}

const ZERO_READS: Record<string, number> = Object.fromEntries(
  GATEWAY_READS.map((method) => [method, 0]),
);
const ZERO_WRITES: Record<string, number> = Object.fromEntries(
  GATEWAY_WRITES.map((method) => [method, 0]),
);

/**
 * Every gateway member must be classified as a read or a write. A new
 * transport method therefore fails this kit until the profile decides what it
 * means, rather than quietly escaping the denied-read and read-only proofs.
 */
function assertGatewaySurfaceIsClassified(gateway: InvestigationGateway): void {
  expect(
    Object.keys(gateway).sort(),
    "the gateway grew a method the conformance profile does not classify",
  ).toEqual([...GATEWAY_READS, ...GATEWAY_WRITES].sort());
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const referenced = labelledBy
      .split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replaceAll(/\s+/gu, " ")
      .trim();
    if (referenced) return referenced;
  }
  const label = element.getAttribute("aria-label")?.trim();
  if (label) return label;
  if (
    element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  ) {
    const fromLabels = Array.from(element.labels ?? [], (node) => node.textContent ?? "")
      .join(" ")
      .replaceAll(/\s+/gu, " ")
      .trim();
    if (fromLabels) return fromLabels;
  }
  const text = (element.textContent ?? "").replaceAll(/\s+/gu, " ").trim();
  if (text) return text;
  return element.getAttribute("title")?.trim() ?? "";
}

function describeElement(element: Element | null): string {
  if (element === null) return "<none>";
  const name = accessibleName(element);
  return `${element.tagName.toLowerCase()}${name ? `[${name.slice(0, 72)}]` : ""}`;
}

function isNativelyOperable(element: Element): boolean {
  if (!NATIVELY_OPERABLE_TAGS.has(element.tagName)) return false;
  if (element.tagName === "A" && !element.hasAttribute("href")) return false;
  return !element.hasAttribute("disabled");
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

interface RuntimeSinkProps {
  readonly sink: { current: InvestigationRuntime | null };
}

function RuntimeSink({ sink }: RuntimeSinkProps) {
  sink.current = useInvestigationRuntime();
  return null;
}

interface MountOptions {
  readonly component: InvestigationStrategyComponent;
  readonly gateway: InvestigationGateway;
  readonly capabilities?: readonly string[];
  readonly readOnly?: boolean;
  readonly focusCaseId?: string | null;
}

interface MountedStrategy {
  readonly container: HTMLElement;
  readonly gateway: InvestigationGateway;
  readonly onOpenCase: Mock;
  readonly onExitFocus: Mock;
  readonly focusLog: readonly string[];
  runtime(): InvestigationRuntime;
  setFocus(focusCaseId: string | null): void;
  unmount(): void;
}

function mountStrategy(options: MountOptions): MountedStrategy {
  const Strategy = options.component;
  const gateway = options.gateway;
  const onOpenCase = vi.fn();
  const onExitFocus = vi.fn();
  const runtimeSink: { current: InvestigationRuntime | null } = { current: null };
  const focusLog: string[] = [];

  const tree = (focusCaseId: string | null) => (
    <InvestigationRuntimeGatewayHarness gateway={gateway}>
      <InvestigationRuntimeProvider
        identityKey="conformance-identity"
        authorityKey="conformance-authority-v1"
        capabilities={options.capabilities ?? FULL_CAPABILITIES}
        readOnly={options.readOnly ?? false}
        active
        focusCaseId={focusCaseId}
        isInvestigationLocation
        onOpenCreated={noop}
      >
        <RuntimeSink sink={runtimeSink} />
        <Strategy
          view="investigations"
          focusCaseId={focusCaseId}
          stage="situation"
          onOpenCase={onOpenCase}
          onExitFocus={onExitFocus}
        />
      </InvestigationRuntimeProvider>
    </InvestigationRuntimeGatewayHarness>
  );

  // The listener is attached before the first render so an arrival focus that
  // happens during mount is still counted.
  const host = document.createElement("div");
  document.body.append(host);
  host.addEventListener("focusin", (event) => {
    focusLog.push(describeElement(event.target as Element | null));
  });
  const view: RenderResult = render(tree(options.focusCaseId ?? null), {
    container: host,
  });

  return {
    container: host,
    gateway,
    onOpenCase,
    onExitFocus,
    focusLog,
    runtime() {
      const runtime = runtimeSink.current;
      if (runtime === null) throw new Error("the runtime sink has not rendered");
      return runtime;
    },
    setFocus(focusCaseId) {
      view.rerender(tree(focusCaseId));
    },
    unmount() {
      view.unmount();
      host.remove();
    },
  };
}

/** A gateway whose reads answer with the shared Runtime V1 fixtures. */
function readableGateway(
  overrides: Partial<InvestigationGateway> = {},
): InvestigationGateway {
  return createInvestigationGatewayDouble(overrides);
}

function soleControl(
  mounted: MountedStrategy,
  name: RegExp,
  requirement: ComponentSurfaceRequirementId,
): HTMLElement {
  const matches = within(mounted.container).queryAllByRole("button", { name });
  const links = within(mounted.container).queryAllByRole("link", { name });
  const all = [...matches, ...links];
  expect(
    all.length,
    `${requirement}: expected exactly one control named ${String(name)}, found ${all.length}`,
  ).toBe(1);
  const control = all[0];
  if (!control) throw new Error(`${requirement}: control lookup returned nothing`);
  expect(
    isNativelyOperable(control),
    `${requirement}: ${describeElement(control)} is not a natively operable, enabled control`,
  ).toBe(true);
  return control;
}

interface CheckContext {
  readonly target: StrategyConformanceTarget;
}

type ComponentCheck = (context: CheckContext) => Promise<string>;

const POPULATED_TITLE = makePopulatedCase().title;
const SPARSE_TITLE = makeSparseImportedCase().title;

async function waitForListReady(mounted: MountedStrategy): Promise<void> {
  await waitFor(() => {
    expect(mounted.runtime().resources.investigations.status).not.toBe("idle");
    expect(mounted.runtime().resources.investigations.status).not.toBe("loading");
  });
}

async function waitForDetailReady(mounted: MountedStrategy): Promise<void> {
  await waitFor(() => {
    expect(mounted.runtime().resources.investigation.status).toBe("ready");
  });
}

/**
 * One check per component-surface requirement. The `Record` is total, so a new
 * component requirement fails to compile until it has evidence behind it.
 */
const COMPONENT_CHECKS: Record<ComponentSurfaceRequirementId, ComponentCheck> = {
  "sparse-record": async ({ target }) => {
    const gateway = readableGateway({
      getInvestigation: vi.fn(async () => gatewayOk(makeSparseImportedCase())),
      listEvidence: vi.fn(async () => gatewayOk([])),
      listContributions: vi.fn(async () => gatewayOk([])),
    });
    const mounted = mountStrategy({
      component: target.component,
      gateway,
      focusCaseId: RUNTIME_FIXTURE_IDS.sparseCase,
    });
    try {
      await waitForDetailReady(mounted);
      const scope = within(mounted.container);
      expect(scope.getAllByText(literalName(SPARSE_TITLE)).length).toBeGreaterThan(0);
      expect(
        scope.queryAllByRole("alert"),
        "a record without optional context is not a failure",
      ).toEqual([]);
      const text = mounted.container.textContent ?? "";
      expect(
        PLACEHOLDER_LEAKS.test(text),
        "an absent optional value leaked a placeholder into the record view",
      ).toBe(false);
      return `sparse record rendered with 0 alerts and no placeholder leakage across ${text.length} characters`;
    } finally {
      mounted.unmount();
    }
  },

  loading: async ({ target }) => {
    const gateway = readableGateway({
      listInvestigations: vi.fn(() => neverSettles()),
      getInvestigation: vi.fn(() => neverSettles()),
      listEvidence: vi.fn(() => neverSettles()),
      listContributions: vi.fn(() => neverSettles()),
      getLifecycle: vi.fn(() => neverSettles()),
    });
    const mounted = mountStrategy({ component: target.component, gateway });
    try {
      await settle();
      const scope = within(mounted.container);
      const statuses = scope.queryAllByRole("status");
      const busy = mounted.container.querySelectorAll("[aria-busy='true']");
      expect(
        statuses.length + busy.length,
        "an unsettled read must be reported as in progress",
      ).toBeGreaterThan(0);
      expect(
        scope.queryAllByRole("alert"),
        "a read that has not finished is not a failure",
      ).toEqual([]);
      expect(
        scope.queryAllByRole("button", { name: target.controls.retryInvestigations }),
        "a retry must not be offered while the original read is still in flight",
      ).toEqual([]);
      return `${statuses.length} status region(s) and ${busy.length} aria-busy region(s) with 0 alerts and 0 retries while every read was pending`;
    } finally {
      mounted.unmount();
    }
  },

  "read-denied-zero-calls": async ({ target }) => {
    const gateway = readableGateway();
    assertGatewaySurfaceIsClassified(gateway);
    const mounted = mountStrategy({
      component: target.component,
      gateway,
      capabilities: NO_CAPABILITIES,
    });
    try {
      await settle();
      await settle();
      expect(readCalls(gateway), "a denied viewer issued a gateway read").toEqual(
        ZERO_READS,
      );
      const scope = within(mounted.container);
      expect(
        scope.queryAllByRole("status").length,
        "a refusal must be explained, not left blank",
      ).toBeGreaterThan(0);
      expect(
        scope.queryAllByRole("alert"),
        "a refusal is an authority answer, not a transport failure",
      ).toEqual([]);
      expect(
        scope.queryAllByRole("button", { name: target.controls.retryInvestigations }),
        "a refused read must not offer a retry",
      ).toEqual([]);

      // Focusing a record must not turn a refusal into a request either.
      mounted.setFocus(RUNTIME_FIXTURE_IDS.populatedCase);
      await settle();
      await settle();
      expect(
        readCalls(gateway),
        "focusing a record made a denied viewer issue a gateway read",
      ).toEqual(ZERO_READS);
      expect(writeCalls(gateway)).toEqual(ZERO_WRITES);
      expect(
        within(mounted.container).queryAllByRole("alert"),
        "a refused record view is not a transport failure",
      ).toEqual([]);
      return `0 calls to each of ${GATEWAY_READS.join(", ")} in both the collection and record views`;
    } finally {
      mounted.unmount();
    }
  },

  "read-failure-vs-empty": async ({ target }) => {
    const emptyGateway = readableGateway({
      listInvestigations: vi.fn(async () => gatewayOk([])),
    });
    const empty = mountStrategy({ component: target.component, gateway: emptyGateway });
    let emptyText: string;
    try {
      await waitForListReady(empty);
      const scope = within(empty.container);
      expect(
        scope.queryAllByRole("alert"),
        "an empty collection is a result, not a failure",
      ).toEqual([]);
      expect(
        scope.queryAllByRole("button", { name: target.controls.retryInvestigations }),
        "an empty collection must not offer a failure retry",
      ).toEqual([]);
      emptyText = (empty.container.textContent ?? "").replaceAll(/\s+/gu, " ").trim();
    } finally {
      empty.unmount();
    }

    const failingGateway = readableGateway({
      listInvestigations: vi.fn(async () => gatewayUnavailable<readonly never[]>()),
    });
    const failed = mountStrategy({
      component: target.component,
      gateway: failingGateway,
    });
    try {
      await waitForListReady(failed);
      const scope = within(failed.container);
      expect(
        scope.queryAllByRole("alert").length,
        "a failed read must be announced as a failure",
      ).toBeGreaterThan(0);
      const retry = soleControl(
        failed,
        target.controls.retryInvestigations,
        "read-failure-vs-empty",
      );
      const before = callCount(failingGateway, "listInvestigations");
      fireEvent.click(retry);
      await waitFor(() => {
        expect(
          callCount(failingGateway, "listInvestigations"),
          "the offered retry never reached the gateway again",
        ).toBeGreaterThan(before);
      });
      const failedText = (failed.container.textContent ?? "")
        .replaceAll(/\s+/gu, " ")
        .trim();
      expect(
        failedText,
        "a failed read and an empty collection read identically",
      ).not.toBe(emptyText);
      return `empty read: 0 alerts and 0 retries; failed read: ${scope.queryAllByRole("alert").length} alert(s) and a retry that re-requested the collection`;
    } finally {
      failed.unmount();
    }
  },

  "read-only-no-writes": async ({ target }) => {
    const gateway = readableGateway();
    const mounted = mountStrategy({
      component: target.component,
      gateway,
      readOnly: true,
      focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase,
    });
    try {
      await waitForDetailReady(mounted);
      const commands = mounted.runtime().commands;
      expect(commands.createInvestigation, "read-only exposed a create command").toBeNull();
      expect(commands.uploadEvidence, "read-only exposed an upload command").toBeNull();
      expect(commands.applyLifecycle, "read-only exposed a lifecycle command").toBeNull();

      const forms = Array.from(mounted.container.querySelectorAll("form"));
      for (const form of forms) fireEvent.submit(form);
      const submits = Array.from(
        mounted.container.querySelectorAll<HTMLElement>(
          "button[type='submit']:not([disabled])",
        ),
      );
      for (const submit of submits) fireEvent.click(submit);
      await settle();
      await settle();
      expect(
        writeCalls(gateway),
        "read-only mode reached a gateway write",
      ).toEqual(ZERO_WRITES);
      return `every write command withheld; ${forms.length} form submission(s) and ${submits.length} submit activation(s) produced 0 calls to ${GATEWAY_WRITES.join(", ")}`;
    } finally {
      mounted.unmount();
    }
  },

  "detail-arrival-focus": async ({ target }) => {
    const gateway = readableGateway();
    const mounted = mountStrategy({ component: target.component, gateway });
    try {
      await waitForListReady(mounted);
      const beforeArrival = mounted.focusLog.length;

      mounted.setFocus(RUNTIME_FIXTURE_IDS.populatedCase);
      await waitForDetailReady(mounted);
      await waitFor(() => {
        expect(
          mounted.container.contains(document.activeElement),
          "arriving at a record left focus outside the revealed detail",
        ).toBe(true);
      });
      const arrivalFocus = document.activeElement;
      expect(
        mounted.focusLog.length - beforeArrival,
        `arrival moved focus ${mounted.focusLog.length - beforeArrival} time(s): ${mounted.focusLog.slice(beforeArrival).join(" -> ")}`,
      ).toBe(1);

      // The reader moves focus somewhere of their own choosing. A re-render or
      // a refresh of the same record must not take it back.
      const back = soleControl(mounted, target.controls.back, "detail-arrival-focus");
      act(() => back.focus());
      expect(document.activeElement).toBe(back);
      const afterDeliberateFocus = mounted.focusLog.length;

      mounted.setFocus(RUNTIME_FIXTURE_IDS.populatedCase);
      await settle();
      act(() => mounted.runtime().refresh.investigation());
      await settle();
      await settle();
      expect(
        document.activeElement,
        "a same-identity re-render or refresh stole focus back to the detail",
      ).toBe(back);
      expect(
        mounted.focusLog.length,
        `focus moved again after the reader placed it: ${mounted.focusLog.slice(afterDeliberateFocus).join(" -> ")}`,
      ).toBe(afterDeliberateFocus);
      return `arrival focused ${describeElement(arrivalFocus)} exactly once; a same-identity re-render and refresh left focus on ${describeElement(back)}`;
    } finally {
      mounted.unmount();
    }
  },

  "back-focus-return": async ({ target }) => {
    const gateway = readableGateway();
    const mounted = mountStrategy({
      component: target.component,
      gateway,
      focusCaseId: RUNTIME_FIXTURE_IDS.populatedCase,
    });
    try {
      await waitForDetailReady(mounted);
      const back = soleControl(mounted, target.controls.back, "back-focus-return");
      fireEvent.click(back);
      expect(
        mounted.onExitFocus,
        "the exit control did not report through the presentation contract",
      ).toHaveBeenCalledTimes(1);
      expect(
        mounted.onOpenCase,
        "leaving a record must not also request opening one",
      ).not.toHaveBeenCalled();

      mounted.setFocus(null);
      await waitFor(() => {
        expect(
          mounted.container.contains(document.activeElement),
          "closing a record dropped focus outside the strategy",
        ).toBe(true);
      });
      expect(document.activeElement).not.toBe(document.body);
      return `exit reported once through onExitFocus and focus returned to ${describeElement(document.activeElement)}`;
    } finally {
      mounted.unmount();
    }
  },

  "semantic-roles-and-labels": async ({ target }) => {
    const gateway = readableGateway();
    const mounted = mountStrategy({ component: target.component, gateway });
    try {
      await waitForListReady(mounted);
      let inspected = 0;
      const audit = (phase: string) => {
        const headings = Array.from(
          mounted.container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
        );
        expect(headings.length, `${phase}: no heading was rendered`).toBeGreaterThan(0);
        let previous = 0;
        for (const heading of headings) {
          const level = Number.parseInt(heading.tagName.slice(1), 10);
          if (previous !== 0) {
            expect(
              level - previous,
              `${phase}: heading level skipped from h${previous} to h${level}`,
            ).toBeLessThanOrEqual(1);
          }
          previous = level;
        }
        const unnamed: string[] = [];
        const controls = Array.from(
          mounted.container.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR),
        );
        for (const control of controls) {
          inspected += 1;
          if (!accessibleName(control)) unnamed.push(describeElement(control));
          const tabIndex = control.getAttribute("tabindex");
          if (tabIndex !== null) {
            expect(
              Number.parseInt(tabIndex, 10),
              `${phase}: ${describeElement(control)} carries a positive tabindex`,
            ).toBeLessThanOrEqual(0);
          }
          const role = control.getAttribute("role");
          if (role === "button" || role === "link") {
            expect(
              isNativelyOperable(control) || control.hasAttribute("tabindex"),
              `${phase}: ${describeElement(control)} declares role ${role} but cannot take focus`,
            ).toBe(true);
          }
        }
        expect(unnamed, `${phase}: interactive controls without an accessible name`).toEqual([]);
      };

      audit("collection view");
      mounted.setFocus(RUNTIME_FIXTURE_IDS.populatedCase);
      await waitForDetailReady(mounted);
      audit("record view");
      return `${inspected} interactive control(s) named and no skipped heading level across the collection and record views`;
    } finally {
      mounted.unmount();
    }
  },

  "canonical-navigation": async ({ target }) => {
    const gateway = readableGateway();
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const mounted = mountStrategy({ component: target.component, gateway });
    const locationBefore = window.location.href;
    try {
      await waitForListReady(mounted);
      const open = soleControl(
        mounted,
        target.controls.openRecord(POPULATED_TITLE),
        "canonical-navigation",
      );
      fireEvent.click(open);
      expect(
        mounted.onOpenCase,
        "opening a record did not report through the presentation contract",
      ).toHaveBeenCalledTimes(1);
      expect(mounted.onOpenCase).toHaveBeenCalledWith(RUNTIME_FIXTURE_IDS.populatedCase);
      expect(window.location.href, "the strategy changed the address itself").toBe(
        locationBefore,
      );
      expect(pushState, "the strategy wrote history itself").not.toHaveBeenCalled();
      expect(replaceState, "the strategy rewrote history itself").not.toHaveBeenCalled();

      const exposed = Array.from(
        mounted.container.querySelectorAll<HTMLAnchorElement>("a[href]"),
      )
        .map((anchor) => anchor.getAttribute("href") ?? "")
        .filter((href) => /^(?:https?:)?\/\//u.test(href) || href.startsWith("/api/"));
      expect(exposed, "the strategy rendered a transport or absolute address").toEqual([]);
      return `onOpenCase(${RUNTIME_FIXTURE_IDS.populatedCase}) reported once with an unchanged address, 0 history writes, and 0 transport addresses`;
    } finally {
      mounted.unmount();
      pushState.mockRestore();
      replaceState.mockRestore();
    }
  },

  "keyboard-equivalents": async ({ target }) => {
    const gateway = readableGateway();
    const mounted = mountStrategy({ component: target.component, gateway });
    try {
      await waitForListReady(mounted);
      const open = soleControl(
        mounted,
        target.controls.openRecord(POPULATED_TITLE),
        "keyboard-equivalents",
      );
      act(() => open.focus());
      expect(
        document.activeElement,
        "the control that opens a record cannot take focus",
      ).toBe(open);

      mounted.setFocus(RUNTIME_FIXTURE_IDS.populatedCase);
      await waitForDetailReady(mounted);
      const back = soleControl(mounted, target.controls.back, "keyboard-equivalents");
      act(() => back.focus());
      expect(document.activeElement, "the exit control cannot take focus").toBe(back);

      const unreachable = Array.from(
        mounted.container.querySelectorAll<HTMLElement>("[role='button'], [role='link']"),
      )
        .filter((element) => !isNativelyOperable(element) && !element.hasAttribute("tabindex"))
        .map(describeElement);
      expect(
        unreachable,
        "an authored control is not reachable by keyboard",
      ).toEqual([]);
      return `${describeElement(open)} and ${describeElement(back)} are natively operable and focusable; 0 unreachable authored controls`;
    } finally {
      mounted.unmount();
    }
  },

  "no-drag-only-core-flow": async ({ target }) => {
    const gateway = readableGateway();
    const mounted = mountStrategy({ component: target.component, gateway });
    try {
      await waitForListReady(mounted);
      let draggable = 0;
      const audit = (phase: string) => {
        const nodes = Array.from(
          mounted.container.querySelectorAll<HTMLElement>("[draggable='true']"),
        );
        draggable += nodes.length;
        const dragOnly = nodes
          .filter((node) => !isNativelyOperable(node) || !accessibleName(node))
          .map(describeElement);
        expect(
          dragOnly,
          `${phase}: a draggable element offers no named, focusable equivalent`,
        ).toEqual([]);
      };
      audit("collection view");
      mounted.setFocus(RUNTIME_FIXTURE_IDS.populatedCase);
      await waitForDetailReady(mounted);
      audit("record view");
      return `${draggable} draggable element(s), each with a named focusable equivalent; the browser surface confirms no drag-only path`;
    } finally {
      mounted.unmount();
    }
  },
};

/**
 * Run every component-surface requirement against one strategy.
 *
 * The returned report is the run's evidence. Callers assert its `evaluated`
 * ids against `COMPONENT_SURFACE_REQUIREMENT_IDS`, which is what makes a
 * skipped requirement a failure rather than a quiet pass.
 */
export async function runComponentConformance(
  target: StrategyConformanceTarget,
): Promise<ConformanceReport> {
  const evaluated: ConformanceEvidence[] = [];
  for (const id of COMPONENT_SURFACE_REQUIREMENT_IDS) {
    const requirement = conformanceRequirement(id);
    let observed: string;
    try {
      observed = await COMPONENT_CHECKS[id]({ target });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `${target.label} fails conformance requirement "${id}".\n`
          + `  claim: ${requirement.claim}\n`
          + `  fails when: ${requirement.failsWhen}\n`
          + `  detail: ${detail}`,
        cause instanceof Error ? { cause } : undefined,
      );
    }
    evaluated.push({ id, claim: requirement.claim, observed });
  }

  return Object.freeze({
    schemaId: INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID,
    profileVersion: INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE.version,
    target: target.label,
    surface: "component",
    evaluated: Object.freeze(evaluated),
    deferredToBrowser: Object.freeze(
      BROWSER_SURFACE_REQUIREMENT_IDS.filter(
        (id) => !(COMPONENT_SURFACE_REQUIREMENT_IDS as readonly string[]).includes(id),
      ),
    ) as readonly BrowserSurfaceRequirementId[],
  });
}
