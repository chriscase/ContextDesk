import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { InvestigationFindingKind } from "../../lib/host";
import type { InvestigationFindingLifecycle } from "../../lib/host";

export type InvestigationItemDraft =
  | {
      type: "finding";
      kind: InvestigationFindingKind;
      lifecycle: InvestigationFindingLifecycle;
      title: string;
      body: string;
    }
  | {
      type: "note";
      title: string;
      body: string;
    };

const FINDING_KINDS: {
  value: InvestigationFindingKind;
  label: string;
  description: string;
}[] = [
  {
    value: "observation",
    label: "Observation",
    description: "A fact directly supported by the selected evidence.",
  },
  {
    value: "inference",
    label: "Inference",
    description: "A reasoned conclusion drawn from the evidence.",
  },
  {
    value: "hypothesis",
    label: "Hypothesis",
    description: "A testable explanation that still needs confirmation.",
  },
];

export function CreateInvestigationItemDialog({
  type,
  initialDraft,
  eventCount,
  sourceCount,
  busy,
  error,
  triggerRef,
  onSave,
  onDismiss,
}: {
  type: "finding" | "note";
  initialDraft?: InvestigationItemDraft;
  eventCount: number;
  sourceCount: number;
  busy: boolean;
  error?: string | null;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSave: (draft: InvestigationItemDraft) => void;
  onDismiss: () => void;
}) {
  const [kind, setKind] = useState<InvestigationFindingKind | null>(
    initialDraft?.type === "finding" ? initialDraft.kind : null,
  );
  const [lifecycle, setLifecycle] =
    useState<InvestigationFindingLifecycle>(
      initialDraft?.type === "finding" ? initialDraft.lifecycle : "accepted",
    );
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleId = useId();
  const descriptionId = useId();
  const firstKindRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const editing = initialDraft != null;
  const dirty =
    initialDraft == null
      ? kind != null || title.length > 0 || body.length > 0
      : initialDraft.title !== title ||
        initialDraft.body !== body ||
        (initialDraft.type === "finding" &&
          (initialDraft.kind !== kind ||
            initialDraft.lifecycle !== lifecycle));

  const finishDismiss = () => {
    onDismiss();
    queueMicrotask(() => triggerRef.current?.focus());
  };

  const requestDismiss = () => {
    if (busy) return;
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    finishDismiss();
  };

  const submit = () => {
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle || !cleanBody || busy) return;
    if (type === "finding") {
      if (!kind) return;
      onSave({
        type,
        kind,
        lifecycle,
        title: cleanTitle,
        body: cleanBody,
      });
    } else {
      onSave({ type, title: cleanTitle, body: cleanBody });
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      if (type === "finding") firstKindRef.current?.focus();
      else firstInputRef.current?.focus();
    });
  }, [type]);

  return (
    <div
      className="log-explorer__dialog-backdrop"
      data-testid={`create-${type}-backdrop`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          requestDismiss();
          return;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          event.preventDefault();
          submit();
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestDismiss();
      }}
    >
      <form
        ref={dialogRef}
        className="log-explorer__investigation-item-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'input:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
          submit();
        }}
      >
        <header className="log-explorer__investigation-item-dialog-header">
          <div>
            <div id={titleId} className="log-explorer__save-evidence-title">
              {editing ? "Edit" : "Create"}{" "}
              {type === "finding" ? "finding" : "cited note"}
            </div>
            <p
              id={descriptionId}
              className="log-explorer__save-evidence-description"
            >
              Cites {eventCount} exact event{" "}
              {eventCount === 1 ? "identity" : "identities"} across{" "}
              {sourceCount} {sourceCount === 1 ? "source" : "sources"}.
              Messages remain in the corpus and are resolved when needed.
            </p>
          </div>
          <span className="log-explorer__investigation-human-badge">
            Human authored
          </span>
        </header>

        {type === "finding" ? (
          <fieldset className="log-explorer__finding-kind-fieldset">
            <legend>What kind of finding is this?</legend>
            <div className="log-explorer__finding-kind-options">
              {FINDING_KINDS.map((option, index) => (
                <button
                  key={option.value}
                  ref={index === 0 ? firstKindRef : undefined}
                  type="button"
                  className={`log-explorer__finding-kind-option${
                    kind === option.value
                      ? " log-explorer__finding-kind-option--selected"
                      : ""
                  }`}
                  aria-pressed={kind === option.value}
                  onClick={() => {
                    setKind(option.value);
                    setConfirmDiscard(false);
                  }}
                >
                  <span>{option.label}</span>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {type === "finding" && editing ? (
          <label className="log-explorer__save-evidence-field">
            <span>Finding status</span>
            <select
              className="log-explorer__investigation-status-select"
              value={lifecycle}
              disabled={busy}
              onChange={(event) => {
                setLifecycle(
                  event.target.value as InvestigationFindingLifecycle,
                );
                setConfirmDiscard(false);
              }}
            >
              <option value="accepted">Accepted</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
        ) : null}

        <label className="log-explorer__save-evidence-field">
          <span>{type === "finding" ? "Finding title" : "Note title"}</span>
          <input
            ref={type === "note" ? firstInputRef : undefined}
            className="log-explorer__search"
            value={title}
            maxLength={256}
            disabled={busy}
            onChange={(event) => {
              setTitle(event.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>
        <label className="log-explorer__save-evidence-field">
          <span>
            {type === "finding" ? "Why it matters" : "Investigation note"}
          </span>
          <textarea
            className="log-explorer__investigation-item-body"
            value={body}
            maxLength={type === "finding" ? 4096 : 16384}
            rows={type === "finding" ? 4 : 7}
            disabled={busy}
            onChange={(event) => {
              setBody(event.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>

        {error ? (
          <div className="log-explorer__evidence-error" role="alert">
            {type === "finding" ? "Finding" : "Note"} was not saved: {error}
          </div>
        ) : null}
        {confirmDiscard ? (
          <div
            className="log-explorer__investigation-discard"
            role="alert"
            data-testid="investigation-discard-confirmation"
          >
            <span>Discard this unfinished {type}?</span>
            <button
              type="button"
              className="log-explorer__btn log-explorer__btn--danger"
              onClick={finishDismiss}
            >
              Discard
            </button>
            <button
              type="button"
              className="log-explorer__btn"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </button>
          </div>
        ) : null}

        <div className="log-explorer__save-evidence-actions">
          <span className="log-explorer__dialog-shortcut">
            {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter to save
          </span>
          <button
            type="button"
            className="log-explorer__btn"
            disabled={busy}
            onClick={requestDismiss}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="log-explorer__btn log-explorer__btn--active"
            disabled={
              busy || !title.trim() || !body.trim() || (type === "finding" && !kind)
            }
          >
            {busy
              ? "Saving…"
              : type === "finding"
                ? editing
                  ? "Save changes"
                  : "Save finding"
                : editing
                  ? "Save changes"
                  : "Save note"}
          </button>
        </div>
      </form>
    </div>
  );
}
