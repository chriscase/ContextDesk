/**
 * Tauri ADAPTER conformance — a mapping proof, not a host proof.
 *
 * The adapter runs the shared `engineClientConformance` suite against a
 * deterministic fake transport, which proves the adapter's argument mapping,
 * error-string classification, and event wiring hold the same behavioral
 * contract the mock satisfies. It does NOT execute the Rust commands: host
 * behavior (policy selection, qualification, packet construction, provider
 * execution, cancellation, cleanup) is proven by workflow/native tests and
 * the src-tauri source-contract tests that pin the command wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("live invoke must not be called in tests");
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  EngineError,
  MOCK_DECLARED_AT_UNIX_SECS,
  createMockEngineClient,
  defaultMockPreview,
  engineClientConformance,
} from "@contextdesk/client";
import { parseTriageReplayV1 } from "@contextdesk/contracts";
import type { TimezoneDeclaration } from "@contextdesk/client";
import { createTauriEngineClient, type TauriTransport } from "./tauriEngineClient";

const TRIAGE_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "fixtures", "triage-sdk", "v2",
);
const loadTriageReplay = () =>
  parseTriageReplayV1(
    JSON.parse(readFileSync(join(TRIAGE_FIXTURE_DIR, "replay.partial.json"), "utf8")),
  );

const IMPORTABLE_LOG_IDENTITIES = [
  "api/api-gateway.log",
  "api/payments.jsonl",
  "support.zip!/host-a.zip!/logs/app.log",
  "logs/console-fallback.log",
];

/**
 * Deterministic fake host: implements the command surface with the same
 * semantics contract as the Rust side, delegating the behavioral model to
 * the mock engine (which the conformance suite has already proven) while
 * exposing it through the raw command/event transport the adapter speaks.
 */
function createFakeTransport(): TauriTransport {
  const model = createMockEngineClient();
  const progressListeners = new Set<(event: { payload: unknown }) => void>();
  const triageListeners = new Set<(event: { payload: unknown }) => void>();
  model.events.onProcessProgress((progress) => {
    for (const listener of progressListeners) listener({ payload: progress });
  });
  model.triage.onRunEvent((event) => {
    for (const listener of triageListeners) listener({ payload: event });
  });
  const rethrowAsHostString = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch (error) {
      // The host rejects with a plain string message, not an Error.
      throw error instanceof Error ? error.message : String(error);
    }
  };
  return {
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      switch (command) {
        case "log_preview_import":
          return rethrowAsHostString(
            model.import.preview(args!.path as string),
          ) as Promise<T>;
        case "log_run_import":
          return rethrowAsHostString(
            model.import.run({
              path: args!.path as string,
              name: (args!.name as string | null) ?? undefined,
              planToken: args!.planToken as string,
              planVersion: args!.planVersion as number,
              selected: args!.selected as string[],
            }),
          ) as Promise<T>;
        case "cancel_log_ingest":
          return rethrowAsHostString(model.import.cancel()) as Promise<T>;
        case "triage_preflight_v2":
          return rethrowAsHostString(
            model.triage.preflight(args!.request as never),
          ) as Promise<T>;
        case "triage_run_v2":
          return rethrowAsHostString(
            model.triage.run(args!.request as never),
          ) as Promise<T>;
        case "triage_cancel_v2":
          return rethrowAsHostString(
            model.triage.cancel(args!.request as never),
          ) as Promise<T>;
        case "triage_replay": {
          return rethrowAsHostString(
            model.triage.replay(parseTriageReplayV1(structuredClone(args!.replay))),
          ) as Promise<T>;
        }
        case "log_load_timezone_state":
          return rethrowAsHostString(
            model.time.state(args!.corpusId as string),
          ) as Promise<T>;
        case "log_preview_source_timezone":
          return rethrowAsHostString(
            model.time.preview(
              args!.corpusId as string,
              args!.eventRevision as number,
              args!.source as string,
              args!.ianaZone as string,
            ),
          ) as Promise<T>;
        case "log_apply_source_timezones":
          return rethrowAsHostString(
            model.time.applyMany(
              args!.corpusId as string,
              args!.expectedRevision as number,
              args!.requests as never,
            ),
          ) as Promise<T>;
        case "log_undo_event_revision":
          return rethrowAsHostString(
            model.time.undo(args!.corpusId as string, args!.expectedRevision as number),
          ) as Promise<T>;
        default:
          throw `unknown command: ${command}`;
      }
    },
    listen: async (event, handler) => {
      if (event === "triage-run-event") {
        triageListeners.add(handler);
        return () => triageListeners.delete(handler);
      }
      if (event !== "process-progress") throw new Error(`unexpected event: ${event}`);
      progressListeners.add(handler);
      return () => progressListeners.delete(handler);
    },
  };
}

describe("tauri engine adapter conformance", () => {
  const checks = engineClientConformance({
    createClient: () => createTauriEngineClient(createFakeTransport()),
    previewPath: "/incidents/checkout-outage",
    allImportableIdentities: IMPORTABLE_LOG_IDENTITIES,
    nonEventIdentity: "metrics/gateway-metrics.json",
    unresolvedSources: ["api/api-gateway.log", "support.zip!/host-a.zip!/logs/app.log"],
  });

  for (const check of checks) {
    it(check.name, async () => {
      await check.run();
    });
  }
});

describe("tauri engine adapter mapping", () => {
  it("reports the live triage host capability and rejects malformed requests", async () => {
    const transport = createFakeTransport();
    const client = createTauriEngineClient(transport);
    expect(client.triage.capability.supported).toBe(true);
    await expect(client.triage.preflight({} as never)).rejects.toMatchObject({
      name: "EngineError",
      code: "failed",
    });
  });

  it("accepts a host-authored replay and forwards the shared event stream", async () => {
    const transport = createFakeTransport();
    const client = createTauriEngineClient(transport);
    const replay = loadTriageReplay();
    const subscribed: unknown[] = [];
    const delivered: unknown[] = [];
    client.triage.onRunEvent((event) => subscribed.push(event));
    const terminal = await client.triage.replay(replay, {
      onEvent: (event) => delivered.push(event),
    });
    expect(client.triage.capability).toMatchObject({ supported: true, replay: true });
    expect(delivered).toEqual(replay.events);
    expect(subscribed).toEqual(replay.events);
    expect(terminal).toEqual(replay.events.at(-1));
  });

  it("rejects malformed replay before invoking the Tauri command", async () => {
    let invoked = false;
    const transport: TauriTransport = {
      invoke: async () => {
        invoked = true;
        throw "unreachable";
      },
      listen: async () => () => {},
    };
    const client = createTauriEngineClient(transport);
    await expect(client.triage.replay({} as never)).rejects.toMatchObject({
      name: "EngineError",
      code: "invalid",
    });
    expect(invoked).toBe(false);
  });

  it("classifies host string rejections into EngineError codes", async () => {
    const transport: TauriTransport = {
      invoke: async () => {
        throw "stale timezone apply: expected revision 1, current 2";
      },
      listen: async () => () => {},
    };
    const client = createTauriEngineClient(transport);
    await expect(client.time.applyMany("c", 1, [])).rejects.toMatchObject({
      name: "EngineError",
      code: "conflict",
    });
  });

  it("attaches a classified outcome from a structured host rejection", async () => {
    const outcome = {
      schemaId: "contextdesk.import_outcome.v1",
      schemaVersion: 1,
      class: "rejected",
      published: false,
      counts: {
        sourcesDiscovered: 1,
        sourcesImported: 0,
        sourcesFailed: 1,
        sourcesExcluded: 0,
        sourcesIgnored: 0,
        recordsImported: 0,
        recordsMalformed: 0,
      },
      defects: [
        {
          code: "archive_unreadable",
          severity: "fatal",
          source: {
            identity: "bundles/inner.zip",
            archiveChain: ["bundles"],
            member: "inner.zip",
            archiveDepth: 1,
          },
          occurrences: 1,
        },
      ],
      defectCounts: { archive_unreadable: 1 },
      privacy: {
        redactionMode: "identity_structural_only",
        policySummary: "structural identity only",
        defectsTruncated: false,
      },
      manifestDigest: "sha256:rejected",
    };
    const transport: TauriTransport = {
      invoke: async () => {
        throw { message: "zip open: missing end record", outcome };
      },
      listen: async () => () => {},
    };
    const client = createTauriEngineClient(transport);
    await expect(
      client.import.run({
        path: "/tmp/outer.zip",
        planToken: "t",
        planVersion: 1,
        selected: ["a.log"],
      }),
    ).rejects.toMatchObject({
      name: "EngineError",
      message: "zip open: missing end record",
      outcome: { class: "rejected", published: false },
    });
  });

  it("passes command arguments through with host casing", async () => {
    const invocations: [string, Record<string, unknown> | undefined][] = [];
    const transport: TauriTransport = {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        invocations.push([command, args]);
        if (command === "log_preview_import") {
          return {
            report: defaultMockPreview(),
            planToken: "t",
            planVersion: 1,
          } as T;
        }
        throw "unreachable";
      },
      listen: async () => () => {},
    };
    const client = createTauriEngineClient(transport);
    await client.import.preview("/roots/logs");
    expect(invocations).toEqual([["log_preview_import", { path: "/roots/logs" }]]);
  });

  it("unsubscribing before the listener resolves never leaks a subscription", async () => {
    let stopped = 0;
    let resolveListen: (stop: () => void) => void = () => {};
    const transport: TauriTransport = {
      invoke: async () => {
        throw "unused";
      },
      listen: () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    };
    const client = createTauriEngineClient(transport);
    const unsubscribe = client.events.onProcessProgress(() => {});
    unsubscribe();
    resolveListen(() => {
      stopped += 1;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(1);
  });

  it("exposes the fixed mock declaration timestamp for deterministic assertions", () => {
    const declaration: TimezoneDeclaration = {
      source: "api/api-gateway.log",
      ianaZone: "America/Chicago",
      basis: "user_declared",
      declaredAt: MOCK_DECLARED_AT_UNIX_SECS,
      appliedRevision: 2,
    };
    expect(EngineError.name).toBe("EngineError");
    expect(declaration.declaredAt).toBe(1_782_864_000);
  });
});
