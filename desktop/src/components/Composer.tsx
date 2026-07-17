import { useCallback, useId, useMemo, useRef, useState } from "react";
import { IconClose, IconExpand, IconSend } from "./icons";
import type { ModelOptionDto } from "../lib/host";

type Props = {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  busy?: boolean;
  onStop?: () => void;
  models?: ModelOptionDto[];
  selectedModelKey?: string;
  onModelChange?: (selectionKey: string) => void;
  onSetDefaultModel?: (selectionKey: string) => void;
};

export function Composer({
  onSubmit,
  disabled,
  busy,
  onStop,
  models = [],
  selectedModelKey,
  onModelChange,
  onSetDefaultModel,
}: Props) {
  const [value, setValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const t = value.trim();
    if (!t || disabled || busy) return;
    onSubmit(t);
    setValue("");
  }, [value, disabled, busy, onSubmit]);

  const insertSnippet = (snippet: string) => {
    setValue((v) => (v ? `${v}\n${snippet}` : snippet));
    setExpanded(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const groups = useMemo(() => {
    const map = new Map<string, ModelOptionDto[]>();
    for (const m of models) {
      const g = m.group || m.provider_label || "Other";
      const list = map.get(g) ?? [];
      list.push(m);
      map.set(g, list);
    }
    return [...map.entries()];
  }, [models]);

  const selected: ModelOptionDto | undefined = selectedModelKey
    ? models.find((m) => m.selection_key === selectedModelKey) ||
      models.find((m) => m.id === selectedModelKey)
    : undefined;
  const selectValue =
    selected?.selection_key ??
    selectedModelKey ??
    models.find((m) => m.is_default)?.selection_key ??
    models[0]?.selection_key ??
    "";

  const selectedIsDefault = Boolean(
    models.find((m) => m.selection_key === selectValue)?.is_default,
  );

  const canSend = !disabled && !busy && Boolean(value.trim());

  return (
    <div
      className="composer"
      data-expanded={expanded ? "true" : "false"}
      data-busy={busy ? "true" : "false"}
      onMouseDown={(e) => {
        // Click empty shell chrome focuses the field (not on buttons/selects).
        const t = e.target as HTMLElement;
        if (t.closest("button, select, a, label, textarea")) return;
        taRef.current?.focus();
      }}
    >
      <textarea
        ref={taRef}
        className="composer__textarea"
        id={`${id}-input`}
        aria-describedby={`${id}-hint`}
        placeholder="Message ContextDesk…"
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

      <div className="composer__bar">
        <div className="composer__bar-left">
          {groups.length > 0 && onModelChange ? (
            <label className="composer__pill" title="Model for this chat">
              <span className="composer__pill-label">Model</span>
              <select
                className="composer__pill-select"
                value={selectValue}
                disabled={busy}
                aria-label="Chat model by source"
                onChange={(e) => onModelChange(e.target.value)}
              >
                {groups.map(([group, opts]) => (
                  <optgroup key={group} label={group}>
                    {opts.map((m) => (
                      <option key={m.selection_key} value={m.selection_key}>
                        {m.label}
                        {m.is_default ? " · default" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ) : null}

          {selectValue && onSetDefaultModel && !selectedIsDefault ? (
            <button
              type="button"
              className="composer__chip"
              title="Use this model for new chats"
              disabled={busy}
              onClick={() => onSetDefaultModel(selectValue)}
            >
              Default
            </button>
          ) : null}

          <button
            type="button"
            className="composer__chip"
            title="Insert bullet list"
            onClick={() => insertSnippet("- item\n- item")}
          >
            List
          </button>
          <button
            type="button"
            className="composer__chip"
            title="Insert code fence"
            onClick={() => insertSnippet("```\n\n```")}
          >
            Code
          </button>
          <button
            type="button"
            className={`composer__chip${expanded ? " is-on" : ""}`}
            onClick={() => setExpanded((e) => !e)}
            aria-pressed={expanded}
            title={expanded ? "Collapse" : "Expand"}
          >
            <IconExpand />
            <span className="composer__chip-text">
              {expanded ? "Less" : "More"}
            </span>
          </button>
        </div>

        <div className="composer__bar-right">
          <span className="composer__hint" id={`${id}-hint`}>
            Enter ↵ · Shift+Enter newline
          </span>
          {busy && onStop ? (
            <button
              type="button"
              className="composer__stop"
              onClick={onStop}
              title="Stop generation"
            >
              <IconClose />
              Stop
            </button>
          ) : null}
          <button
            type="button"
            className="composer__send"
            onClick={submit}
            disabled={!canSend}
            title="Send message"
            aria-label="Send"
          >
            <IconSend />
          </button>
        </div>
      </div>
    </div>
  );
}
