/**
 * Adapter conformance suite.
 *
 * A single behavioral contract every `EngineClient` adapter must satisfy —
 * the mock proves the suite, the Tauri adapter proves the suite against a
 * deterministic fake host, and (when it exists) an HTTP adapter joins the
 * same suite. Checks assert engine-boundary truths the UI relies on:
 * schema-valid previews, the trusted zero-importable refusal, #824 progress
 * honesty, cancellation, and atomic stale-guarded timezone application.
 */
import { parseImportPreviewPlan } from "@contextdesk/contracts";
import type { WireProcessProgress } from "@contextdesk/contracts";
import { EngineError, type EngineClient } from "./engine";

/** One named conformance check. */
export type ConformanceCheck = {
  name: string;
  run: () => Promise<void>;
};

/** Inputs the suite needs from the adapter under test. */
export type ConformanceHarness = {
  /** Fresh client per check. */
  createClient: () => EngineClient;
  /** A previewable root path (interpreted by the adapter's fake or mock). */
  previewPath: string;
  /** Every identity the preview offers as event-importable, in report order. */
  allImportableIdentities: string[];
  /** An identity the preview lists that must never import as events. */
  nonEventIdentity: string;
  /** Two unresolved sources available for timezone review after a run. */
  unresolvedSources: [string, string];
};

async function runWithPlan(
  client: EngineClient,
  harness: ConformanceHarness,
  selected?: string[],
) {
  const plan = await client.import.preview(harness.previewPath);
  return client.import.run({
    path: harness.previewPath,
    planToken: plan.planToken,
    planVersion: plan.planVersion,
    selected: selected ?? harness.allImportableIdentities,
  });
}

function assert(condition: boolean, detail: string): void {
  if (!condition) throw new Error(`conformance: ${detail}`);
}

async function expectEngineError(
  operation: Promise<unknown>,
  code: EngineError["code"],
  detail: string,
): Promise<EngineError> {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof EngineError, `${detail}: threw non-EngineError ${String(error)}`);
    const engineError = error as EngineError;
    assert(
      engineError.code === code,
      `${detail}: expected code ${code}, got ${engineError.code} (${engineError.message})`,
    );
    return engineError;
  }
  throw new Error(`conformance: ${detail}: resolved instead of rejecting`);
}

/** Build the conformance checks for one adapter harness. */
export function engineClientConformance(harness: ConformanceHarness): ConformanceCheck[] {
  return [
    {
      name: "preview satisfies the frozen import_preview_plan contract",
      run: async () => {
        const client = harness.createClient();
        const plan = await client.import.preview(harness.previewPath);
        // Round-trip through JSON so hidden non-wire values cannot pass.
        parseImportPreviewPlan(JSON.parse(JSON.stringify(plan)));
        assert(
          plan.report.counts.total === plan.report.items.length,
          "counts.total matches items",
        );
        assert(plan.planToken.length > 0, "plan token present");
      },
    },
    {
      name: "zero-importable selection is refused as invalid, not run",
      run: async () => {
        const client = harness.createClient();
        const events: WireProcessProgress[] = [];
        client.events.onProcessProgress((progress) => events.push(progress));
        await expectEngineError(
          runWithPlan(client, harness, []),
          "invalid",
          "zero-importable run",
        );
        assert(
          !events.some((event) => event.phase === "completed" || event.phase === "publish"),
          "no publish/completed progress may be emitted for a refused run",
        );
      },
    },
    {
      name: "a stale plan token is refused before any progress",
      run: async () => {
        const client = harness.createClient();
        const events: WireProcessProgress[] = [];
        client.events.onProcessProgress((progress) => events.push(progress));
        const error = await expectEngineError(
          client.import.run({
            path: harness.previewPath,
            planToken: "tampered",
            planVersion: 1,
            selected: harness.allImportableIdentities,
          }),
          "conflict",
          "stale-plan run",
        );
        assert(error.message.includes("stale"), "stale plans say so plainly");
        assert(events.length === 0, "a refused plan emits no progress at all");
      },
    },
    {
      name: "selecting non-event content is refused — supporting never becomes events",
      run: async () => {
        const client = harness.createClient();
        await expectEngineError(
          runWithPlan(client, harness, [
            harness.allImportableIdentities[0]!,
            harness.nonEventIdentity,
          ]),
          "invalid",
          "role-confusion run",
        );
      },
    },
    {
      name: "progress is truthful: fraction only on stream, one terminal phase",
      run: async () => {
        const client = harness.createClient();
        const events: WireProcessProgress[] = [];
        client.events.onProcessProgress((progress) => events.push(progress));
        await runWithPlan(client, harness);
        assert(events.length > 0, "a run emits progress");
        const terminal = events.filter((event) =>
          ["completed", "failed", "cancelled"].includes(event.phase),
        );
        assert(
          terminal.length === 1 && terminal[0]!.phase === "completed",
          "exactly one terminal phase, completed",
        );
        for (const event of events) {
          if (event.phase !== "stream") {
            assert(
              event.fraction === null || event.fraction === undefined,
              `fraction is stream-only; found on ${event.phase}`,
            );
          }
        }
        const last = events[events.length - 1]!;
        assert(last.phase === "completed", "terminal phase arrives last");
      },
    },
    {
      name: "cancellation rejects as cancelled and never completes",
      run: async () => {
        const client = harness.createClient();
        const events: WireProcessProgress[] = [];
        client.events.onProcessProgress((progress) => events.push(progress));
        const plan = await client.import.preview(harness.previewPath);
        const running = client.import.run({
          path: harness.previewPath,
          planToken: plan.planToken,
          planVersion: plan.planVersion,
          selected: harness.allImportableIdentities,
        });
        await client.import.cancel();
        await expectEngineError(running, "cancelled", "cancelled run");
        assert(
          !events.some((event) => event.phase === "completed"),
          "no completed progress after cancellation",
        );
      },
    },
    {
      name: "stale preview token fails the whole timezone apply atomically",
      run: async () => {
        const client = harness.createClient();
        const report = await runWithPlan(client, harness);
        const state = await client.time.state(report.corpusId);
        const [first, second] = harness.unresolvedSources;
        const good = await client.time.preview(
          report.corpusId,
          state.eventRevision,
          first,
          "America/Chicago",
        );
        await expectEngineError(
          client.time.applyMany(report.corpusId, state.eventRevision, [
            { source: first, ianaTimezone: "America/Chicago", previewToken: good.previewToken },
            { source: second, ianaTimezone: "Europe/Berlin", previewToken: "tampered" },
          ]),
          "conflict",
          "apply with one tampered token",
        );
        const after = await client.time.state(report.corpusId);
        assert(
          after.eventRevision === state.eventRevision &&
            Object.keys(after.declarations).length === 0,
          "nothing applied after a rejected multi-source apply",
        );
      },
    },
    {
      name: "multi-source apply is one revision; undo publishes forward and clears",
      run: async () => {
        const client = harness.createClient();
        const report = await runWithPlan(client, harness);
        const state = await client.time.state(report.corpusId);
        const [first, second] = harness.unresolvedSources;
        const previews = await Promise.all([
          client.time.preview(report.corpusId, state.eventRevision, first, "America/Chicago"),
          client.time.preview(report.corpusId, state.eventRevision, second, "Europe/Berlin"),
        ]);
        const applied = await client.time.applyMany(report.corpusId, state.eventRevision, [
          {
            source: first,
            ianaTimezone: "America/Chicago",
            previewToken: previews[0]!.previewToken,
          },
          {
            source: second,
            ianaTimezone: "Europe/Berlin",
            previewToken: previews[1]!.previewToken,
          },
        ]);
        assert(
          applied.revision === state.eventRevision + 1,
          "both sources land in exactly one new revision",
        );
        const appliedState = await client.time.state(report.corpusId);
        assert(
          Object.keys(appliedState.declarations).length === 2,
          "both declarations durable after apply",
        );
        const undone = await client.time.undo(report.corpusId, applied.revision);
        assert(undone.revision === applied.revision + 1, "undo publishes forward");
        const cleared = await client.time.state(report.corpusId);
        assert(
          Object.keys(cleared.declarations).length === 0,
          "declarations cleared after undo",
        );
      },
    },
  ];
}
