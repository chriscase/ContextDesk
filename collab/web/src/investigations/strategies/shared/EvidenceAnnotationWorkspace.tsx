import { useEffect, useId, useState } from "react";
import { StrategyActionRow, StrategyBadge, StrategyStateNotice } from "./presentation.js";

const MAX_BULK_IDS = 64;

interface EvidenceItem {
  readonly id: string;
  readonly filename: string | null;
  readonly uri: string | null;
}

interface AnnotationItem {
  readonly id: string;
  readonly artifactId: string;
  readonly privacyClass: "owner_only" | "share_safe";
}

interface AnnotationView {
  readonly availability: "idle" | "loading" | "available" | "unavailable";
  readonly value?: readonly AnnotationItem[];
  readonly refresh?: "settled" | "loading" | "failed";
}

interface BulkResultItem {
  readonly artifactId: string;
  readonly outcome: "created" | "replayed" | "not_found";
}

interface BulkResult {
  readonly items: readonly BulkResultItem[];
}

type CommandResult = { readonly status: string; readonly value?: unknown; readonly error?: unknown };
type BulkCommandInput = {
  readonly artifactIds: readonly string[];
  readonly body: string;
  readonly privacyClass: "owner_only" | "share_safe";
  readonly idempotencyKey: string;
};
type BulkCommand = (command: BulkCommandInput) => Promise<CommandResult>;
type BulkMutation = { readonly status: "idle" | "running" | "succeeded" | "failed"; readonly error?: unknown };

export interface EvidenceAnnotationWorkspaceProps {
  /** Includes the focused case and identity so drafts cannot cross scopes. */
  readonly scopeKey: string;
  readonly evidence: readonly EvidenceItem[];
  readonly selectedArtifactIds: readonly string[];
  readonly annotations: AnnotationView;
  readonly canAnnotate: boolean;
  readonly canReadPrivate: boolean;
  readonly readOnly: boolean;
  readonly bulkCommand: BulkCommand | null;
  readonly bulkMutation: BulkMutation;
  readonly bulkErrorCopy: string | null;
  readonly onRefresh: () => Promise<void>;
  readonly onClearSelection: () => void;
  /** Optional stable id for shells that already document the trash affordance. */
  readonly trashDescriptionId?: string;
}

function newIdempotencyKey(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") return `annotation-bulk-${randomUUID()}`;
  } catch {
    // Older browser runtimes use the bounded fallback below.
  }
  return `annotation-bulk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function isCommitOutcomeUnknown(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { readonly status?: unknown; readonly error?: unknown };
  if (result.status !== "failed" || typeof result.error !== "object" || result.error === null) return false;
  const error = result.error as { readonly kind?: unknown; readonly reason?: unknown };
  return error.kind === "unavailable" && error.reason === "commit_outcome_unknown";
}

function isSucceeded(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { readonly status?: unknown }).status === "succeeded";
}

function evidenceLabel(evidence: EvidenceItem): string {
  return evidence.filename?.trim() || evidence.uri?.trim() || "Unnamed evidence";
}

function resultTone(outcome: BulkResultItem["outcome"]): "success" | "warning" | "accent" {
  return outcome === "created" ? "success" : outcome === "replayed" ? "accent" : "warning";
}

/**
 * Shared presentation for append-only evidence notes. The component owns
 * selection copy and a bounded composer, but the Runtime owns every request,
 * authorization check, idempotency decision, and durable result.
 */
export function EvidenceAnnotationWorkspace({
  scopeKey,
  evidence,
  selectedArtifactIds,
  annotations,
  canAnnotate,
  canReadPrivate,
  readOnly,
  bulkCommand,
  bulkMutation,
  bulkErrorCopy,
  onRefresh,
  onClearSelection,
  trashDescriptionId,
}: EvidenceAnnotationWorkspaceProps) {
  const bodyId = useId();
  const privacyId = useId();
  const resultId = useId();
  const resolvedTrashDescriptionId = trashDescriptionId ?? `${bodyId}-trash-description`;
  const [body, setBody] = useState("");
  const [privacyClass, setPrivacyClass] = useState<"owner_only" | "share_safe">(
    canReadPrivate ? "owner_only" : "share_safe",
  );
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const [historyChecked, setHistoryChecked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastResult, setLastResult] = useState<BulkResult | null>(null);
  const selectionKey = selectedArtifactIds.join("\u0000");
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const selectedEvidence = selectedArtifactIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is EvidenceItem => item !== undefined);
  const missingSelectionCount = selectedArtifactIds.length - selectedEvidence.length;
  const validBulkSelection = selectedArtifactIds.length >= 2
    && selectedArtifactIds.length <= MAX_BULK_IDS
    && missingSelectionCount === 0;
  const working = bulkMutation.status === "running";
  const historyPending = annotations.availability === "idle"
    || annotations.availability === "loading"
    || (annotations.availability === "available" && annotations.refresh === "loading");
  const historyUnavailable = annotations.availability === "unavailable"
    || (annotations.availability === "available" && annotations.refresh === "failed");
  const annotationCount = annotations.availability === "available"
    ? annotations.value?.filter((item) => canReadPrivate || item.privacyClass !== "owner_only").length ?? 0
    : null;
  const formReady = validBulkSelection
    && canAnnotate
    && !readOnly
    && bulkCommand !== null
    && !working
    && !refreshing
    && body.trim().length > 0
    && !historyPending
    && !historyUnavailable
    && (!retryBlocked || historyChecked);

  useEffect(() => {
    setBody("");
    setLastResult(null);
    setRetryBlocked(false);
    setHistoryChecked(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [scopeKey, selectionKey]);

  useEffect(() => {
    if (!canReadPrivate && privacyClass === "owner_only") setPrivacyClass("share_safe");
  }, [canReadPrivate, privacyClass]);

  useEffect(() => {
    if (bulkMutation.status !== "failed") return;
    if (isCommitOutcomeUnknown(bulkMutation)) {
      setRetryBlocked(true);
      setHistoryChecked(false);
    }
  }, [bulkMutation]);

  async function refreshHistory() {
    if (refreshing) return;
    setRefreshing(true);
    setHistoryChecked(false);
    try {
      await onRefresh();
      setHistoryChecked(true);
    } finally {
      setRefreshing(false);
    }
  }

  async function submit() {
    if (!formReady || bulkCommand === null) return;
    const result = await bulkCommand({
      artifactIds: selectedArtifactIds,
      body: body.trim(),
      privacyClass,
      idempotencyKey,
    });
    if (isCommitOutcomeUnknown(result)) {
      setRetryBlocked(true);
      setHistoryChecked(false);
    }
    if (isSucceeded(result)) {
      const value = (result as { readonly value?: unknown }).value;
      if (
        typeof value === "object"
        && value !== null
        && Array.isArray((value as { readonly items?: unknown }).items)
      ) setLastResult(value as BulkResult);
      setBody("");
      setIdempotencyKey(newIdempotencyKey());
      setRetryBlocked(false);
      setHistoryChecked(false);
    }
  }

  return (
    <section className="strategy-kit__annotation-workspace" aria-labelledby={`${bodyId}-title`}>
      <div className="strategy-kit__annotation-heading">
        <div>
          <p className="strategy-kit__eyebrow">Evidence workspace</p>
          <h4 id={`${bodyId}-title`}>Annotate selected evidence</h4>
          <p>Save one durable note across several files without changing evidence identity or investigation permissions.</p>
        </div>
        <StrategyBadge tone={annotationCount === null ? "neutral" : "accent"}>
          {annotationCount === null ? "History not ready" : `${annotationCount} durable ${annotationCount === 1 ? "note" : "notes"}`}
        </StrategyBadge>
      </div>

      {selectedArtifactIds.length === 0 ? (
        <StrategyStateNotice title="Choose evidence to annotate">
          Select two or more evidence rows above for one audited bulk note. For a single file, use its “Show notes” action.
        </StrategyStateNotice>
      ) : selectedArtifactIds.length === 1 ? (
        <StrategyStateNotice title="Single-file note">
          Use “Show notes” on the selected evidence row to add or review a note for one file.
        </StrategyStateNotice>
      ) : selectedArtifactIds.length > MAX_BULK_IDS ? (
        <StrategyStateNotice tone="warning" title="Selection is too large">
          Select at most {MAX_BULK_IDS} files for one audited note. No write was attempted.
          <StrategyActionRow><button type="button" onClick={onClearSelection}>Clear selection</button></StrategyActionRow>
        </StrategyStateNotice>
      ) : missingSelectionCount > 0 ? (
        <StrategyStateNotice tone="warning" title="Selection changed">
          {missingSelectionCount} selected file{missingSelectionCount === 1 ? " is" : "s are"} no longer in this inventory. Clear the selection before writing.
          <StrategyActionRow><button type="button" onClick={onClearSelection}>Clear selection</button></StrategyActionRow>
        </StrategyStateNotice>
      ) : historyPending ? (
        <StrategyStateNotice busy title="Loading annotation history">
          Checking durable notes before offering a write. Existing evidence remains available.
        </StrategyStateNotice>
      ) : historyUnavailable ? (
        <StrategyStateNotice tone="warning" title="Annotation history is unavailable">
          Refresh the durable annotation history before submitting a bulk note. Existing evidence remains available.
          <StrategyActionRow><button type="button" disabled={refreshing} onClick={() => void refreshHistory()}>{refreshing ? "Refreshing history…" : "Retry annotation history"}</button></StrategyActionRow>
        </StrategyStateNotice>
      ) : readOnly || !canAnnotate || bulkCommand === null ? (
        <StrategyStateNotice title="Annotation writing unavailable">
          Notes are read-only in this view. Nothing will be written from this workspace.
        </StrategyStateNotice>
      ) : (
        <>
          <div className="strategy-kit__annotation-targets" aria-label="Selected evidence">
            {selectedEvidence.map((item) => <span key={item.id} className="strategy-kit__annotation-target">{evidenceLabel(item)}</span>)}
          </div>
          <form
            className="strategy-kit__annotation-form"
            aria-label="Annotate selected evidence form"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}
          >
            <label htmlFor={bodyId}>Durable note for these files</label>
            <textarea
              id={bodyId}
              value={body}
              maxLength={4000}
              rows={3}
              placeholder="What do these files show, and why does it matter?"
              onChange={(event) => setBody(event.target.value)}
              disabled={working || refreshing}
            />
            <div className="strategy-kit__annotation-form-row">
              <label htmlFor={privacyId}>Privacy</label>
              <select
                id={privacyId}
                value={privacyClass}
                onChange={(event) => setPrivacyClass(event.target.value === "owner_only" && canReadPrivate ? "owner_only" : "share_safe")}
                disabled={working || refreshing}
              >
                {canReadPrivate ? <option value="owner_only">Owner only</option> : null}
                <option value="share_safe">Share safe</option>
              </select>
              <span className="strategy-kit__annotation-length" aria-live="polite">{body.length}/4000</span>
              <button type="submit" disabled={!formReady}>{working ? "Saving note…" : "Save one note to selected evidence"}</button>
            </div>
          </form>
          {bulkErrorCopy ? <StrategyStateNotice tone="danger" role="alert" title="The note was not confirmed">{bulkErrorCopy}</StrategyStateNotice> : null}
          {retryBlocked ? (
            <StrategyStateNotice tone="warning" role="alert" title="The server did not confirm this note">
              Refresh annotation history before submitting this note again. The same idempotency key will be reused only after you review the refreshed history.
              <StrategyActionRow>
                <button type="button" disabled={refreshing} onClick={() => void refreshHistory()}>{refreshing ? "Refreshing history…" : "Refresh annotation history"}</button>
                {historyChecked ? <span>History refreshed; review it before retrying.</span> : null}
              </StrategyActionRow>
            </StrategyStateNotice>
          ) : null}
          {lastResult ? (
            <div id={resultId} className="strategy-kit__annotation-results" role="status" aria-live="polite">
              <strong>Bulk annotation result</strong>
              <ul>
                {lastResult.items.map((item) => {
                  const label = evidenceById.get(item.artifactId);
                  return <li key={item.artifactId}><StrategyBadge tone={resultTone(item.outcome)}>{item.outcome}</StrategyBadge><span>{label ? evidenceLabel(label) : "Evidence no longer in this inventory"}</span>{item.outcome === "not_found" ? <small>No note was written for this item.</small> : null}</li>;
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}
      <div className="strategy-kit__annotation-selection-actions">
        <span>{selectedArtifactIds.length} selected</span>
        <button type="button" disabled aria-describedby={resolvedTrashDescriptionId}>Move selected to trash</button>
        <button type="button" onClick={onClearSelection} disabled={selectedArtifactIds.length === 0}>Clear selection</button>
        <small id={resolvedTrashDescriptionId}>Trash remains a recoverable, audited lifecycle action; no file is deleted here.</small>
      </div>
    </section>
  );
}
