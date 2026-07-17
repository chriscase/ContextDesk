import { useMemo, useState } from "react";
import { IconAlert, IconCheck, IconTool, IconWarn } from "./icons";

export type ToolCallView = {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  ok?: boolean;
};

/** Default collapse threshold (AC: ~3–5, configurable). */
export const DEFAULT_TOOL_COLLAPSE_AFTER = 4;

type Props = {
  tools: ToolCallView[];
  /** Collapse list when more than this many tools (default 4). */
  collapseAfter?: number;
};

function StatusIcon({ ok }: { ok?: boolean }) {
  if (ok === true) return <IconCheck />;
  if (ok === false) return <IconAlert />;
  return <IconWarn />;
}

export function ToolCallList({
  tools,
  collapseAfter = DEFAULT_TOOL_COLLAPSE_AFTER,
}: Props) {
  const [groupOpen, setGroupOpen] = useState(false);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  const { visible, hiddenCount } = useMemo(() => {
    if (tools.length <= collapseAfter || groupOpen) {
      return { visible: tools, hiddenCount: 0 };
    }
    return {
      visible: tools.slice(0, collapseAfter),
      hiddenCount: tools.length - collapseAfter,
    };
  }, [tools, groupOpen, collapseAfter]);

  if (tools.length === 0) return null;

  return (
    <div className="tool-group">
      <button
        type="button"
        className="tool-group__header"
        onClick={() => setGroupOpen((v) => !v)}
        aria-expanded={groupOpen || tools.length <= collapseAfter}
      >
        <span>
          <IconTool /> {tools.length} tool call{tools.length === 1 ? "" : "s"}
        </span>
        <span>
          {hiddenCount > 0
            ? `+${hiddenCount} more — expand all`
            : groupOpen && tools.length > collapseAfter
              ? "collapse group"
              : "toggle"}
        </span>
      </button>
      {visible.map((t) => {
        const open = !!openIds[t.id];
        return (
          <div
            key={t.id}
            className="tool-row"
            data-ok={t.ok === true ? "true" : t.ok === false ? "false" : "pending"}
          >
            <StatusIcon ok={t.ok} />
            <div>
              <div className="tool-row__name">
                <IconTool /> {t.name}
              </div>
              <div className="tool-row__summary">{t.summary}</div>
              {open && t.detail ? (
                <pre className="tool-row__detail">{t.detail}</pre>
              ) : null}
            </div>
            <button
              type="button"
              className="tool-row__toggle"
              onClick={() =>
                setOpenIds((m) => ({ ...m, [t.id]: !m[t.id] }))
              }
              aria-expanded={open}
            >
              {open ? "Hide" : "View"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
