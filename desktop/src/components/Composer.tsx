import { useCallback, useId, useState } from "react";
import { IconClose, IconExpand, IconSend } from "./icons";

type Props = {
  onSubmit: (text: string) => void;
  /** When true, Send is disabled and Stop is offered if onStop provided. */
  disabled?: boolean;
  busy?: boolean;
  onStop?: () => void;
};

export function Composer({ onSubmit, disabled, busy, onStop }: Props) {
  const [value, setValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const id = useId();

  const submit = useCallback(() => {
    const t = value.trim();
    if (!t || disabled || busy) return;
    onSubmit(t);
    setValue("");
  }, [value, disabled, busy, onSubmit]);

  const insertSnippet = (snippet: string) => {
    setValue((v) => (v ? `${v}\n${snippet}` : snippet));
    setExpanded(true);
  };

  return (
    <div className="composer" data-expanded={expanded ? "true" : "false"}>
      <div className="composer__toolbar">
        <span className="composer__hint" id={`${id}-hint`}>
          Enter to send · Shift+Enter newline · /skill id …
        </span>
        <div className="row">
          <button
            type="button"
            className="btn btn--ghost"
            title="Insert bullet list"
            onClick={() => insertSnippet("- item\n- item")}
          >
            List
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            title="Insert code fence"
            onClick={() => insertSnippet("```\n\n```")}
          >
            Code
          </button>
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
      </div>
      <textarea
        className="composer__textarea"
        aria-labelledby={`${id}-hint`}
        placeholder="Ask where something lives, how a system works, or what we already know…"
        value={value}
        rows={expanded ? 8 : 2}
        disabled={disabled && !busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__actions">
        {busy && onStop ? (
          <button type="button" className="btn btn--ghost" onClick={onStop}>
            <IconClose />
            Stop
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          onClick={submit}
          disabled={disabled || busy || !value.trim()}
        >
          <IconSend />
          Send
        </button>
      </div>
    </div>
  );
}
