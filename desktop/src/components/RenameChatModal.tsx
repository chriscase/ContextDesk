import { useEffect, useId, useRef, useState } from "react";

type Props = {
  open: boolean;
  initialTitle: string;
  onCancel: () => void;
  onConfirm: (title: string) => void;
};

/** In-app rename (plugin-dialog has no text prompt). */
export function RenameChatModal({
  open,
  initialTitle,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setValue(initialTitle);
    const t = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, initialTitle]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => {
    const t = value.trim();
    if (!t) return; // empty = no-op (caller treats as cancel of rename)
    onConfirm(t);
  };

  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Rename chat"
    >
      <div className="settings-panel settings-panel--narrow">
        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-header__title">Rename chat</div>
          </header>
          <div className="settings-content">
            <label className="field__label" htmlFor={id}>
              Title
            </label>
            <input
              ref={inputRef}
              id={id}
              className="field__control"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <footer className="settings-footer">
            <button type="button" className="btn btn--ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!value.trim()}
              onClick={submit}
            >
              Save
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
