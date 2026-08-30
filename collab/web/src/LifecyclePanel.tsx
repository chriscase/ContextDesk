/**
 * Archive/restore presentation for one already-bound investigation runtime.
 *
 * Transport, route construction, lifecycle authority, and refresh behavior
 * remain outside this component. The panel renders parsed state and emits only
 * an archive or restore intent after an explicit second click.
 */
import { useEffect, useState } from "react";
import type {
  CommandOutcome,
  InvestigationLifecycleActionSuccessV1,
  InvestigationLifecycleV1,
  LifecycleAction,
  MutationState,
  ResourceState,
} from "./investigations/runtime/public.js";

export type LifecycleView = InvestigationLifecycleV1;

type LifecycleCommand = (
  action: LifecycleAction,
) => Promise<CommandOutcome<InvestigationLifecycleActionSuccessV1>>;

type LifecycleFailure = Extract<
  CommandOutcome<InvestigationLifecycleActionSuccessV1>,
  { status: "failed" }
>["error"];

export interface LifecyclePanelProps {
  lifecycle: ResourceState<InvestigationLifecycleV1>;
  lifecycleMutation: MutationState<InvestigationLifecycleActionSuccessV1>;
  canManage: boolean;
  /** Static snapshots suppress mutations regardless of ordinary role. */
  readOnly?: boolean;
  /** Action intent only. Runtime code derives and verifies expected state. */
  applyAction: LifecycleCommand | null;
  /** Requests a fresh parsed lifecycle view after a read failure. */
  retryLifecycle: () => void;
  /** Optional caller refresh after a confirmed successful action. */
  onChanged?: () => void | Promise<void>;
}

const STATUS_PHRASE: Readonly<Record<string, string>> = {
  open: "open",
  monitoring: "monitoring",
  resolved: "resolved",
  archived: "archived",
};

function statusPhrase(status: string): string {
  return STATUS_PHRASE[status] ?? status;
}

function lifecyclePreview(
  state: ResourceState<InvestigationLifecycleV1>,
): InvestigationLifecycleV1 | null {
  if (state.status === "ready") return state.value;
  if (state.status === "loading" || state.status === "failed") {
    return state.previous ?? null;
  }
  return null;
}

function failureCopy(failure: LifecycleFailure): string {
  if (failure.kind === "lifecycle_refused") return failure.detail;
  if (failure.kind === "lifecycle_changed") {
    return "The investigation changed before this action could be applied. Review the latest lifecycle state and try again if the action is still appropriate.";
  }
  return "The lifecycle action could not be completed. Review the current investigation state before trying again.";
}

export function LifecyclePanel(props: LifecyclePanelProps) {
  const [confirming, setConfirming] = useState<LifecycleAction | null>(null);
  const view = lifecyclePreview(props.lifecycle);

  useEffect(() => {
    setConfirming(null);
  }, [view?.investigationId, view?.status]);

  if (!props.canManage || props.readOnly) {
    return (
      <p className="triage-step__note">
        {props.readOnly
          ? "Static read-only view: archiving and restoring are unavailable."
          : "Only a case lead can archive or restore this investigation."}
      </p>
    );
  }

  const isArchived = view?.status === "archived";
  const action: LifecycleAction = isArchived ? "restore" : "archive";
  const verdict = isArchived ? view?.restore : view?.archive;
  const restoreTarget = view?.restoreTarget ?? "open";
  const refusal = verdict && !verdict.allowed ? verdict.detail : null;
  const readReady = props.lifecycle.status === "ready" && view !== null;
  const busy = props.lifecycleMutation.status === "running";
  const actionReady = readReady
    && props.applyAction !== null
    && verdict?.allowed === true;
  const mutationFailure = props.lifecycleMutation.status === "failed"
    ? props.lifecycleMutation.error
    : null;

  async function commit(requestedAction: LifecycleAction) {
    if (!actionReady || props.applyAction === null || requestedAction !== action) return;
    const outcome = await props.applyAction(requestedAction);
    if (outcome.status === "succeeded") {
      setConfirming(null);
      await props.onChanged?.();
    }
  }

  return (
    <section className="lifecycle-panel" aria-label="Archive and restore">
      <h4 className="lifecycle-panel__title">
        {view === null
          ? "Archive or restore this investigation"
          : isArchived
            ? "Restore this investigation"
            : "Archive this investigation"}
      </h4>

      {view ? (
        <p className="lifecycle-panel__explainer">
          {isArchived
            ? `Restoring puts this investigation back in the working list as ${statusPhrase(restoreTarget)} — the status it held before it was archived.`
            : "Archiving takes this investigation out of the working list. Nothing is deleted: the evidence, the timeline, and the audit trail stay exactly as they are, and it can be restored later."}
        </p>
      ) : (
        <p className="lifecycle-panel__explainer">
          Current lifecycle details are required before an investigation can be archived or restored.
        </p>
      )}

      {props.lifecycle.status === "loading" ? (
        <p className="triage-step__note" role="status">
          Checking the current archive and restore state…
        </p>
      ) : null}

      {props.lifecycle.status === "idle" ? (
        <p className="triage-step__note" role="status">
          Lifecycle details are not ready for this investigation.
        </p>
      ) : null}

      {props.lifecycle.status === "failed" ? (
        <div className="lifecycle-panel__read-failure">
          <p className="lifecycle-panel__error" role="alert">
            Lifecycle details could not be loaded. Archive and restore remain unavailable until the current state is available.
          </p>
          <button
            type="button"
            className="lifecycle-panel__action"
            onClick={props.retryLifecycle}
          >
            Retry lifecycle details
          </button>
        </div>
      ) : null}

      {refusal ? (
        <p className="lifecycle-panel__refusal" role="status">
          {refusal}
        </p>
      ) : null}

      {mutationFailure ? (
        <p className="lifecycle-panel__error" role="alert">
          {failureCopy(mutationFailure)}
        </p>
      ) : null}

      {confirming === null ? (
        <button
          type="button"
          className="lifecycle-panel__action"
          disabled={!actionReady || busy}
          onClick={() => setConfirming(action)}
        >
          {isArchived ? "Restore investigation" : "Archive investigation"}
        </button>
      ) : (
        <div className="lifecycle-panel__confirm">
          <p className="lifecycle-panel__confirm-question">
            {confirming === "archive"
              ? "Archive this investigation? It leaves the working list and keeps every record."
              : `Restore this investigation to ${statusPhrase(restoreTarget)}?`}
          </p>
          <button
            type="button"
            className="lifecycle-panel__confirm-yes"
            disabled={!actionReady || busy}
            onClick={() => void commit(confirming)}
          >
            {busy
              ? "Working…"
              : confirming === "archive"
                ? "Yes, archive it"
                : `Yes, restore to ${statusPhrase(restoreTarget)}`}
          </button>
          <button
            type="button"
            className="lifecycle-panel__confirm-no"
            disabled={busy}
            onClick={() => setConfirming(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {view?.deletion && !view.deletion.supported ? (
        <details className="lifecycle-panel__deletion">
          <summary>Can an investigation be deleted?</summary>
          <p>{view.deletion.detail}</p>
        </details>
      ) : null}
    </section>
  );
}
