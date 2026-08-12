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
import type {
  CompiledTriagePolicyV2,
  TriageCancellationV1,
  TriageReplayV1,
  TriageRequestV2,
  WireProcessProgress,
} from "@contextdesk/contracts";
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

/** Inputs for the optional triage adapter conformance suite. */
export type TriageConformanceHarness = {
  /** Fresh supported adapter with the exact scripted host responses. */
  createClient: () => EngineClient;
  /** Same adapter, parked before delivery so exact cancellation can win. */
  createCancellableClient: () => EngineClient;
  /** Fresh adapter that explicitly reports the namespace unsupported. */
  createUnsupportedClient: () => EngineClient;
  request: TriageRequestV2;
  preflight: CompiledTriagePolicyV2;
  replay: TriageReplayV1;
  cancelledReplay: TriageReplayV1;
  cancellation: TriageCancellationV1;
};

function terminalKind(replay: TriageReplayV1): unknown {
  return replay.events.at(-1)?.event.kind;
}

/** Provider-free conformance for policy-preflight and ordered run/replay adapters. */
export function triageClientConformance(
  harness: TriageConformanceHarness,
): ConformanceCheck[] {
  return [
    {
      name: "triage capability and preflight return the exact host plan",
      run: async () => {
        const client = harness.createClient();
        assert(client.triage.capability.supported, "triage capability is explicit");
        const plan = await client.triage.preflight(harness.request);
        assert(
          JSON.stringify(plan) === JSON.stringify(harness.preflight),
          "preflight is the host response, not a TypeScript recompilation",
        );
      },
    },
    {
      name: "triage run emits ordered shared events and an honest partial terminal",
      run: async () => {
        const client = harness.createClient();
        const direct: TriageReplayV1["events"] = [];
        const subscribed: TriageReplayV1["events"] = [];
        client.triage.onRunEvent((event) => subscribed.push(event));
        const terminal = await client.triage.run(harness.request, {
          onEvent: (event) => direct.push(event),
        });
        assert(JSON.stringify(direct) === JSON.stringify(harness.replay.events), "run order");
        assert(JSON.stringify(subscribed) === JSON.stringify(direct), "one shared event stream");
        assert(terminal === direct.at(-1), "returned terminal is the emitted terminal object");
        assert(terminalKind(harness.replay) === "completed", "normal fixture completes");
        const result = terminal.event.result as Record<string, unknown>;
        assert(result.kind === "honest_partial", "partial is not promoted to final");
      },
    },
    {
      name: "triage replay consumes the same bytes without reordering",
      run: async () => {
        const client = harness.createClient();
        const events: TriageReplayV1["events"] = [];
        const terminal = await client.triage.replay(harness.replay, {
          onEvent: (event) => events.push(event),
        });
        assert(JSON.stringify(events) === JSON.stringify(harness.replay.events), "replay order");
        assert(terminal.sequence === events.length - 1, "terminal sequence is last");
      },
    },
    {
      name: "pre-abort and active cancel retain the host-authored partial terminal",
      run: async () => {
        const aborted = harness.createClient();
        const controller = new AbortController();
        controller.abort();
        const abortEvents: TriageReplayV1["events"] = [];
        const abortTerminal = await aborted.triage.run(harness.request, {
          signal: controller.signal,
          onEvent: (event) => abortEvents.push(event),
        });
        assert(abortTerminal.event.kind === "cancelled", "abort terminal is cancelled");
        assert(
          (abortTerminal.event.partial_result as Record<string, unknown>).kind ===
            "honest_partial",
          "abort preserves honest partial",
        );

        const active = harness.createCancellableClient();
        const running = active.triage.run(harness.request);
        assert(await active.triage.cancel(harness.cancellation), "exact active cancel accepted");
        const cancelTerminal = await running;
        assert(cancelTerminal.event.kind === "cancelled", "active cancel terminal");
        assert(
          JSON.stringify(cancelTerminal) ===
            JSON.stringify(harness.cancelledReplay.events.at(-1)),
          "cancel terminal is host-authored fixture",
        );
      },
    },
    {
      name: "unsupported triage is visible and fails with a typed error",
      run: async () => {
        const client = harness.createUnsupportedClient();
        assert(!client.triage.capability.supported, "unsupported status is explicit");
        await expectEngineError(
          client.triage.preflight(harness.request),
          "unsupported",
          "unsupported triage preflight",
        );
      },
    },
    {
      name: "owner-only terminal content cannot be relabelled share-safe",
      run: async () => {
        const client = harness.createClient();
        const forged = structuredClone(harness.replay);
        forged.events[forged.events.length - 1]!.privacy = "share_safe";
        let rejected = false;
        try {
          await client.triage.replay(forged);
        } catch {
          rejected = true;
        }
        assert(rejected, "privacy relabel is rejected before delivery");
      },
    },
  ];
}
