type Props = {
  busy: boolean;
  setupIncomplete: boolean;
  scopeLabel: string;
  egressLabel: string;
  onOpenPreflight: () => void;
  onOpenWorkspace: () => void;
  onOpenAi: () => void;
};

/** Bottom status bar (#146). */
export function StatusBar({
  busy,
  setupIncomplete,
  scopeLabel,
  egressLabel,
  onOpenPreflight,
  onOpenWorkspace,
  onOpenAi,
}: Props) {
  return (
    <footer className="status-bar">
      <span className="status-bar__left">
        <span
          className="status-bar__dot"
          data-live={busy ? "true" : undefined}
          data-warn={!busy && setupIncomplete ? "true" : undefined}
          data-ok={!busy && !setupIncomplete ? "true" : undefined}
          aria-hidden
        />
        <span>
          {busy
            ? "Live · agent turn"
            : setupIncomplete
              ? "Setup incomplete"
              : "Ready"}
        </span>
        <span aria-hidden>·</span>
        <button type="button" onClick={onOpenPreflight}>
          Preflight {setupIncomplete ? "issues" : "ok"}
        </button>
      </span>
      <span className="status-bar__right">
        <button type="button" onClick={onOpenWorkspace}>
          {scopeLabel}
        </button>
        <span aria-hidden>·</span>
        <button type="button" onClick={onOpenAi}>
          {egressLabel}
        </button>
      </span>
    </footer>
  );
}
