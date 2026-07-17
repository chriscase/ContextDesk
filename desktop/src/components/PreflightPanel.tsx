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
  return (
    <div>
      <p className="section-lead">
        Environment health for local tools and remote gateways. Fix issues here
        instead of editing config files. Recheck anytime.
      </p>
      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onRecheck}
          disabled={checking}
        >
          <IconRefresh />
          {checking ? "Checking…" : "Recheck"}
        </button>
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
                  className="btn btn--ghost"
                  style={{ marginTop: 6, paddingLeft: 0 }}
                  onClick={() => onFix(item.fixAction!)}
                >
                  Open {item.fixAction} settings →
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
