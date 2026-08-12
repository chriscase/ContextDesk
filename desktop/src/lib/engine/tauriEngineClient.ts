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
import type { WireImportPreviewPlan, WireProcessProgress } from "@contextdesk/contracts";
import {
  EngineError,
  classifyEngineMessage,
  unsupportedTriageService,
  type EngineClient,
  type EventRevisionReport,
  type ImportRunReport,
  type ImportRunRequest,
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
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  return new EngineError(classifyEngineMessage(message), message);
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
    // Provider-free contracts exist, but no production Tauri command is
    // shipped yet. Keep this explicit and fail closed rather than inventing a
    // renderer-side compiler or silently bypassing the trusted host.
    triage: unsupportedTriageService(
      "triage namespace is not wired to the production Tauri host",
    ),
  };
}
