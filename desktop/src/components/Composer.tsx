import { useCallback, useId, useState } from "react";
import { IconClose, IconExpand, IconSend } from "./icons";
import type { ModelOptionDto } from "../lib/host";

type Props = {
  onSubmit: (text: string) => void;
  /** When true, Send is disabled and Stop is offered if onStop provided. */
  disabled?: boolean;
  busy?: boolean;
  onStop?: () => void;
  /** Models available from the active provider. */
  models?: ModelOptionDto[];
  /** Model id for this chat. */
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  /** Mark selected model as default for new chats. */
  onSetDefaultModel?: (modelId: string) => void;
};

export function Composer({
  onSubmit,
  disabled,
  busy,
  onStop,
  models = [],
  selectedModel,
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

  const modelOptions =
    selectedModel && !models.some((m) => m.id === selectedModel)
      ? [
          {
            id: selectedModel,
            label: selectedModel,
            provider_id: "",
            provider_label: "",
            is_default: false,
          },
          ...models,
        ]
      : models;

  return (
    <div className="composer" data-expanded={expanded ? "true" : "false"}>
      <div className="composer__toolbar">
        <span className="composer__hint" id={`${id}-hint`}>
          Enter to send · Shift+Enter newline · /skill id …
        </span>
        <div className="row">
          {modelOptions.length > 0 && onModelChange ? (
            <label className="composer__model">
              <span className="composer__model-label">Model</span>
              <select
                className="composer__model-select"
                value={selectedModel ?? modelOptions[0]?.id ?? ""}
                disabled={busy}
                aria-label="Chat model"
                title="Model for this chat (can change mid-conversation)"
                onChange={(e) => onModelChange(e.target.value)}
              >
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.is_default ? " · default" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selectedModel && onSetDefaultModel ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              title="Use this model for new chats"
              disabled={busy || models.find((m) => m.id === selectedModel)?.is_default}
              onClick={() => onSetDefaultModel(selectedModel)}
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
