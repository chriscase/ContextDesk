/** Work-context status pills for pre-launch Ready (exclude news/X). */

import type { PreflightItem } from "../../lib/preflight";
import { filterWorkContextItems } from "../../lib/preflightCategories";

type Props = {
  items: PreflightItem[];
  onFix?: (fixAction?: string) => void;
};

export function WorkContextPills({ items, onFix }: Props) {
  const work = filterWorkContextItems(items);
  if (!work.length) {
    return (
      <p className="launch-ready__empty">No work-context rows yet — recheck after setup.</p>
    );
  }
  return (
    <ul className="launch-pills" aria-label="Work context sources">
      {work.map((i) => (
        <li key={i.id} className="launch-pills__item" data-level={i.level}>
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
