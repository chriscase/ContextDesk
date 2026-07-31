import type { PreflightReadiness } from "../../lib/preflightCategories";

type Props = {
  busy: boolean;
  /**
   * Three-state readiness (#746). `ready` means launch-critical provider
   * probes actually succeeded — configuration alone never earns it.
   */
  readiness: PreflightReadiness;
  scopeLabel: string;
  egressLabel: string;
  onOpenPreflight: () => void;
  onOpenWorkspace: () => void;
  onOpenAi: () => void;
};

const READINESS_LABEL: Record<PreflightReadiness, string> = {
  blocked: "Setup incomplete",
  unverified: "Not verified",
  ready: "Ready",
};

const PREFLIGHT_LABEL: Record<PreflightReadiness, string> = {
  blocked: "Preflight issues",
  unverified: "Preflight unverified",
  ready: "Preflight ok",
};

/** Bottom status bar (#146). */
export function StatusBar({
  busy,
  readiness,
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
          data-warn={!busy && readiness === "blocked" ? "true" : undefined}
          data-unverified={
            !busy && readiness === "unverified" ? "true" : undefined
          }
          data-ok={!busy && readiness === "ready" ? "true" : undefined}
          aria-hidden
        />
        <span data-testid="status-bar-readiness">
          {busy ? "Live · agent turn" : READINESS_LABEL[readiness]}
        </span>
        <span aria-hidden>·</span>
        <button
          type="button"
          onClick={onOpenPreflight}
          title={
            readiness === "unverified"
              ? "A configured provider has not answered a live check yet."
              : undefined
          }
        >
          {PREFLIGHT_LABEL[readiness]}
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
