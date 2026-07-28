import { useEffect, useId, useRef, useState, type RefObject } from "react";

export function SaveEvidenceDialog({
  eventCount,
  sourceCount,
  defaultTitle,
  busy,
  error,
  triggerRef,
  onSave,
  onDismiss,
}: {
  eventCount: number;
  sourceCount: number;
  defaultTitle: string;
  busy: boolean;
  error?: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSave: (title: string) => void;
  onDismiss: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const titleId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  const dismiss = () => {
    if (busy) return;
    onDismiss();
    queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  return (
    <div
      className="log-explorer__dialog-backdrop"
      data-testid="save-evidence-backdrop"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <form
        ref={dialogRef}
        className="log-explorer__save-evidence-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'input:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          if (focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = title.trim();
          if (trimmed && !busy) onSave(trimmed);
        }}
      >
        <div>
          <div id={titleId} className="log-explorer__save-evidence-title">
            Save selected evidence
          </div>
          <p
            id={descriptionId}
            className="log-explorer__save-evidence-description"
          >
            {eventCount} exact event{" "}
            {eventCount === 1 ? "identity" : "identities"} across {sourceCount}{" "}
            {sourceCount === 1 ? "source" : "sources"}. Messages are reloaded
            from the corpus when needed, not copied into the Investigation file.
          </p>
        </div>
        <label className="log-explorer__save-evidence-field">
          <span>Evidence title</span>
          <input
            ref={inputRef}
            className="log-explorer__search"
            value={title}
            maxLength={160}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error ? (
          <div className="log-explorer__evidence-error" role="alert">
            Evidence was not saved: {error}
          </div>
        ) : null}
        <div className="log-explorer__save-evidence-actions">
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            onClick={dismiss}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="log-explorer__btn log-explorer__btn--active"
            disabled={busy || !title.trim()}
          >
            {busy ? "Saving…" : "Save evidence"}
          </button>
        </div>
      </form>
    </div>
  );
}
