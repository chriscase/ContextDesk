import { useMemo, useState } from "react";
import { IconTool } from "./icons";

export type ToolCallView = {
  id: string;
  name: string;
  summary: string;
  detail?: string;
  ok?: boolean;
};

const COLLAPSE_AFTER = 3;

type Props = {
  tools: ToolCallView[];
};

export function ToolCallList({ tools }: Props) {
  const [groupOpen, setGroupOpen] = useState(false);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  const { visible, hiddenCount } = useMemo(() => {
    if (tools.length <= COLLAPSE_AFTER || groupOpen) {
      return { visible: tools, hiddenCount: 0 };
    }
    return {
      visible: tools.slice(0, COLLAPSE_AFTER),
      hiddenCount: tools.length - COLLAPSE_AFTER,
    };
  }, [tools, groupOpen]);

  if (tools.length === 0) return null;

  return (
    <div className="tool-group">
      <button
        type="button"
        className="tool-group__header"
        onClick={() => setGroupOpen((v) => !v)}
      >
        <span>
          <IconTool /> {tools.length} tool call{tools.length === 1 ? "" : "s"}
        </span>
        <span>
          {hiddenCount > 0
            ? `+${hiddenCount} more — expand`
            : groupOpen && tools.length > COLLAPSE_AFTER
              ? "collapse"
              : "details"}
        </span>
      </button>
      {visible.map((t) => {
        const open = !!openIds[t.id];
        return (
          <div key={t.id} className="tool-row">
            <IconTool />
            <div>
              <div className="tool-row__name">{t.name}</div>
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
            >
              {open ? "Hide" : "View"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
