import type { PreflightItem, PreflightReport } from "../lib/preflight";
import type { DefaultWorkspaceDto } from "../lib/host";
import { IconAlert, IconCheck, IconRefresh, IconWarn } from "./icons";

type Props = {
  report: PreflightReport;
  onRecheck: () => void;
  onFix: (section: NonNullable<PreflightItem["fixAction"]>) => void;
  checking?: boolean;
  /** OS Documents/<product> suggestion for missing workspace roots. */
  defaultWorkspace?: DefaultWorkspaceDto | null;
  onUseDefaultWorkspace?: () => void | Promise<void>;
  defaultWorkspaceBusy?: boolean;
};

function LevelIcon({ level }: { level: PreflightItem["level"] }) {
  if (level === "pass") return <IconCheck />;
  if (level === "warn") return <IconWarn />;
  return <IconAlert />;
}

export function PreflightPanel({
  report,
  onRecheck,
  onFix,
  checking,
  defaultWorkspace,
  onUseDefaultWorkspace,
  defaultWorkspaceBusy,
}: Props) {
  const pass = report.items.filter((i) => i.level === "pass").length;
  const total = report.items.length;
  const needsWorkspace = report.items.some(
    (i) =>
      (i.id === "workspace.roots" || i.id === "workspace.missing") &&
      i.level === "fail",
  );
  const showDefaultOffer =
    needsWorkspace && Boolean(defaultWorkspace && onUseDefaultWorkspace);

  const isWorkspaceItem = (id: string) =>
    id === "workspace.roots" || id === "workspace.missing";

  return (
    <div>
      <div className="row--between stack-sm preflight-lead">
        <p className="section-lead preflight-lead__text">
          Environment health for local tools and gateways. Fix here — no config
          files required.
        </p>
        <span className="field__hint preflight-lead__count" role="status">
          {pass}/{total}
          {report.hasBlocking ? " blocking" : " ready"}
        </span>
      </div>

      {showDefaultOffer && defaultWorkspace ? (
        <div className="preflight-offer" role="region" aria-label="Default workspace">
          <div className="preflight-offer__body">
            <div className="preflight-offer__title">
              Use the default workspace folder?
            </div>
            <p className="preflight-offer__detail">
              ContextDesk can create{" "}
              <span className="mono mono--sm">{defaultWorkspace.label}</span>{" "}
              on this machine and allowlist it. Path:{" "}
              <span className="mono mono--sm">{defaultWorkspace.path}</span>
              {defaultWorkspace.exists ? " (already exists)" : " (will be created)"}.
              This is under Documents — never your whole home directory.
            </p>
          </div>
          <div className="preflight-offer__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={defaultWorkspaceBusy}
              onClick={() => void onUseDefaultWorkspace?.()}
            >
              {defaultWorkspaceBusy
                ? "Setting up…"
                : `Yes, use ${defaultWorkspace.label}`}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={defaultWorkspaceBusy}
              onClick={() => onFix("workspace")}
            >
              Choose a different folder…
            </button>
          </div>
        </div>
      ) : null}

      <div className="preflight-actions row">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onRecheck}
          disabled={checking}
        >
          <IconRefresh />
          {checking ? "Checking…" : "Recheck"}
        </button>
        <a
          className="btn btn--ghost btn--sm"
          href="https://ollama.com/download"
          target="_blank"
          rel="noreferrer"
        >
          Install Ollama
        </a>
      </div>
      <ul className="preflight-list">
        {report.items.map((item) => (
          <li key={item.id} className="preflight-row" data-level={item.level}>
            <LevelIcon level={item.level} />
            <div>
              <div className="preflight-row__title">{item.title}</div>
              <div className="preflight-row__detail">{item.detail}</div>
              {isWorkspaceItem(item.id) &&
              item.level !== "pass" &&
              showDefaultOffer ? (
                <div className="preflight-row__actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={defaultWorkspaceBusy}
                    onClick={() => void onUseDefaultWorkspace?.()}
                  >
                    {defaultWorkspaceBusy
                      ? "Setting up…"
                      : `Use ${defaultWorkspace!.label}`}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--linkish"
                    onClick={() => onFix("workspace")}
                  >
                    Choose folder in settings →
                  </button>
                </div>
              ) : item.fixAction && item.level !== "pass" ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--linkish"
                  onClick={() => onFix(item.fixAction!)}
                >
                  Open{" "}
                  {item.fixAction === "workspace"
                    ? "workspace"
                    : item.fixAction === "ai"
                      ? "AI"
                      : item.fixAction}{" "}
                  settings →
                </button>
              ) : null}
            </div>
            <span className="preflight-row__level">{item.level}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
