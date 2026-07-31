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
import { parseImportPreviewReport } from "@contextdesk/contracts";
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
  /**
   * Identities that must be deselected to make the preview zero-importable.
   * The harness owner derives this from its fixture.
   */
  allImportableIdentities: string[];
  /** Two unresolved sources available for timezone review after a run. */
  unresolvedSources: [string, string];
};

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
      name: "preview satisfies the frozen import_preview_report contract",
      run: async () => {
        const client = harness.createClient();
        const report = await client.import.preview(harness.previewPath);
        // Round-trip through JSON so hidden non-wire values cannot pass.
        parseImportPreviewReport(JSON.parse(JSON.stringify(report)));
        assert(report.counts.total === report.items.length, "counts.total matches items");
      },
    },
    {
      name: "zero-importable selection is refused as invalid, not run",
      run: async () => {
        const client = harness.createClient();
        const events: WireProcessProgress[] = [];
        client.events.onProcessProgress((progress) => events.push(progress));
        await expectEngineError(
          client.import.run({
            path: harness.previewPath,
            deselected: harness.allImportableIdentities,
          }),
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
      name: "progress is truthful: fraction only on stream, one terminal phase",
      run: async () => {
        const client = harness.createClient();
        const events: WireProcessProgress[] = [];
        client.events.onProcessProgress((progress) => events.push(progress));
        await client.import.run({ path: harness.previewPath, deselected: [] });
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
        const running = client.import.run({ path: harness.previewPath, deselected: [] });
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
        const report = await client.import.run({ path: harness.previewPath, deselected: [] });
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
        const report = await client.import.run({ path: harness.previewPath, deselected: [] });
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
