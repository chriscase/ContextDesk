import { cleanup } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
