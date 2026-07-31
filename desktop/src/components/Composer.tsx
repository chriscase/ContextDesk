import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconClose, IconExpand, IconSend } from "./icons";
import type { ModelOptionDto } from "../lib/host";

type Props = {
  /** Return `false` to reject the send (draft is preserved). */
  onSubmit: (text: string) => boolean | Promise<boolean> | void;
  disabled?: boolean;
  busy?: boolean;
  onStop?: () => void;
  models?: ModelOptionDto[];
  selectedModelKey?: string;
  onModelChange?: (selectionKey: string) => void;
  onSetDefaultModel?: (selectionKey: string) => void;
  /**
   * When `id` changes, replace the draft with `text` and focus
   * (empty-state starter chips — #300 residual).
   */
  seedRequest?: { id: number; text: string } | null;
  /**
   * Draft text owned by the caller. Supply this (with `onDraftChange`) to keep
   * a draft tied to one conversation and alive across pane switches; omit both
   * and the composer keeps its own local draft.
   */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /**
   * Why input is currently blocked, in the user's terms. Shown in the hint the
   * textarea is described by, so a disabled composer is never silent.
   */
  disabledReason?: string;
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
  seedRequest,
  draft,
  onDraftChange,
  disabledReason,
}: Props) {
  const [localValue, setLocalValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Synchronous latch — two Enters in one frame must submit once. */
  const submittingRef = useRef(false);

  const controlled = draft !== undefined;
  const value = controlled ? draft : localValue;
  const setValue = useCallback(
    (next: string | ((prev: string) => string)) => {
      if (controlled) {
        const resolved =
          typeof next === "function" ? next(draft ?? "") : next;
        onDraftChange?.(resolved);
        return;
      }
      setLocalValue(next);
    },
    [controlled, draft, onDraftChange],
  );

  // `setValue` changes identity with the controlled draft, so keying this on
  // the seed request alone is what stops every keystroke from re-seeding.
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  useEffect(() => {
    if (!seedRequest?.text) return;
    setValueRef.current(seedRequest.text);
    setExpanded(seedRequest.text.length > 80);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }, [seedRequest?.id, seedRequest?.text]);

  /**
   * Put the caret back in the composer after a send, but only when focus is
   * still inside it — clicking Send disables that button and would otherwise
   * drop focus to `<body>`. Never steal focus the user moved elsewhere.
   */
  const restoreFocus = useCallback(() => {
    const active = document.activeElement;
    const cameFromComposer =
      !active || active === document.body || rootRef.current?.contains(active);
    if (!cameFromComposer) return;
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  const submit = useCallback(async () => {
    const t = value.trim();
    if (!t || disabled || busy || submittingRef.current) return;
    submittingRef.current = true;
    // Clear immediately on submit so the draft does not sit through the whole
    // agent turn (startTurn awaits network/tools). Restore only if rejected.
    setValue("");
    setExpanded(false);
    try {
      const res = onSubmit(t);
      const accepted = res instanceof Promise ? await res : res;
      if (accepted === false) {
        setValue(t);
      }
    } catch {
      // Parent threw before accepting — put the draft back.
      setValue(t);
    } finally {
      submittingRef.current = false;
      restoreFocus();
    }
  }, [value, disabled, busy, onSubmit, setValue, restoreFocus]);

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
  /**
   * What the composer is doing, in the user's terms. `busy` already has its own
   * Stop affordance, so an explicit reason wins; a silent hard-disable never
   * reaches the user.
   */
  const statusHint = busy
    ? (disabledReason ?? "Waiting for the response — Stop to cancel")
    : disabled
      ? (disabledReason ?? "Sending is paused right now")
      : "Enter ↵ · Shift+Enter newline";

  return (
    <div
      ref={rootRef}
      className="composer chat-input-surface"
      data-expanded={expanded ? "true" : "false"}
      data-busy={busy ? "true" : "false"}
      data-blocked={disabled && !busy ? "true" : "false"}
      onMouseDown={(e) => {
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
          // Do not submit while IME is composing (CJK etc.).
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            void submit();
          }
        }}
      />

      <div className="composer__bar">
        <div className="composer__bar-left">
          {onModelChange ? (
            <label className="composer__pill" title="Model for this chat">
              <span className="composer__pill-label">Model</span>
              <select
                className="composer__pill-select"
                value={selectValue}
                disabled={busy || (groups.length === 0 && !selectValue)}
                aria-label="Chat model by source"
                onChange={(e) => onModelChange(e.target.value)}
              >
                {groups.length === 0 ? (
                  <option value={selectValue || ""}>
                    {selectValue || "No models listed — check AI settings"}
                  </option>
                ) : (
                  groups.map(([group, opts]) => (
                    <optgroup key={group} label={group}>
                      {opts.map((m) => (
                        <option key={m.selection_key} value={m.selection_key}>
                          {m.label}
                          {m.is_default ? " · default" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))
                )}
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
          <span
            className="composer__hint"
            id={`${id}-hint`}
            data-kind={disabled || busy ? "status" : "keys"}
            role={disabled || busy ? "status" : undefined}
          >
            {statusHint}
          </span>
          {busy && onStop ? (
            <button
              type="button"
              className="composer__stop"
              onClick={onStop}
              title="Cancel the current turn"
              aria-label="Stop — cancel the current turn"
            >
              <IconClose />
              Stop
            </button>
          ) : null}
          <button
            type="button"
            className="composer__send"
            onClick={() => void submit()}
            disabled={!canSend}
            title="Send message"
            aria-label="Send"
            aria-describedby={`${id}-hint`}
          >
            <IconSend />
          </button>
        </div>
      </div>
    </div>
  );
}
