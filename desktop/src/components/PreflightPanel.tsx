import type { PreflightItem, PreflightReport } from "../lib/preflight";
import { IconAlert, IconCheck, IconRefresh, IconWarn } from "./icons";

type Props = {
  report: PreflightReport;
  onRecheck: () => void;
  onFix: (section: NonNullable<PreflightItem["fixAction"]>) => void;
  checking?: boolean;
};

function LevelIcon({ level }: { level: PreflightItem["level"] }) {
  if (level === "pass") return <IconCheck />;
  if (level === "warn") return <IconWarn />;
  return <IconAlert />;
}

export function PreflightPanel({ report, onRecheck, onFix, checking }: Props) {
  const pass = report.items.filter((i) => i.level === "pass").length;
  const total = report.items.length;
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
              {item.fixAction && item.level !== "pass" ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--linkish"
                  onClick={() => onFix(item.fixAction!)}
                >
                  Open {item.fixAction === "workspace"
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
