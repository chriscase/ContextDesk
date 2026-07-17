import { useCallback, useId, useState } from "react";
import { IconExpand, IconSend } from "./icons";

type Props = {
  onSubmit: (text: string) => void;
  disabled?: boolean;
};

export function Composer({ onSubmit, disabled }: Props) {
  const [value, setValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const id = useId();

  const submit = useCallback(() => {
    const t = value.trim();
    if (!t || disabled) return;
    onSubmit(t);
    setValue("");
  }, [value, disabled, onSubmit]);

  return (
    <div className="composer" data-expanded={expanded ? "true" : "false"}>
      <div className="composer__toolbar">
        <span className="composer__hint" id={`${id}-hint`}>
          Enter to send · Shift+Enter newline · markdown welcome
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => setExpanded((e) => !e)}
          aria-pressed={expanded}
          title={expanded ? "Collapse composer" : "Expand composer"}
        >
          <IconExpand />
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <textarea
        className="composer__textarea"
        aria-labelledby={`${id}-hint`}
        placeholder="Ask where something lives, how a system works, or what we already know…"
        value={value}
        rows={expanded ? 8 : 2}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={disabled || !value.trim()}
        >
          <IconSend />
          Send
        </button>
      </div>
    </div>
  );
}
