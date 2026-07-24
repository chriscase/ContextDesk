/** Work-context status pills for pre-launch Ready (exclude news/X). */

import type { PreflightItem } from "../../lib/preflight";
import { filterWorkContextItems } from "../../lib/preflightCategories";

type Props = {
  items: PreflightItem[];
  onFix?: (fixAction?: string) => void;
  /** grid = multi-column on wide screens; list = single column */
  layout?: "grid" | "list";
};

export function WorkContextPills({ items, onFix, layout = "list" }: Props) {
  const work = filterWorkContextItems(items);
  if (!work.length) {
    return (
      <p className="launch-ready__empty">
        No work-context rows yet — recheck after setup.
      </p>
    );
  }
  const listClass =
    layout === "grid"
      ? "launch-status-grid launch-status-grid--dense"
      : "launch-pills";
  return (
    <ul className={listClass} aria-label="Work context sources">
      {work.map((i) => (
        <li key={i.id} data-level={i.level} className="launch-pills__item">
          <span className="launch-pills__status" aria-hidden>
            {i.level === "pass"
              ? "●"
              : i.level === "warn"
                ? "!"
                : i.level === "off"
                  ? "○"
                  : "×"}
          </span>
          <div className="launch-pills__body">
            <div className="launch-pills__title">{i.title}</div>
            <div className="launch-pills__detail">{i.detail}</div>
          </div>
          {i.level === "warn" && i.fixAction && onFix ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onFix(i.fixAction)}
            >
              Fix
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
