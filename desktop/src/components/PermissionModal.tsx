import { useState } from "react";
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
  onRespond: (decision: "deny" | "allow_once" | "allow_session_path", typed?: string) => void;
};

export function PermissionModal({ prompt, onRespond }: Props) {
  const [typed, setTyped] = useState("");
  if (!prompt) return null;
  const needsType = Boolean(prompt.typeConfirmPhrase);
  const typeOk = !needsType || typed.trim() === prompt.typeConfirmPhrase;

  return (
    <div className="settings-overlay" role="alertdialog" aria-modal="true" aria-label="Permission required">
      <div className="settings-panel" style={{ gridTemplateColumns: "1fr", maxWidth: 520, maxHeight: "80vh" }}>
        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-header__title">
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
            <pre className="tool-row__detail">{prompt.preview}</pre>
            {needsType ? (
              <div className="field">
                <label className="field__label" htmlFor="type-confirm">
                  Type <code>{prompt.typeConfirmPhrase}</code> to confirm
                </label>
                <input
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
            <button type="button" className="btn btn--ghost" onClick={() => onRespond("deny")}>
              Cancel
            </button>
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
