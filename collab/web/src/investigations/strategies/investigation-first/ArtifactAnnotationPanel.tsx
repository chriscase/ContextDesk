import { useEffect, useState, type FormEvent } from "react";
import type { ArtifactAnnotationV1 } from "../../runtime/public.js";

export interface ArtifactAnnotationDraft {
  readonly artifactId: string;
  readonly body: string;
  readonly privacyClass: "owner_only" | "share_safe";
  readonly idempotencyKey: string;
}

export interface ArtifactAnnotationPanelProps {
  readonly artifactId: string;
  readonly annotations: readonly ArtifactAnnotationV1[];
  readonly canAnnotate: boolean;
  readonly canReadPrivate: boolean;
  readonly readOnly: boolean;
  readonly mutationStatus: "idle" | "running" | "succeeded" | "failed";
  readonly mutationArtifactId: string | null;
  readonly mutationError: string | null;
  /** A lost acknowledgement must be checked against the refreshed history. */
  readonly retryBlocked: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onCreate: (draft: ArtifactAnnotationDraft) => Promise<unknown>;
}

function formatAuthor(annotation: ArtifactAnnotationV1): string {
  return annotation.authorUsername || "Unknown contributor";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function newIdempotencyKey(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") return `annotation-${randomUUID()}`;
  } catch {
    // Fall through to a bounded best-effort token for older browser runtimes.
  }
  return `annotation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Compact, strategy-local annotation affordance. The runtime owns the
 * request and authorization; this component only edits a pending draft and
 * renders server-confirmed rows.
 */
export function ArtifactAnnotationPanel({
  artifactId,
  annotations,
  canAnnotate,
  canReadPrivate,
  readOnly,
  mutationStatus,
  mutationArtifactId,
  mutationError,
  retryBlocked,
  onRefresh,
  onCreate,
}: ArtifactAnnotationPanelProps) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [privacyClass, setPrivacyClass] = useState<"owner_only" | "share_safe">(
    canReadPrivate ? "owner_only" : "share_safe",
  );
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [outcomeChecked, setOutcomeChecked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!canReadPrivate && privacyClass === "owner_only") setPrivacyClass("share_safe");
  }, [canReadPrivate, privacyClass]);
  useEffect(() => {
    if (!retryBlocked) setOutcomeChecked(false);
  }, [retryBlocked]);

  const visibleAnnotations = annotations.length > 0 ? annotations : [];
  const isThisMutation = mutationArtifactId === artifactId;
  const working = isThisMutation && mutationStatus === "running";
  const canSubmit = canAnnotate && !readOnly && body.trim().length > 0 && !working && !refreshing && (!retryBlocked || outcomeChecked);

  async function refreshHistory() {
    if (refreshing) return;
    setRefreshing(true);
    setOutcomeChecked(false);
    try {
      await onRefresh();
      setOutcomeChecked(true);
    } finally {
      setRefreshing(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const result = await onCreate({
      artifactId,
      body: body.trim(),
      privacyClass,
      idempotencyKey,
    });
    if (result && typeof result === "object" && "status" in result && result.status === "succeeded") {
      setBody("");
      setOpen(false);
      setIdempotencyKey(newIdempotencyKey());
    }
  }

  return <div className="investigation-first__annotation-panel">
    <div className="investigation-first__annotation-summary">
      <span className="investigation-first__annotation-count" aria-label={`${visibleAnnotations.length} annotations`}>
        {visibleAnnotations.length} {visibleAnnotations.length === 1 ? "note" : "notes"}
      </span>
      {visibleAnnotations.length > 0 ? (
        <span className="investigation-first__annotation-latest">
          Latest: {visibleAnnotations[visibleAnnotations.length - 1]?.body}
        </span>
      ) : <span className="investigation-first__muted">No durable notes on this file yet.</span>}
    </div>
    {visibleAnnotations.length > 0 ? <details className="investigation-first__annotation-history">
      <summary>Show annotation history</summary>
      <ol>
        {visibleAnnotations.map((annotation) => <li key={annotation.id}>
          <p>{annotation.body}</p>
          <small>{formatAuthor(annotation)} · {formatTime(annotation.createdAt)} · {annotation.privacyClass === "owner_only" ? "Owner only" : "Share safe"}</small>
        </li>)}
      </ol>
    </details> : null}
    {canAnnotate && !readOnly ? <details
      className="investigation-first__annotation-editor"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{working ? "Saving note…" : "Add a note"}</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          <span className="sr-only">Annotation for this evidence</span>
          <textarea
            value={body}
            maxLength={4000}
            rows={2}
            placeholder="What does this file show, and why does it matter?"
            onChange={(event) => setBody(event.target.value)}
            disabled={working}
          />
        </label>
        <div className="investigation-first__annotation-editor-actions">
          <label>
            <span className="sr-only">Annotation privacy</span>
            <select
              value={privacyClass}
              onChange={(event) => setPrivacyClass(event.target.value === "owner_only" && canReadPrivate ? "owner_only" : "share_safe")}
              disabled={working}
            >
              {canReadPrivate ? <option value="owner_only">Owner only</option> : null}
              <option value="share_safe">Share safe</option>
            </select>
          </label>
          <span className="investigation-first__annotation-length" aria-live="polite">{body.length}/4000</span>
          <button type="submit" disabled={!canSubmit}>{working ? "Saving…" : "Save note"}</button>
        </div>
      </form>
      {isThisMutation && mutationStatus === "failed" && mutationError ? <p className="investigation-first__error" role="alert">{mutationError}</p> : null}
      {isThisMutation && retryBlocked ? <div className="investigation-first__annotation-unknown" role="alert"><p>The server did not confirm this note. Refresh annotation history before submitting this note again.</p><button type="button" disabled={refreshing} onClick={() => void refreshHistory()}>{refreshing ? "Refreshing history…" : "Refresh annotation history"}</button>{outcomeChecked ? <small>History refreshed. Check for this note before saving again.</small> : null}</div> : null}
      {isThisMutation && mutationStatus === "succeeded" ? <p className="investigation-first__success" role="status">Note saved to this evidence.</p> : null}
    </details> : readOnly ? <small className="investigation-first__muted">Annotations are read-only in this view.</small> : null}
  </div>;
}
