import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_STRATEGY_IDS, type UiStrategyId } from "../../../ui-strategy.js";
import {
  selectResourceView,
  useInvestigationRuntime,
} from "../../runtime/public.js";
import type {
  InvestigationStrategyComponent,
  InvestigationStrategyShellProps,
} from "../contract.js";
import { InvestigationFirstStrategy } from "../investigation-first/InvestigationFirstStrategy.js";
import {
  BROWSER_SURFACE_REQUIREMENT_IDS,
  COMPONENT_SURFACE_REQUIREMENT_IDS,
  INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE,
  INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID,
  literalName,
  runComponentConformance,
  type ConformanceRequirement,
  type StrategyConformanceTarget,
} from "./conformance.js";

afterEach(cleanup);

const { requirements } = INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE;

/**
 * A second, deliberately unrelated presentation. It shares no markup, copy, or
 * class name with the shipped strategy, so a run that passes for both is
 * evidence the profile is about behavior rather than one strategy's DOM.
 * Each defect isolates exactly one baseline the harness must refuse to waive.
 */
type ProbeDefect =
  | "none"
  | "alert-on-empty"
  | "no-arrival-focus"
  | "focus-theft"
  | "unnamed-control"
  | "history-navigation";

function makeProbeStrategy(defect: ProbeDefect): InvestigationStrategyComponent {
  return function ProbeStrategy(props: InvestigationStrategyShellProps) {
    const runtime = useInvestigationRuntime();
    const investigations = selectResourceView(runtime.resources.investigations);
    const investigation = selectResourceView(runtime.resources.investigation);
    const listHeadingRef = useRef<HTMLHeadingElement>(null);
    const detailHeadingRef = useRef<HTMLHeadingElement>(null);
    const priorFocusId = useRef<string | null>(props.focusCaseId);
    const arrival = useRef<string | null>(null);
    const denied = !runtime.capabilities.canRead;

    const detailArrival = props.focusCaseId === null
      ? null
      : denied
        ? `denied:${props.focusCaseId}`
        : investigation.availability === "unavailable"
          ? `unavailable:${props.focusCaseId}`
          : investigation.availability === "available"
              && investigation.value.id === props.focusCaseId
            ? `available:${props.focusCaseId}`
            : null;

    useEffect(() => {
      const previous = priorFocusId.current;
      priorFocusId.current = props.focusCaseId;
      if (previous !== null && props.focusCaseId === null) listHeadingRef.current?.focus();
    }, [props.focusCaseId]);

    // Deliberately unkeyed so the "focus-theft" defect can re-run on every
    // render; the arrival guard keeps the conformant path to exactly one move.
    useEffect(() => {
      if (defect === "no-arrival-focus") return;
      if (detailArrival === null) {
        arrival.current = null;
        return;
      }
      if (defect !== "focus-theft" && arrival.current === detailArrival) return;
      arrival.current = detailArrival;
      detailHeadingRef.current?.focus();
    });

    function openRecord(investigationId: string): void {
      if (defect === "history-navigation") {
        window.history.pushState({}, "", `/investigations/${investigationId}/situation`);
      }
      props.onOpenCase(investigationId);
    }

    if (props.focusCaseId !== null) {
      if (denied) {
        return (
          <section>
            <h1>Probe strategy</h1>
            <h2 ref={detailHeadingRef} tabIndex={-1}>Record unavailable in this view</h2>
            <p role="status">This view has no read authority, so nothing was requested.</p>
            <button type="button" onClick={props.onExitFocus}>Back to investigations</button>
          </section>
        );
      }
      if (
        investigation.availability === "idle"
        || investigation.availability === "loading"
      ) {
        return (
          <section>
            <h1>Probe strategy</h1>
            <p role="status">Opening record…</p>
          </section>
        );
      }
      if (investigation.availability === "unavailable") {
        return (
          <section>
            <h1>Probe strategy</h1>
            <h2 ref={detailHeadingRef} tabIndex={-1}>Record unavailable</h2>
            <div role="alert"><p>This record could not be loaded.</p></div>
            <button type="button" onClick={props.onExitFocus}>Back to investigations</button>
          </section>
        );
      }
      return (
        <section>
          <h1>Probe strategy</h1>
          <button type="button" onClick={props.onExitFocus}>Back to investigations</button>
          <h2 ref={detailHeadingRef} tabIndex={-1}>{investigation.value.title}</h2>
          <p>Record {investigation.value.id}</p>
        </section>
      );
    }

    const empty = investigations.availability === "available"
      && investigations.value.length === 0;
    return (
      <section>
        <h1>Probe strategy</h1>
        <h2 ref={listHeadingRef} tabIndex={-1}>Records</h2>
        {defect === "unnamed-control" ? <button type="button" /> : null}
        {denied ? (
          <p role="status">This view has no read authority, so nothing was requested.</p>
        ) : null}
        {!denied
        && (investigations.availability === "idle"
          || investigations.availability === "loading") ? (
          <p role="status">Loading records…</p>
        ) : null}
        {investigations.availability === "unavailable" ? (
          <div role="alert">
            <p>Records could not be loaded.</p>
            <button type="button" onClick={runtime.refresh.investigations}>
              Retry loading investigations
            </button>
          </div>
        ) : null}
        {empty && defect === "alert-on-empty" ? (
          <div role="alert"><p>Records could not be loaded.</p></div>
        ) : null}
        {empty && defect !== "alert-on-empty" ? (
          <p>No records have been created yet.</p>
        ) : null}
        {investigations.availability === "available" && !empty ? (
          <ul>
            {investigations.value.map((row) => (
              <li key={row.id}>
                <button type="button" onClick={() => openRecord(row.id)}>{row.title}</button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  };
}

const SHARED_CONTROLS = {
  openRecord: (title: string) => literalName(title),
  back: /Back to investigations/u,
  retryInvestigations: /^Retry loading investigations$/u,
} as const;

function probeTarget(defect: ProbeDefect): StrategyConformanceTarget {
  return {
    label: `probe strategy (${defect})`,
    component: makeProbeStrategy(defect),
    controls: SHARED_CONTROLS,
  };
}

const investigationFirstTarget: StrategyConformanceTarget = {
  label: "Investigation First",
  component: InvestigationFirstStrategy,
  controls: SHARED_CONTROLS,
};

describe("investigation strategy conformance profile", () => {
  it("declares one frozen, uniquely identified requirement per baseline state", () => {
    expect(INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE.schemaId).toBe(
      INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID,
    );
    expect(INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE.version).toBe(1);
    expect(Object.isFrozen(INVESTIGATION_STRATEGY_CONFORMANCE_PROFILE)).toBe(true);
    expect(Object.isFrozen(requirements)).toBe(true);

    const ids = requirements.map((requirement) => requirement.id);
    expect(new Set(ids).size, "duplicate requirement id").toBe(ids.length);
    for (const requirement of requirements) {
      expect(Object.isFrozen(requirement)).toBe(true);
      expect(Object.isFrozen(requirement.surfaces)).toBe(true);
      expect(requirement.claim.length, `${requirement.id} has no claim`).toBeGreaterThan(0);
      expect(
        requirement.failsWhen.length,
        `${requirement.id} does not say when it fails`,
      ).toBeGreaterThan(0);
      expect(
        requirement.surfaces.length,
        `${requirement.id} names no surface that can answer it`,
      ).toBeGreaterThan(0);
    }
  });

  it("covers every baseline state named by the Runtime V1 presentation review", () => {
    // A literal expectation, so removing or renaming a baseline is a reviewed
    // edit here rather than a silently shorter profile.
    expect(requirements.map((requirement) => requirement.id)).toEqual([
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
      "reflow-560",
      "reflow-390",
      "forced-colors",
      "reduced-motion",
      "no-drag-only-core-flow",
    ]);
  });

  it("partitions every requirement across the component and browser surfaces", () => {
    // The profile is a const tuple, so each entry's `surfaces` has its own
    // literal type. Read them through the shared interface to ask one question
    // of every requirement rather than of each entry's narrowed shape.
    const declared: readonly ConformanceRequirement[] = requirements;
    const derivedComponent = declared
      .filter((requirement) => requirement.surfaces.includes("component"))
      .map((requirement) => requirement.id);
    const derivedBrowser = declared
      .filter((requirement) => requirement.surfaces.includes("browser"))
      .map((requirement) => requirement.id);

    expect([...COMPONENT_SURFACE_REQUIREMENT_IDS]).toEqual(derivedComponent);
    expect([...BROWSER_SURFACE_REQUIREMENT_IDS]).toEqual(derivedBrowser);
    expect(
      new Set([...derivedComponent, ...derivedBrowser]).size,
      "a requirement has no surface that can answer it",
    ).toBe(requirements.length);
  });
});

describe("investigation strategy conformance runner", () => {
  it("holds the shipped Investigation First strategy to every component-surface requirement", async () => {
    const report = await runComponentConformance(investigationFirstTarget);

    expect(report.schemaId).toBe(INVESTIGATION_STRATEGY_CONFORMANCE_SCHEMA_ID);
    expect(report.target).toBe("Investigation First");
    expect(report.surface).toBe("component");
    expect(report.evaluated.map((evidence) => evidence.id)).toEqual([
      ...COMPONENT_SURFACE_REQUIREMENT_IDS,
    ]);
    for (const evidence of report.evaluated) {
      expect(evidence.observed.length, `${evidence.id} recorded no evidence`).toBeGreaterThan(0);
    }
    expect(report.deferredToBrowser).toEqual([
      "reflow-560",
      "reflow-390",
      "forced-colors",
      "reduced-motion",
    ]);
  }, 60_000);

  it("holds an unrelated strategy to the same profile without strategy-specific knowledge", async () => {
    const report = await runComponentConformance(probeTarget("none"));

    expect(report.evaluated.map((evidence) => evidence.id)).toEqual([
      ...COMPONENT_SURFACE_REQUIREMENT_IDS,
    ]);
  }, 60_000);

  it.each([
    ["alert-on-empty", "read-failure-vs-empty"],
    ["no-arrival-focus", "detail-arrival-focus"],
    ["focus-theft", "detail-arrival-focus"],
    ["unnamed-control", "semantic-roles-and-labels"],
    ["history-navigation", "canonical-navigation"],
  ] as const)(
    "refuses to let a strategy waive a baseline state (%s)",
    async (defect, requirementId) => {
      await expect(runComponentConformance(probeTarget(defect))).rejects.toThrow(
        new RegExp(`fails conformance requirement "${requirementId}"`, "u"),
      );
    },
    60_000,
  );
});

const TESTKIT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TESTKIT_DIR, "../../../../../..");

/** The shipped strategy catalogue this manifest must stay exhaustive against. */
const UI_STRATEGY_SOURCE_PATH = "collab/web/src/ui-strategy.ts";

function repositorySource(path: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, path), "utf8");
}

/**
 * The shipped identifiers as the catalogue file itself declares them.
 *
 * The import above is already the module the shell consumes, so it is the
 * shipped vocabulary rather than a copy. Reading the declaration as text as
 * well is cheap and fails closed: it proves the required key set is anchored
 * to the catalogue under review, not to whatever this test happens to import.
 */
function shippedStrategyIdsFromSource(): string[] {
  const source = repositorySource(UI_STRATEGY_SOURCE_PATH);
  const body = /export const UI_STRATEGY_IDS\s*=\s*\[([\s\S]*?)\]/u.exec(source)?.[1];
  if (body === undefined) {
    throw new Error(
      `${UI_STRATEGY_SOURCE_PATH} no longer declares UI_STRATEGY_IDS as a literal array`,
    );
  }
  return [...body.matchAll(/"([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);
}

/**
 * How a shipped strategy earns its conformance coverage.
 *
 * The two kinds are deliberately not interchangeable. `shared-conformance` is
 * the strong claim: the strategy is mounted by the strategy-neutral runner in
 * this file and answered on the browser surface by the shared harness.
 * `dedicated-coverage` is the weaker, honest one: the strategy has its own
 * accessibility spec and makes no claim about the shared profile at all.
 */
type StrategyCoverageKind = "shared-conformance" | "dedicated-coverage";

interface SharedConformanceEnrollment {
  readonly kind: "shared-conformance";
  /** The exact target the shared component runner is given above. */
  readonly componentTarget: StrategyConformanceTarget;
  /** Repository-relative spec that drives the shared browser-surface harness. */
  readonly browserSpec: string;
  readonly evidence: string;
}

interface DedicatedCoverageEnrollment {
  readonly kind: "dedicated-coverage";
  /** Repository-relative specs carrying this strategy's own coverage. */
  readonly dedicatedSpecs: readonly string[];
  readonly evidence: string;
  /** Why the shared runner is not the claim being made. */
  readonly notSharedBecause: string;
}

type StrategyCoverageEnrollment =
  | SharedConformanceEnrollment
  | DedicatedCoverageEnrollment;

/**
 * Test-only proof that every shipped presentation strategy has explicit,
 * truthful conformance coverage.
 *
 * The runner above holds one strategy to the profile; until now nothing said
 * which strategies must be held to anything. This manifest closes that gap
 * without a production registry seam: it names, per shipped strategy ID, where
 * that strategy's coverage actually lives and what kind of claim it is. The
 * `Record<UiStrategyId, …>` annotation makes a newly shipped strategy a
 * compile error here until it is enrolled, and the assertions below reject an
 * entry for a strategy the app does not ship.
 *
 * Recording the weaker claim honestly is the point: listing the reference
 * surface as shared-profile conformant would be worse than no manifest at all.
 */
const STRATEGY_COVERAGE_MANIFEST: Readonly<
  Record<UiStrategyId, StrategyCoverageEnrollment>
> = {
  "investigation-first": {
    kind: "shared-conformance",
    componentTarget: investigationFirstTarget,
    browserSpec: "collab/e2e/specs/27-investigation-first-accessibility.spec.ts",
    evidence:
      "Held to every component-surface requirement by runComponentConformance in this file, and to the browser-surface requirements by the shared harness the named spec drives.",
  },
  "war-room": {
    kind: "dedicated-coverage",
    dedicatedSpecs: [
      "collab/e2e/specs/22-war-room-a11y-responsive.spec.ts",
    ],
    evidence:
      "Accessibility and responsive coverage for the War Room scenario surfaces: phone reflow without horizontal scroll, accessible names on intake and evidence controls, landmarks with a working skip link, a keyboard-operable evidence log disclosure, and a comparison matrix that scrolls inside its own wrapper.",
    notSharedBecause:
      "The reference surface is not mounted by the strategy-neutral component runner, so this manifest records the dedicated spec it does have rather than a shared-profile pass it has not earned.",
  },
};

// The annotation is a compile-time promise only. Freeze the manifest and each
// enrollment for real, so a test cannot rewrite the claim it is about to check.
for (const enrollment of Object.values(STRATEGY_COVERAGE_MANIFEST)) {
  if (enrollment.kind === "dedicated-coverage") Object.freeze(enrollment.dedicatedSpecs);
  Object.freeze(enrollment);
}
Object.freeze(STRATEGY_COVERAGE_MANIFEST);

function enrolledIds(kind: StrategyCoverageKind): string[] {
  return Object.entries(STRATEGY_COVERAGE_MANIFEST)
    .filter(([, enrollment]) => enrollment.kind === kind)
    .map(([id]) => id)
    .sort();
}

function sharedEnrollment(id: UiStrategyId): SharedConformanceEnrollment {
  const enrollment = STRATEGY_COVERAGE_MANIFEST[id];
  if (enrollment.kind !== "shared-conformance") {
    throw new Error(`${id} is not enrolled in the shared conformance profile`);
  }
  return enrollment;
}

function dedicatedEnrollment(id: UiStrategyId): DedicatedCoverageEnrollment {
  const enrollment = STRATEGY_COVERAGE_MANIFEST[id];
  if (enrollment.kind !== "dedicated-coverage") {
    throw new Error(`${id} is not recorded as dedicated coverage`);
  }
  return enrollment;
}

function coveragePaths(enrollment: StrategyCoverageEnrollment): readonly string[] {
  return enrollment.kind === "shared-conformance"
    ? [enrollment.browserSpec]
    : enrollment.dedicatedSpecs;
}

describe("shipped strategy conformance coverage", () => {
  it("enrolls exactly the shipped strategy catalogue, with no unknown or missing entry", () => {
    expect(Object.isFrozen(STRATEGY_COVERAGE_MANIFEST)).toBe(true);

    // The required keys come from the shipped catalogue, never from the
    // manifest itself, so a strategy cannot be dropped from the requirement by
    // being dropped from the manifest.
    expect(shippedStrategyIdsFromSource()).toEqual([...UI_STRATEGY_IDS]);
    const shipped: string[] = [...UI_STRATEGY_IDS].sort();
    const enrolled = Object.keys(STRATEGY_COVERAGE_MANIFEST).sort();

    expect(enrolled).toEqual(shipped);
    expect(
      enrolled.filter((id) => !shipped.includes(id)),
      "the manifest registers a strategy the app does not ship",
    ).toEqual([]);
    expect(
      shipped.filter((id) => !enrolled.includes(id)),
      "a shipped strategy has no declared conformance coverage",
    ).toEqual([]);
  });

  it("separates a shared-profile claim from dedicated coverage", () => {
    expect(enrolledIds("shared-conformance")).toEqual(["investigation-first"]);
    expect(enrolledIds("dedicated-coverage")).toEqual(["war-room"]);
  });

  it("backs every enrollment with non-empty evidence and a coverage file that exists", () => {
    for (const [id, enrollment] of Object.entries(STRATEGY_COVERAGE_MANIFEST)) {
      expect(Object.isFrozen(enrollment), `${id} enrollment is mutable`).toBe(true);
      expect(
        enrollment.evidence.trim().length,
        `${id} records no coverage evidence`,
      ).toBeGreaterThan(0);

      const paths = coveragePaths(enrollment);
      expect(paths.length, `${id} names no coverage file`).toBeGreaterThan(0);
      for (const path of paths) {
        expect(
          existsSync(resolve(REPOSITORY_ROOT, path)),
          `${id} names a coverage file that does not exist: ${path}`,
        ).toBe(true);
        expect(
          repositorySource(path).trim().length,
          `${id} names an empty coverage file: ${path}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("enrolls Investigation First in the shared runner this file actually runs", () => {
    const enrollment = sharedEnrollment("investigation-first");

    // Identity, not a look-alike: the manifest points at the very target the
    // shared component runner is given above, so the enrollment cannot drift
    // away from the run that earns it.
    expect(enrollment.componentTarget).toBe(investigationFirstTarget);
    expect(enrollment.componentTarget.component).toBe(InvestigationFirstStrategy);
    expect(enrollment.componentTarget.label).toBe("Investigation First");

    // Exactly one shared component target exists, and it is that one.
    const sharedTargets = Object.values(STRATEGY_COVERAGE_MANIFEST)
      .filter(
        (candidate): candidate is SharedConformanceEnrollment =>
          candidate.kind === "shared-conformance",
      )
      .map((candidate) => candidate.componentTarget);
    expect(sharedTargets).toEqual([investigationFirstTarget]);

    // The browser half is the same shared profile, not a bespoke spec.
    expect(
      repositorySource(enrollment.browserSpec),
      `${enrollment.browserSpec} does not drive the shared browser harness`,
    ).toContain("../src/investigation-strategy/conformance.js");
  });

  it("labels War Room as dedicated accessibility coverage without claiming the shared runner", () => {
    const enrollment = dedicatedEnrollment("war-room");

    expect(Object.isFrozen(enrollment.dedicatedSpecs)).toBe(true);
    expect([...enrollment.dedicatedSpecs]).toEqual([
      "collab/e2e/specs/22-war-room-a11y-responsive.spec.ts",
    ]);
    expect(enrollment.notSharedBecause.trim().length).toBeGreaterThan(0);

    // The claim is structurally impossible to overstate: a dedicated
    // enrollment carries no component target, so nothing here can be read as
    // "War Room passed the shared component runner".
    expect(Object.hasOwn(enrollment, "componentTarget")).toBe(false);
    expect(enrolledIds("shared-conformance")).not.toContain("war-room");

    for (const path of enrollment.dedicatedSpecs) {
      const spec = repositorySource(path);
      expect(
        /^\s*test(?:\.describe)?\(/mu.test(spec),
        `${path} declares no test, so it is not coverage`,
      ).toBe(true);
      expect(spec, `${path} is not War Room coverage`).toContain("War Room");
      expect(
        spec,
        `${path} borrows the shared harness, so "dedicated" mislabels it`,
      ).not.toContain("investigation-strategy/conformance.js");
    }
  });
});
