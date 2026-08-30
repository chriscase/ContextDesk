/**
 * Archiving and restoring an investigation, as a deliberate act.
 *
 * Archiving used to be one option in the same dropdown as `open` and
 * `monitoring`: a single unconfirmed change of a select, indistinguishable
 * from moving a case to monitoring, that took the investigation out of the
 * working list. Restoring was the same control run backwards, which meant the
 * operator had to remember what the investigation had been before.
 *
 * Three things are wrong with that, and this panel exists to fix them:
 *
 * 1. **It read as deletion to anyone who had not been told otherwise.** A
 *    support user archiving a case had no way to know the evidence, the
 *    timeline, and the audit trail all survive. So the panel says what
 *    archiving does, in words, before offering it.
 * 2. **It could not be refused legibly.** A legal hold refuses an archive, but
 *    the dropdown had no way to say so until after the click. The panel reads
 *    the recorded verdict first and disables the control with the reason
 *    attached, so the refusal arrives before the attempt.
 * 3. **Restore was a guess.** The panel names the status the investigation
 *    will return to, read from its recorded history rather than from memory.
 *
 * Confirmation is a second explicit click rather than a `window.confirm`: the
 * dialog cannot be styled, cannot be read by the component tests, and gives
 * the operator no room to state what will happen.
 */
import { useCallback, useEffect, useState } from "react";
import { protectedApiFetch } from "./protected-api.js";

/** Mirrors the server's lifecycle verdict without importing its internals. */
export interface LifecycleVerdictView {
  allowed: boolean;
  action?: string;
  reason?: string;
  detail?: string;
  targetStatus?: string;
}

export interface LifecycleView {
  status: string;
  legalHold: boolean;
  archive: LifecycleVerdictView;
  restore: LifecycleVerdictView;
  restoreTarget: string;
  deletion: { supported: boolean; detail: string };
}

/**
 * What each status is called where a reader meets it.
 *
 * The raw status is still shown elsewhere; this is the phrase that makes a
 * restore destination read as a place rather than as a token.
 */
const STATUS_PHRASE: Readonly<Record<string, string>> = {
  open: "open",
  monitoring: "monitoring",
  resolved: "resolved",
  archived: "archived",
};

function statusPhrase(status: string): string {
  return STATUS_PHRASE[status] ?? status;
}

export function LifecyclePanel(props: {
  caseId: string;
  /** Current status from the loaded case, so the panel renders before its fetch lands. */
  status: string;
  canLead: boolean;
  /** Static snapshots suppress mutations regardless of the reader's ordinary role. */
  readOnly?: boolean;
  /** Runs after a successful archive or restore so the caller can refetch. */
  onChanged: () => void | Promise<void>;
  /** Test seam: supplies the view without a network round trip. */
  loadLifecycle?: (caseId: string) => Promise<LifecycleView | null>;
}) {
  const { caseId, loadLifecycle } = props;
  const [view, setView] = useState<LifecycleView | null>(null);
  const [confirming, setConfirming] = useState<"archive" | "restore" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (loadLifecycle) {
      setView(await loadLifecycle(caseId));
      return;
    }
    // A lifecycle read that fails is not worth an error banner: the panel
    // simply has nothing extra to say, and the ordinary status path still
    // works. Failing loudly here would put a red message on every
    // investigation in an installation that has not deployed the route yet.
    try {
      const response = await protectedApiFetch(`/api/cases/${caseId}/lifecycle`);
      if (!response.ok) {
        setView(null);
        return;
      }
      setView((await response.json()) as LifecycleView);
    } catch {
      setView(null);
    }
  }, [caseId, loadLifecycle]);

  useEffect(() => {
    setConfirming(null);
    setError(null);
    void load();
  }, [load]);

  async function commit(action: "archive" | "restore", targetStatus: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await protectedApiFetch(`/api/cases/${caseId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: targetStatus }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        // A lifecycle refusal already reads as a complete sentence naming what
        // to do about it, so it is shown as written rather than wrapped in a
        // generic failure line that would bury it.
        setError(
          body.detail
            ?? (action === "archive"
              ? "This investigation could not be archived."
              : "This investigation could not be restored."),
        );
        await load();
        return;
      }
      setConfirming(null);
      await load();
      await props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (!props.canLead || props.readOnly) {
    return (
      <p className="triage-step__note">
        {props.readOnly
          ? "Static read-only view: archiving and restoring are unavailable."
          : "Only a case lead can archive or restore this investigation."}
      </p>
    );
  }

  const status = view?.status ?? props.status;
  const isArchived = status === "archived";
  const archive = view?.archive;
  const restoreTarget = view?.restoreTarget ?? "open";
  // Until the verdict lands the control stays available and the server stays
  // the authority: an optimistic disable would hide a legitimate action behind
  // a slow request, and an optimistic enable is corrected by the refusal.
  const archiveRefusal = archive && !archive.allowed ? (archive.detail ?? null) : null;

  return (
    <section className="lifecycle-panel" aria-label="Archive and restore">
      <h4 className="lifecycle-panel__title">
        {isArchived ? "Restore this investigation" : "Archive this investigation"}
      </h4>
      <p className="lifecycle-panel__explainer">
        {isArchived
          ? `Restoring puts this investigation back in the working list as ${statusPhrase(restoreTarget)} — the status it held before it was archived.`
          : "Archiving takes this investigation out of the working list. Nothing is deleted: the evidence, the timeline, and the audit trail stay exactly as they are, and it can be restored later."}
      </p>

      {archiveRefusal && !isArchived ? (
        <p className="lifecycle-panel__refusal" role="status">
          {archiveRefusal}
        </p>
      ) : null}

      {error ? (
        <p className="lifecycle-panel__error" role="alert">
          {error}
        </p>
      ) : null}

      {confirming === null ? (
        <button
          type="button"
          className="lifecycle-panel__action"
          disabled={busy || Boolean(archiveRefusal && !isArchived)}
          onClick={() => setConfirming(isArchived ? "restore" : "archive")}
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
            disabled={busy}
            onClick={() =>
              void commit(confirming, confirming === "archive" ? "archived" : restoreTarget)
            }
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
