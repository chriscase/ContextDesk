import { useEffect, useId, useRef, useState } from "react";
import { trapTabKey } from "../lib/a11y";
import { IconAlert } from "./icons";

export type PermissionPrompt = {
  requestId: string;
  toolName: string;
  target: string;
  reason: string;
  preview: string;
  risk: string;
  typeConfirmPhrase?: string | null;
};

type Props = {
  prompt: PermissionPrompt | null;
  onRespond: (
    decision: "deny" | "allow_once" | "allow_session_path",
    typed?: string,
  ) => void;
};

/**
 * Wrapper always mounted so hooks stay stable; body mounts only when prompted
 * so focus capture/restore runs cleanly per request.
 */
export function PermissionModal({ prompt, onRespond }: Props) {
  if (!prompt) return null;
  return <PermissionModalBody prompt={prompt} onRespond={onRespond} />;
}

function PermissionModalBody({
  prompt,
  onRespond,
}: {
  prompt: PermissionPrompt;
  onRespond: Props["onRespond"];
}) {
  const [typed, setTyped] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const needsType = Boolean(prompt.typeConfirmPhrase);
  const typeOk = !needsType || typed.trim() === prompt.typeConfirmPhrase;

  // Reset typed phrase whenever the request changes (new mount per requestId
  // also works; effect covers same-instance swaps).
  useEffect(() => {
    setTyped("");
  }, [prompt.requestId]);

  // Capture focus restore target, autofocus, trap Tab, Escape=deny.
  useEffect(() => {
    restoreFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const focusFirst = () => {
      if (needsType) {
        inputRef.current?.focus();
      } else {
        cancelRef.current?.focus();
      }
    };
    // Defer so panel is in the DOM.
    const t = window.setTimeout(focusFirst, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onRespond("deny");
        return;
      }
      if (!panelRef.current) return;
      trapTabKey(e, panelRef.current, document.activeElement);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      restoreFocusRef.current?.focus?.();
    };
  }, [prompt.requestId, needsType, onRespond]);

  return (
    <div
      className="settings-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="settings-panel settings-panel--narrow"
        ref={panelRef}
      >
        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-header__title" id={titleId}>
              <IconAlert /> Permission needed: write
            </div>
          </header>
          <div className="settings-content">
            <p className="section-lead">
              ContextDesk wants to run <strong>{prompt.toolName}</strong> on:
            </p>
            <pre className="tool-row__detail">{prompt.target}</pre>
            <p className="section-lead">Why: {prompt.reason}</p>
            <p className="section-lead">Risk: {prompt.risk}</p>
            {prompt.toolName === "save_skill" ? (
              <p className="field__label">
                Skill draft preview (Accept writes this file)
              </p>
            ) : prompt.toolName === "save_memory" ||
              prompt.toolName === "supersede_memory" ? (
              <p className="field__label">
                Memory draft (kind, scope, content; redactions applied before
                store)
              </p>
            ) : prompt.toolName === "retract_memory" ? (
              <p className="field__label">
                Retract (reversible soft tombstone — not permanent delete)
              </p>
            ) : (
              <p className="field__label">Preview</p>
            )}
            {prompt.toolName === "retract_memory" ? (
              <div className="callout callout--warn" role="status">
                This hides the memory from recall but keeps the row. You can
                restore later. Permanent purge is a separate type-to-confirm
                step.
              </div>
            ) : null}
            {prompt.preview.includes("redactions:") &&
            !prompt.preview.includes("redactions: (none)") ? (
              <div className="callout callout--warn" role="status">
                Secrets will be scrubbed before the memory is stored. Review the
                redacted content below.
              </div>
            ) : null}
            {prompt.preview.includes("BLOCKED:") ? (
              <div className="callout callout--warn" role="alert">
                This content looks credential-dominant and will be refused on
                Accept.
              </div>
            ) : null}
            <pre className="tool-row__detail tool-row__detail--tall">
              {prompt.preview}
            </pre>
            {needsType ? (
              <div className="field">
                <label className="field__label" htmlFor="type-confirm">
                  Type <code>{prompt.typeConfirmPhrase}</code> to confirm
                </label>
                <input
                  ref={inputRef}
                  id="type-confirm"
                  className="field__control"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : null}
          </div>
          <footer className="settings-footer">
            <button
              ref={cancelRef}
              type="button"
              className="btn btn--ghost"
              onClick={() => onRespond("deny")}
            >
              Cancel
            </button>
            {!needsType ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onRespond("allow_session_path", typed)}
                title="Allow writes under this path for the rest of the session"
              >
                Allow this path (session)
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--primary"
              disabled={!typeOk}
              onClick={() => onRespond("allow_once", typed)}
            >
              Allow once
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
