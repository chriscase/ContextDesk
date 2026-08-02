/**
 * The unified import flow — one component, two entry skins.
 *
 * The Logs pane renders it inline; guided setup embeds the same component
 * inside its wizard step. The ordinary path is deliberately short: choose
 * input → "Ready to import" → Import. The selector appears only when the
 * preview forces a decision or the user asks for it; timezone review is a
 * non-blocking card on the summary, after atomic publication.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { EngineClient } from "@contextdesk/client";
import { EngineError } from "@contextdesk/client";
import { openDirectoryDialog, openFileDialog } from "../../lib/dialogs";
import { ProcessProgressPanel } from "../wizards/ProcessProgressPanel";
import type { ProcessProgressDto } from "../wizards/types";
import { EvidenceSelector } from "./EvidenceSelector";
import { TimeReviewCard } from "./TimeReviewCard";
import {
  INITIAL_IMPORT_FLOW_STATE,
  importDisabledReason,
  importFlowReducer,
  selectedForRun,
  selectedImportableCount,
  type ImportFlowState,
} from "./importFlowState";

type Props = {
  engine: EngineClient;
  /** Pane renders headers/actions inline; guided fits the wizard body. */
  variant: "pane" | "guided";
  /** Called after atomic publication with the new corpus id. */
  onPublished?: (corpusId: string) => void;
  /** Called after the summary card applies or undoes source timezones. */
  onTimezoneChanged?: (corpusId: string) => void;
  /**
   * Monotonic close-request signal from the hosting surface (wizard Cancel,
   * Escape). Outside a run the flow exits immediately; during a run it
   * requests cancellation and stays truthfully visible until the engine
   * acknowledges. `onExit` fires exactly when leaving is safe.
   */
  exitSignal?: number;
  onExit?: () => void;
  /** Fixture start state for visual tests and previews. Never set in product code. */
  initialState?: ImportFlowState;
};

export function ImportFlow({
  engine,
  variant,
  onPublished,
  onTimezoneChanged,
  exitSignal = 0,
  onExit,
  initialState,
}: Props) {
  const [state, dispatch] = useReducer(
    importFlowReducer,
    initialState ?? INITIAL_IMPORT_FLOW_STATE,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [previewExitRequested, setPreviewExitRequested] = useState(false);
  const [previewCancelError, setPreviewCancelError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mountedRef = useRef(true);
  const previewActiveRef = useRef(false);
  const previewExitRequestedRef = useRef(false);
  const previewExitAcknowledgedRef = useRef(false);
  const previewCancelRequestedRef = useRef(false);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    return engine.events.onProcessProgress((progress) => {
      if (progress.kind !== "log_ingest") return;
      dispatch({ type: "PROGRESS", progress });
    });
  }, [engine]);

  // Close requests: outside active engine work exit immediately; during preview
  // or import request cancellation and stay visible until the operation itself
  // settles. `cancel()` only acknowledges the request, not worker termination,
  // so the preview promise is the safe-to-close acknowledgement.
  const lastExitSignal = useRef(exitSignal);
  useEffect(() => {
    if (exitSignal === lastExitSignal.current) return;
    lastExitSignal.current = exitSignal;
    if (previewActiveRef.current) {
      previewExitRequestedRef.current = true;
      setPreviewExitRequested(true);
      if (!previewCancelRequestedRef.current) {
        previewCancelRequestedRef.current = true;
        void engine.import.cancel().catch((error: unknown) => {
          if (!mountedRef.current || !previewActiveRef.current) return;
          setPreviewCancelError(error instanceof Error ? error.message : String(error));
        });
      }
      return;
    }
    if (stateRef.current.stage !== "running") {
      onExit?.();
      return;
    }
    dispatch({ type: "EXIT_REQUESTED" });
    void engine.import.cancel();
  }, [exitSignal, engine, onExit]);

  // Acknowledgement: once a requested exit sees the run reach any terminal
  // state — cancelled, failed, or published — leaving is safe.
  useEffect(() => {
    if (!state.exitRequested) return;
    if (
      state.stage === "run_cancelled" ||
      state.stage === "run_failed" ||
      state.stage === "summary"
    ) {
      onExit?.();
    }
  }, [state.exitRequested, state.stage, onExit]);

  // Unmount while engine work is still live (App-level teardown): request
  // cancellation as a backstop and suppress every late preview state update.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (previewActiveRef.current && !previewCancelRequestedRef.current) {
        previewCancelRequestedRef.current = true;
        void engine.import.cancel().catch(() => undefined);
      }
      if (stateRef.current.stage === "running") {
        void engine.import.cancel();
      }
    };
  }, [engine]);

  const choose = async (kind: "directory" | "file") => {
    const path =
      kind === "directory"
        ? await openDirectoryDialog("Choose log folder")
        : await openFileDialog("Choose log file or ZIP", [
            { name: "Logs", extensions: ["log", "txt", "json", "jsonl", "zip"] },
          ]);
    if (!path) return;
    dispatch({ type: "PATH_CHOSEN", path });
    previewActiveRef.current = true;
    previewExitRequestedRef.current = false;
    previewExitAcknowledgedRef.current = false;
    previewCancelRequestedRef.current = false;
    setPreviewExitRequested(false);
    setPreviewCancelError(null);
    try {
      const plan = await engine.import.preview(path);
      if (!mountedRef.current || previewExitRequestedRef.current) return;
      dispatch({ type: "PREVIEW_OK", plan });
    } catch (error) {
      if (!mountedRef.current || previewExitRequestedRef.current) return;
      dispatch({
        type: "PREVIEW_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      previewActiveRef.current = false;
      if (
        mountedRef.current &&
        previewExitRequestedRef.current &&
        !previewExitAcknowledgedRef.current
      ) {
        previewExitAcknowledgedRef.current = true;
        onExitRef.current?.();
      }
    }
  };

  const runImport = async () => {
    const current = stateRef.current;
    if (importDisabledReason(current) !== null || !current.path || !current.plan) return;
    dispatch({ type: "RUN_STARTED" });
    try {
      const report = await engine.import.run({
        path: current.path,
        name: current.corpusName.trim() || undefined,
        planToken: current.plan.planToken,
        planVersion: current.plan.planVersion,
        selected: selectedForRun(current),
      });
      dispatch({ type: "PUBLISHED", report });
      onPublished?.(report.corpusId);
    } catch (error) {
      if (error instanceof EngineError && error.code === "cancelled") {
        dispatch({ type: "RUN_CANCELLED" });
      } else {
        dispatch({
          type: "RUN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const disabledReason = importDisabledReason(state);
  const report = state.report;
  const counts = report?.counts;
  const importableSelected = selectedImportableCount(state);
  const needReviewCount = useMemo(() => {
    if (!report) return 0;
    return report.items.filter(
      (item) => item.status === "review" && state.selected.has(item.identity),
    ).length;
  }, [report, state.selected]);
  const unresolvedTime = state.runReport
    ? state.runReport.confidence.counts.unresolved
    : 0;

  return (
    <div className={`import-flow import-flow--${variant}`}>
      {state.stage === "choose" ? (
        <section className="import-flow__choose" aria-label="Choose input">
          <p className="import-flow__lead">
            Import log files, folders, or ZIP archives into a disposable analysis corpus.
            Secrets are redacted before anything is stored.
          </p>
          <div className="import-flow__choose-actions">
            <button type="button" className="import-flow__primary" onClick={() => void choose("directory")}>
              Choose folder…
            </button>
            <button type="button" onClick={() => void choose("file")}>
              Choose file or ZIP…
            </button>
          </div>
        </section>
      ) : null}

      {state.stage === "previewing" ? (
        <p className="import-flow__status" role="status">
          {previewExitRequested
            ? previewCancelError
              ? `Could not request preview cancellation (${previewCancelError}). Waiting for the preview to finish safely…`
              : "Cancelling preview — waiting for the engine to acknowledge…"
            : "Looking at what’s inside… nothing is imported yet."}
        </p>
      ) : null}

      {state.stage === "preview_failed" ? (
        <section className="import-flow__error-panel" role="alert">
          <p>Could not read this selection: {state.error}</p>
          <div className="import-flow__row">
            <button type="button" onClick={() => dispatch({ type: "BACK" })}>
              Choose something else
            </button>
          </div>
        </section>
      ) : null}

      {state.stage === "preflight" && report && counts ? (
        <section className="import-flow__preflight" aria-label="Ready to import">
          <header className="import-flow__preflight-head">
            <strong>
              Ready to import — {importableSelected} source
              {importableSelected === 1 ? "" : "s"}
            </strong>
            <span className="import-flow__chips">
              {counts.ready > 0 ? <span className="import-selector__chip import-selector__chip--ready">{counts.ready} ready</span> : null}
              {counts.review > 0 ? <span className="import-selector__chip import-selector__chip--review">{counts.review} review</span> : null}
              {counts.rawFallback > 0 ? <span className="import-selector__chip import-selector__chip--raw_fallback">{counts.rawFallback} raw</span> : null}
              {counts.blocked > 0 ? <span className="import-selector__chip import-selector__chip--blocked">{counts.blocked} blocked</span> : null}
            </span>
          </header>
          <dl className="import-flow__facts">
            <dt>Will import as log events</dt>
            <dd>
              {importableSelected} source{importableSelected === 1 ? "" : "s"}
              {needReviewCount > 0
                ? ` (${needReviewCount} with uncertain formats — reviewable after import)`
                : ""}
            </dd>
            <dt>Kept out</dt>
            <dd>
              {counts.ignored + counts.unsupported + counts.blocked} item
              {counts.ignored + counts.unsupported + counts.blocked === 1 ? "" : "s"} — every
              one listed with its reason under Review selection
            </dd>
            <dt>Corpus name</dt>
            <dd>
              <input
                className="import-flow__name"
                value={state.corpusName}
                aria-label="Corpus name"
                onChange={(event) => dispatch({ type: "NAME_CHANGED", name: event.target.value })}
              />
            </dd>
          </dl>
          <label className="import-flow__confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand and want to proceed (SoftWrite Accept)
          </label>
          <div className="import-flow__row">
            <button type="button" className="import-flow__ghost" onClick={() => dispatch({ type: "OPEN_SELECTOR" })}>
              Review selection…
            </button>
            <span className="import-flow__spacer" />
            <button type="button" onClick={() => dispatch({ type: "BACK" })}>
              Back
            </button>
            <button
              type="button"
              className="import-flow__primary"
              disabled={disabledReason !== null || !confirmed}
              aria-describedby="import-flow-disabled-reason"
              onClick={() => void runImport()}
            >
              Import
            </button>
          </div>
          {disabledReason || !confirmed ? (
            <p className="import-flow__reason" id="import-flow-disabled-reason">
              {disabledReason ?? "Tick the SoftWrite confirmation to enable Import."}
            </p>
          ) : null}
          <p className="import-flow__hint">
            Importing publishes one corpus atomically. Cancel or failure before publication
            leaves nothing in the library.
          </p>
        </section>
      ) : null}

      {state.stage === "selector" && report ? (
        <>
          <EvidenceSelector report={report} selected={state.selected} dispatch={dispatch} />
          <div className="import-flow__row">
            <span className="import-flow__spacer" />
            <button type="button" onClick={() => dispatch({ type: "CLOSE_SELECTOR" })}>
              Done
            </button>
          </div>
          {disabledReason ? (
            <p className="import-flow__reason">{disabledReason}</p>
          ) : null}
        </>
      ) : null}

      {state.stage === "running" ? (
        <>
          <ProcessProgressPanel
            progress={(state.progress as ProcessProgressDto | null) ?? null}
            kind="log_ingest"
            error={null}
            onCancel={() => {
              void engine.import.cancel();
            }}
          />
          {state.exitRequested ? (
            <p className="import-flow__reason" role="status">
              {state.progress && state.progress.cancellable === false
                ? "Publication is in progress and cannot be cancelled. This stays visible until it completes."
                : "Cancelling — waiting for the engine to acknowledge…"}
            </p>
          ) : null}
        </>
      ) : null}

      {state.stage === "run_failed" ? (
        <section className="import-flow__error-panel" role="alert">
          <p>Import failed: {state.error}</p>
          <p className="import-flow__hint">
            Nothing was published — the library is unchanged.
          </p>
          <div className="import-flow__row">
            <button type="button" onClick={() => dispatch({ type: "RETRY" })}>
              Back to review
            </button>
          </div>
        </section>
      ) : null}

      {state.stage === "run_cancelled" ? (
        <section className="import-flow__error-panel" role="status">
          <p>Import cancelled. Nothing was published — the library is unchanged.</p>
          <div className="import-flow__row">
            <button type="button" onClick={() => dispatch({ type: "RETRY" })}>
              Back to review
            </button>
          </div>
        </section>
      ) : null}

      {state.stage === "summary" && state.runReport ? (
        <section className="import-flow__summary" aria-label="Import finished">
          <p className="import-flow__done" role="status">
            Import finished — corpus {state.runReport.corpusId}.{" "}
            {state.runReport.lines.toLocaleString()} events from {state.runReport.files}{" "}
            source{state.runReport.files === 1 ? "" : "s"}.
            {state.runReport.ignoredFiles > 0
              ? ` ${state.runReport.ignoredFiles} kept out — counted, never silent.`
              : ""}
          </p>
          {unresolvedTime > 0 ? (
            <TimeReviewCard
              engine={engine}
              report={state.runReport}
              onChanged={onTimezoneChanged}
            />
          ) : null}
          <div className="import-flow__row">
            <span className="import-flow__spacer" />
            <button type="button" onClick={() => dispatch({ type: "RESET" })}>
              Import more…
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
