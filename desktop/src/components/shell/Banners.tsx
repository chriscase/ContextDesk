import { useEffect, useMemo, useState } from "react";
import { buildErrorReport } from "../../lib/errorReport";

type Props = {
  setupIncomplete: boolean;
  dismissedBanner: boolean;
  agentError: string | null;
  appVersion?: string;
  /** Build channel (#338). */
  channel?: string;
  gitSha?: string | null;
  identityLine?: string;
  onOpenPreflight: () => void;
  onDismissSetup: () => void;
  onDismissError: () => void;
};

export function Banners({
  setupIncomplete,
  dismissedBanner,
  agentError,
  appVersion,
  channel,
  gitSha,
  identityLine,
  onOpenPreflight,
  onDismissSetup,
  onDismissError,
}: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const report = useMemo(() => {
    if (!agentError) return null;
    return buildErrorReport({
      raw: agentError,
      appVersion,
      channel,
      gitSha: gitSha ?? undefined,
      identityLine,
    });
  }, [agentError, appVersion, channel, gitSha, identityLine]);

  // Collapse details when error changes/clears
  useEffect(() => {
    setDetailsOpen(false);
    setCopyNote(null);
  }, [agentError]);

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.reportMarkdown);
      setCopyNote("Copied redacted report");
      window.setTimeout(() => setCopyNote(null), 2000);
    } catch {
      setCopyNote("Clipboard unavailable");
      window.setTimeout(() => setCopyNote(null), 2000);
    }
  };

  const openGitHubIssue = () => {
    if (!report) return;
    window.open(report.githubNewIssueUrl, "_blank", "noopener,noreferrer");
  };

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
      {agentError && report ? (
        <div className="banner banner--error-detail" data-tone="danger" role="alert">
          <div className="banner__error-col">
            <span className="banner__msg">
              <strong>Error</strong>
              {report.summary}
            </span>
            {detailsOpen ? (
              <pre className="banner__tech" tabIndex={0}>
                {report.technical}
              </pre>
            ) : null}
            <p className="banner__hint">
              If this keeps happening, please report it — secrets and private
              hosts are stripped automatically.
              {copyNote ? ` · ${copyNote}` : null}
            </p>
          </div>
          <span className="banner__actions banner__actions--stack">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setDetailsOpen((o) => !o)}
              aria-expanded={detailsOpen}
            >
              {detailsOpen ? "Hide details" : "Show technical details"}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void copyReport()}
            >
              Copy report
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={openGitHubIssue}
            >
              Report on GitHub
            </button>
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
