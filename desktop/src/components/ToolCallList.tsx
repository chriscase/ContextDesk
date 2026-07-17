import { useMemo, useState } from "react";
import { IconAlert, IconCheck, IconTool, IconWarn } from "./icons";

export type ToolCallView = {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  ok?: boolean;
};

/** Default collapse threshold for long tool lists. */
export const DEFAULT_TOOL_COLLAPSE_AFTER = 6;

type Props = {
  tools: ToolCallView[];
  /** Show only the first N until “show all” (default 6). */
  collapseAfter?: number;
};

function StatusIcon({ ok }: { ok?: boolean }) {
  if (ok === true) return <IconCheck />;
  if (ok === false) return <IconAlert />;
  return <IconWarn />;
}

function hasExpandableDetail(t: ToolCallView): boolean {
  return Boolean(t.detail && t.detail.trim().length > 0);
}

export function ToolCallList({
  tools,
  collapseAfter = DEFAULT_TOOL_COLLAPSE_AFTER,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  /** Open detail panels; failures start expanded so blocks are visible. */
  const [openIds, setOpenIds] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const t of tools) {
      if (t.ok === false && hasExpandableDetail(t)) init[t.id] = true;
    }
    return init;
  });

  const { visible, hiddenCount } = useMemo(() => {
    if (tools.length <= collapseAfter || showAll) {
      return { visible: tools, hiddenCount: 0 };
    }
    return {
      visible: tools.slice(0, collapseAfter),
      hiddenCount: tools.length - collapseAfter,
    };
  }, [tools, showAll, collapseAfter]);

  if (tools.length === 0) return null;

  const toggle = (id: string) => {
    setOpenIds((m) => ({ ...m, [id]: !m[id] }));
  };

  return (
    <div className="tool-group" role="list" aria-label="Tool calls">
      <div className="tool-group__bar">
        <span className="tool-group__label">
          <IconTool /> {tools.length} tool{tools.length === 1 ? "" : "s"}
        </span>
        {tools.length > collapseAfter ? (
          <button
            type="button"
            className="tool-group__more"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show fewer" : `Show all (+${hiddenCount})`}
          </button>
        ) : null}
      </div>
      {visible.map((t) => {
        const expandable = hasExpandableDetail(t);
        const open = expandable && !!openIds[t.id];
        return (
          <div
            key={t.id}
            className="tool-row"
            data-ok={
              t.ok === true ? "true" : t.ok === false ? "false" : "pending"
            }
            data-open={open ? "true" : "false"}
            role="listitem"
          >
            <button
              type="button"
              className="tool-row__main"
              onClick={() => expandable && toggle(t.id)}
              disabled={!expandable}
              aria-expanded={expandable ? open : undefined}
              title={
                expandable
                  ? open
                    ? "Hide tool output"
                    : "Show tool output"
                  : undefined
              }
            >
              <span className="tool-row__status" aria-hidden>
                <StatusIcon ok={t.ok} />
              </span>
              <span className="tool-row__name">{t.name}</span>
              <span className="tool-row__summary" title={t.summary}>
                {t.summary || (t.ok === false ? "failed" : "…")}
              </span>
              {expandable ? (
                <span className="tool-row__chev" aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
              ) : (
                <span className="tool-row__chev tool-row__chev--empty" />
              )}
            </button>
            {open && t.detail ? (
              <pre className="tool-row__detail">{t.detail}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
