import { useCallback, useId, useMemo, useState } from "react";
import { IconClose, IconExpand, IconSend } from "./icons";
import type { ModelOptionDto } from "../lib/host";

type Props = {
  onSubmit: (text: string) => void;
  /** When true, Send is disabled and Stop is offered if onStop provided. */
  disabled?: boolean;
  busy?: boolean;
  onStop?: () => void;
  /** Models available from configured providers (grouped by source). */
  models?: ModelOptionDto[];
  /** Full selection key `provider::model` for this chat. */
  selectedModelKey?: string;
  onModelChange?: (selectionKey: string) => void;
  /** Mark selected model as default for new chats. */
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

  return (
    <div className="composer" data-expanded={expanded ? "true" : "false"}>
      <div className="composer__toolbar">
        <span className="composer__hint" id={`${id}-hint`}>
          Enter to send · Shift+Enter newline · /skill id …
        </span>
        <div className="row">
          {groups.length > 0 && onModelChange ? (
            <label className="composer__model">
              <span className="composer__model-label">Model</span>
              <select
                className="composer__model-select"
                value={selectValue}
                disabled={busy}
                aria-label="Chat model by source"
                title="Model for this chat — grouped by provider source"
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
          {selectValue && onSetDefaultModel ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title="Use this model for new chats"
              disabled={busy || selectedIsDefault}
              onClick={() => onSetDefaultModel(selectValue)}
            >
              Set default
            </button>
          ) : null}
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
