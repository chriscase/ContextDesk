type Props = {
  setupIncomplete: boolean;
  dismissedBanner: boolean;
  agentError: string | null;
  onOpenPreflight: () => void;
  onDismissSetup: () => void;
  onDismissError: () => void;
};

export function Banners({
  setupIncomplete,
  dismissedBanner,
  agentError,
  onOpenPreflight,
  onDismissSetup,
  onDismissError,
}: Props) {
  return (
    <>
      {setupIncomplete && !dismissedBanner ? (
        <div className="banner" role="status">
          <span className="banner__msg">
            <strong>Setup incomplete</strong>
            Fix workspace or AI provider in Preflight
          </span>
          <span className="banner__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={onOpenPreflight}
            >
              Open Preflight
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onDismissSetup}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}
      {agentError ? (
        <div className="banner" data-tone="danger" role="alert">
          <span className="banner__msg">
            <strong>Error</strong>
            {agentError}
          </span>
          <span className="banner__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onDismissError}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}
    </>
  );
}
