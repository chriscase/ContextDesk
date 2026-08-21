/**
 * Tauri adapter for the transport-neutral `EngineClient`.
 *
 * Lives in `src/lib/engine/` — the sanctioned host-boundary home — so the
 * import-flow UI never talks to `invoke` or Tauri events directly. Every
 * command result crosses as the host's camelCase wire shape; failures are
 * classified into `EngineError` codes without discarding the host message.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  parseCompiledTriagePolicyV2,
  parseTriageReplayV1,
  parseTriageRoleQualificationResultV1,
  parseTriageRunEventV2,
  type TriageReplayV1,
  type TriageRoleQualificationRequestV1,
  type TriageRoleQualificationResultV1,
  type TriageRunEventV2,
  type WireImportPreviewPlan,
  type WireProcessProgress,
} from "@contextdesk/contracts";
import {
  EngineError,
  classifyEngineMessage,
  hostImportFailure,
  type EngineClient,
  type EventRevisionReport,
  type ImportRunReport,
  type ImportRunRequest,
  type TriageService,
  type TimezoneApplyRequest,
  type TimezonePreview,
  type TimezoneState,
  type Unsubscribe,
} from "@contextdesk/client";

/** Minimal invoke/listen surface, injectable for deterministic tests. */
export type TauriTransport = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: (
    event: string,
    handler: (event: { payload: unknown }) => void,
  ) => Promise<() => void>;
};

const liveTransport: TauriTransport = {
  invoke: (command, args) => invoke(command, args),
  listen: (event, handler) => listen(event, handler),
};

function toEngineError(error: unknown): EngineError {
  const { message, outcome } = hostImportFailure(error);
  return new EngineError(classifyEngineMessage(message), message, outcome);
}

async function call<T>(
  transport: TauriTransport,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await transport.invoke<T>(command, args);
  } catch (error) {
    throw toEngineError(error);
  }
}

function parseTriageReplay(value: unknown): TriageReplayV1 {
  try {
    return parseTriageReplayV1(structuredClone(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EngineError("invalid", `invalid triage replay: ${message}`);
  }
}

function parseTriageEvent(value: unknown): TriageRunEventV2 {
  try {
    return parseTriageRunEventV2(structuredClone(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EngineError("failed", `invalid triage event from host: ${message}`);
  }
}

/**
 * Tauri adapter for the trusted host V2 runner.
 *
 * Rust owns policy selection, qualification, provider construction, packet
 * identity, validation, cancellation, and replay. TypeScript only validates
 * the returned DTOs and forwards the one ordered event stream.
 */
function createTauriTriageService(transport: TauriTransport): TriageService {
  const listeners = new Set<(event: TriageRunEventV2) => void>();
  let globalUnlisten: (() => void) | null = null;
  let globalListenPending: Promise<void> | null = null;

  const ensureGlobalListener = async (): Promise<void> => {
    if (globalUnlisten || globalListenPending) {
      return globalListenPending ?? Promise.resolve();
    }
    globalListenPending = transport
      .listen("triage-run-event", (event) => {
        const parsed = parseTriageEvent(event.payload);
        for (const listener of listeners) listener(parsed);
      })
      .then((stop) => {
        globalUnlisten = stop;
      })
      .finally(() => {
        globalListenPending = null;
      });
    return globalListenPending;
  };

  return {
    capability: {
      supported: true,
      replay: true,
    },
    preflight: async (request) => {
      const compiled = await call<unknown>(transport, "triage_preflight_v2", { request });
      try {
        return parseCompiledTriagePolicyV2(structuredClone(compiled));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EngineError("failed", `invalid triage preflight from host: ${message}`);
      }
    },
    qualify: async (
      request: TriageRoleQualificationRequestV1,
    ): Promise<TriageRoleQualificationResultV1> => {
      const result = await call<unknown>(transport, "triage_qualify_role_v2", { request });
      try {
        return parseTriageRoleQualificationResultV1(structuredClone(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EngineError("failed", `invalid triage role qualification from host: ${message}`);
      }
    },
    run: async (request, options = {}) => {
      if (options.signal?.aborted) {
        throw new EngineError("cancelled", "triage run cancelled before provider work");
      }
      const delivered = new Map<number, TriageRunEventV2>();
      const runListener = await transport.listen("triage-run-event", (event) => {
        const parsed = parseTriageEvent(event.payload);
        if (parsed.run_id !== request.run_id || delivered.has(parsed.sequence)) return;
        delivered.set(parsed.sequence, parsed);
        options.onEvent?.(parsed);
      });
      const abort = () => {
        void call<boolean>(transport, "triage_cancel_v2", {
          request: {
            schema_id: "contextdesk.triage.cancellation.v1",
            run_id: request.run_id,
            cancellation_id: request.cancellation_id,
          },
        });
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const replay = parseTriageReplay(
          await call<unknown>(transport, "triage_run_v2", { request }),
        );
        if (replay.run_id !== request.run_id) {
          throw new EngineError("failed", "triage replay run identity mismatch");
        }
        const terminal = replay.events.at(-1)!;
        const streamedTerminal = delivered.get(terminal.sequence);
        if (streamedTerminal) {
          return streamedTerminal;
        }
        options.onEvent?.(terminal);
        return terminal;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        runListener();
      }
    },
    replay: async (replay, options = {}) => {
      const parsedReplay = parseTriageReplay(replay);
      if (options.signal?.aborted) {
        throw new EngineError("cancelled", "triage replay consumption cancelled");
      }
      const delivered = new Set<number>();
      const stop = await transport.listen("triage-run-event", (event) => {
        const parsed = parseTriageEvent(event.payload);
        if (parsed.run_id !== parsedReplay.run_id || delivered.has(parsed.sequence)) return;
        delivered.add(parsed.sequence);
        options.onEvent?.(parsed);
      });
      try {
        const terminal = parseTriageEvent(
          await call<TriageRunEventV2>(transport, "triage_replay", {
            replay: parsedReplay,
          }),
        );
        if (terminal.run_id !== parsedReplay.run_id) {
          throw new EngineError("failed", "triage replay terminal run identity mismatch");
        }
        return terminal;
      } finally {
        stop?.();
      }
    },
    cancel: (request) =>
      call<boolean>(transport, "triage_cancel_v2", { request }),
    onRunEvent: (listener) => {
      listeners.add(listener);
      void ensureGlobalListener();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && globalUnlisten) {
          globalUnlisten();
          globalUnlisten = null;
        }
      };
    },
  };
}

/** Host ingest report shape (subset the flow consumes; camelCase wire). */
type HostIngestReport = ImportRunReport & Record<string, unknown>;

/** Create the Tauri-backed engine client. */
export function createTauriEngineClient(
  transport: TauriTransport = liveTransport,
): EngineClient {
  return {
    import: {
      preview: (path: string) =>
        call<WireImportPreviewPlan>(transport, "log_preview_import", { path }),
      run: async (request: ImportRunRequest): Promise<ImportRunReport> => {
        const report = await call<HostIngestReport>(transport, "log_run_import", {
          path: request.path,
          name: request.name ?? null,
          planToken: request.planToken,
          planVersion: request.planVersion,
          selected: request.selected,
          correlationId: request.correlationId ?? null,
        });
        return report;
      },
      cancel: () => call<boolean>(transport, "cancel_log_ingest"),
    },
    time: {
      state: (corpusId: string) =>
        call<TimezoneState>(transport, "log_load_timezone_state", { corpusId }),
      preview: (
        corpusId: string,
        eventRevision: number,
        source: string,
        ianaZone: string,
      ) =>
        call<TimezonePreview>(transport, "log_preview_source_timezone", {
          corpusId,
          eventRevision,
          source,
          ianaZone,
        }),
      applyMany: (
        corpusId: string,
        expectedRevision: number,
        requests: TimezoneApplyRequest[],
      ) =>
        call<EventRevisionReport>(transport, "log_apply_source_timezones", {
          corpusId,
          expectedRevision,
          requests,
        }),
      undo: (corpusId: string, expectedRevision: number) =>
        call<EventRevisionReport>(transport, "log_undo_event_revision", {
          corpusId,
          expectedRevision,
        }),
    },
    events: {
      onProcessProgress: (
        listener: (progress: WireProcessProgress) => void,
      ): Unsubscribe => {
        let disposed = false;
        let unlisten: (() => void) | null = null;
        void transport
          .listen("process-progress", (event) => {
            listener(event.payload as WireProcessProgress);
          })
          .then((stop) => {
            if (disposed) stop();
            else unlisten = stop;
          });
        return () => {
          disposed = true;
          if (unlisten) unlisten();
        };
      },
    },
    triage: createTauriTriageService(transport),
  };
}
