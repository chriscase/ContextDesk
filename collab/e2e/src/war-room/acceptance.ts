/**
 * Acceptance recorder for repeated War Room Computer Use runs.
 *
 * A browser journey proves something only if the same run, repeated next week
 * against a changed build, produces a comparable verdict. This recorder turns
 * each journey into a deterministic artifact: which declared usability
 * assertions were evaluated, which held, and — the part that matters most —
 * whether any declared assertion was quietly never evaluated at all.
 *
 * It fails closed in both directions:
 *
 * - An assertion id that is not in the catalog is an error, so a spec cannot
 *   invent a claim the reviewed catalog never made.
 * - A catalog assertion that the journey never reached is an error, so a spec
 *   cannot go green by skipping the hard half of its scenario.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WAR_ROOM_SCENARIOS, scenario, type ScenarioId, type WarRoomScenario } from "./scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ACCEPTANCE_DIR = join(here, "..", "..", "test-results", "war-room-acceptance");

export const ACCEPTANCE_REPORT_SCHEMA_ID = "cd-collab.war_room_acceptance.v1" as const;

export type AssertionOutcome = "passed" | "failed";

export interface AssertionResult {
  id: string;
  claim: string;
  failsWhen: string;
  outcome: AssertionOutcome;
  /** What the journey actually observed. Present on pass and on failure. */
  observed: string;
}

export interface ScenarioAcceptanceReport {
  schemaId: typeof ACCEPTANCE_REPORT_SCHEMA_ID;
  scenarioId: ScenarioId;
  ordinal: number;
  title: string;
  triageQuestion: string;
  expectedEvidence: string[];
  expectedProvenance: string[];
  expectedUnknowns: string[];
  usefulNextActions: string[];
  /** Deep links the journey actually visited, fully substituted. */
  deepLinksVisited: Array<{ id: string; purpose: string; url: string }>;
  assertions: AssertionResult[];
  outcome: AssertionOutcome;
}

/**
 * A single scenario's recording session. Created by `beginScenario`, closed by
 * `finish()`; the spec is responsible for calling `finish()` so an unevaluated
 * assertion is reported rather than silently dropped.
 */
export class ScenarioRecorder {
  private readonly results = new Map<string, AssertionResult>();
  private readonly visited: Array<{ id: string; purpose: string; url: string }> = [];

  constructor(private readonly definition: WarRoomScenario) {}

  get scenarioId(): ScenarioId {
    return this.definition.id;
  }

  /** Note that the journey landed on one of the scenario's declared addresses. */
  recordDeepLink(id: string, url: string): void {
    const target = this.definition.deepLinks.find((row) => row.id === id);
    if (!target) {
      throw new Error(`scenario ${this.definition.id} declares no deep link ${id}`);
    }
    this.visited.push({ id, purpose: target.purpose, url });
  }

  /**
   * Evaluate one declared usability assertion.
   *
   * `probe` should perform the Playwright expectations for the claim and return
   * a short description of what it actually saw. A throw is recorded as a
   * failure and re-thrown, so the Playwright report and the acceptance artifact
   * agree about what happened.
   */
  async check(id: string, probe: () => Promise<string>): Promise<void> {
    const declared = this.definition.assertions.find((row) => row.id === id);
    if (!declared) {
      throw new Error(`scenario ${this.definition.id} declares no assertion ${id}`);
    }
    if (this.results.has(id)) {
      throw new Error(`assertion ${id} was evaluated twice in scenario ${this.definition.id}`);
    }
    try {
      const observed = await probe();
      this.results.set(id, { ...declared, outcome: "passed", observed });
    } catch (error) {
      const observed = error instanceof Error ? error.message : String(error);
      this.results.set(id, { ...declared, outcome: "failed", observed });
      this.write();
      throw error;
    }
  }

  private report(): ScenarioAcceptanceReport {
    const assertions = this.definition.assertions.map(
      (declared): AssertionResult =>
        this.results.get(declared.id) ?? {
          ...declared,
          outcome: "failed",
          observed: "not evaluated by the journey",
        },
    );
    return {
      schemaId: ACCEPTANCE_REPORT_SCHEMA_ID,
      scenarioId: this.definition.id,
      ordinal: this.definition.ordinal,
      title: this.definition.title,
      triageQuestion: this.definition.triageQuestion,
      expectedEvidence: [...this.definition.expectedEvidence],
      expectedProvenance: [...this.definition.expectedProvenance],
      expectedUnknowns: [...this.definition.expectedUnknowns],
      usefulNextActions: [...this.definition.usefulNextActions],
      deepLinksVisited: [...this.visited],
      assertions,
      outcome: assertions.every((row) => row.outcome === "passed") ? "passed" : "failed",
    };
  }

  private write(): ScenarioAcceptanceReport {
    const report = this.report();
    mkdirSync(ACCEPTANCE_DIR, { recursive: true });
    writeFileSync(
      join(ACCEPTANCE_DIR, `${this.definition.id}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    return report;
  }

  /**
   * Write the artifact and fail closed on anything the journey did not reach:
   * an unevaluated assertion, or a declared deep link that was never opened.
   */
  finish(): ScenarioAcceptanceReport {
    const report = this.write();
    const missed = report.assertions.filter((row) => row.observed === "not evaluated by the journey");
    if (missed.length > 0) {
      throw new Error(
        `scenario ${this.definition.id} declared ${missed.length} assertion(s) its journey never evaluated: `
          + missed.map((row) => row.id).join(", "),
      );
    }
    const unvisited = this.definition.deepLinks
      .filter((row) => !this.visited.some((seen) => seen.id === row.id))
      .map((row) => row.id);
    if (unvisited.length > 0) {
      throw new Error(
        `scenario ${this.definition.id} declared deep link(s) its journey never opened: ${unvisited.join(", ")}`,
      );
    }
    return report;
  }
}

export function beginScenario(id: ScenarioId): ScenarioRecorder {
  return new ScenarioRecorder(scenario(id));
}

/** Catalog invariants, checked by the harness self-test and the repo script. */
export function catalogProblems(): string[] {
  const problems: string[] = [];
  const seenScenario = new Set<string>();
  const seenAssertion = new Set<string>();
  const seenOrdinal = new Set<number>();
  for (const row of WAR_ROOM_SCENARIOS) {
    if (seenScenario.has(row.id)) problems.push(`duplicate scenario id ${row.id}`);
    seenScenario.add(row.id);
    if (seenOrdinal.has(row.ordinal)) problems.push(`duplicate ordinal ${row.ordinal} on ${row.id}`);
    seenOrdinal.add(row.ordinal);
    if (row.assertions.length === 0) problems.push(`${row.id} declares no assertions`);
    if (row.deepLinks.length === 0) problems.push(`${row.id} declares no deep links`);
    if (row.expectedEvidence.length === 0) problems.push(`${row.id} declares no expected evidence`);
    if (row.expectedProvenance.length === 0) problems.push(`${row.id} declares no provenance`);
    if (row.expectedUnknowns.length === 0) problems.push(`${row.id} declares no unknowns`);
    if (row.usefulNextActions.length === 0) problems.push(`${row.id} declares no next actions`);
    if (!row.triageQuestion.trim().endsWith("?")) {
      problems.push(`${row.id} triageQuestion is not phrased as a question`);
    }
    for (const item of row.assertions) {
      if (seenAssertion.has(item.id)) problems.push(`duplicate assertion id ${item.id}`);
      seenAssertion.add(item.id);
      if (!item.failsWhen.trim()) problems.push(`assertion ${item.id} has no failsWhen`);
    }
  }
  const ordinals = WAR_ROOM_SCENARIOS.map((row) => row.ordinal).sort((a, b) => a - b);
  ordinals.forEach((value, index) => {
    if (value !== index + 1) problems.push(`ordinals are not contiguous from 1 (saw ${value} at position ${index + 1})`);
  });
  return problems;
}
