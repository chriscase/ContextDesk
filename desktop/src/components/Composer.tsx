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
import { curateModels } from "../lib/modelCuration";

type Props = {
  /** Return `false` to reject the send (draft is preserved). */
  onSubmit: (
    text: string,
    userSelection?: string,
  ) => boolean | Promise<boolean> | void;
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
  /** Called once the seed has been applied, so the owner can retire it. */
  onSeedConsumed?: (seedId: number) => void;
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
  /**
   * Ask the host to re-test native tool support for the selected provider/model
   * pair. Offered only when tools were disabled by a *learned* rejection from
   * that exact model (#650) — a profile-level decision is the user's own and is
   * changed in Settings.
   */
  onRetryModelTools?: (model: ModelOptionDto) => Promise<void> | void;
  /** Linked-log turns must use host-resolved corpus evidence instead. */
  allowUserSelection?: boolean;
};

export const MAX_USER_SELECTION_CHARS = 2_000;

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
  onSeedConsumed,
  draft,
  onDraftChange,
  disabledReason,
  onRetryModelTools,
  allowUserSelection = true,
}: Props) {
  const [retryingTools, setRetryingTools] = useState(false);
  const [localValue, setLocalValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [userSelection, setUserSelection] = useState("");
  const id = useId();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Synchronous latch — two Enters in one frame must submit once. */
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!allowUserSelection) {
      setSelectionOpen(false);
      setUserSelection("");
    }
  }, [allowUserSelection]);

  const controlled = draft !== undefined;
  const wasControlledRef = useRef(controlled);
  const handingOffLocalDraft =
    controlled && !wasControlledRef.current && !draft && Boolean(localValue);
  const value = controlled
    ? handingOffLocalDraft
      ? localValue
      : draft
    : localValue;

  useEffect(() => {
    const wasControlled = wasControlledRef.current;
    wasControlledRef.current = controlled;
    if (controlled && !wasControlled && localValue && !draft) {
      // Hydration assigned the composer a real conversation owner after the
      // user had already typed. Transfer the local text instead of switching
      // to the owner's initially empty value and swallowing it.
      onDraftChange?.(localValue);
    }
  }, [controlled, draft, localValue, onDraftChange]);
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
  const onSeedConsumedRef = useRef(onSeedConsumed);
  onSeedConsumedRef.current = onSeedConsumed;

  useEffect(() => {
    if (!seedRequest?.text) return;
    setValueRef.current(seedRequest.text);
    setExpanded(seedRequest.text.length > 80);
    // Tell the owner the seed is spent. Composer remounts on every pane switch,
    // so a seed left standing would re-fire on each remount and overwrite the
    // now-persistent draft — including in a different conversation.
    onSeedConsumedRef.current?.(seedRequest.id);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    });
  }, [seedRequest?.id, seedRequest?.text]);

  const submit = useCallback(async () => {
    const t = value.trim();
    if (!t || disabled || busy || submittingRef.current) return;
    // Whether the caret was ours must be decided *now*: by the time the turn
    // resolves, clicking Send has already disabled that button and dropped
    // focus to <body>, which is indistinguishable from the user clicking away.
    const hadFocus = Boolean(rootRef.current?.contains(document.activeElement));
    const selected = userSelection.trim();
    submittingRef.current = true;
    // Clear immediately on submit so the draft does not sit through the whole
    // agent turn (startTurn awaits network/tools). Restore only if rejected.
    setValue("");
    setUserSelection("");
    setExpanded(false);
    const res = selected ? onSubmit(t, selected) : onSubmit(t);
    // Release at the end of *this task*, not at turn completion. The race the
    // latch guards is two handlers running against one pre-clear render, which
    // is confined to a single task; holding it across the awaited turn left the
    // composer inert after Stop re-enabled it, silently swallowing the next
    // send. By the time a later task runs, the cleared draft is the guard.
    queueMicrotask(() => {
      submittingRef.current = false;
    });
    if (hadFocus) {
      requestAnimationFrame(() => taRef.current?.focus());
    }
    try {
      const accepted = res instanceof Promise ? await res : res;
      if (accepted === false) {
        setValue(t);
        setUserSelection(selected);
      }
    } catch {
      // Parent threw before accepting — put the draft back.
      setValue(t);
      setUserSelection(selected);
    }
  }, [value, userSelection, disabled, busy, onSubmit, setValue]);

  const insertSnippet = (snippet: string) => {
    setValue((v) => (v ? `${v}\n${snippet}` : snippet));
    setExpanded(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // One shared curation contract for every picker (#678) — no local grouping.
  const curated = useMemo(
    () => curateModels(models, { selectedKey: selectedModelKey ?? null }),
    [models, selectedModelKey],
  );
  const groups = curated.groups;

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
   * What the composer is doing, in the user's terms. A streaming turn always
   * keeps its own wording (it is what Stop refers to); any other reason is
   * appended rather than replacing it. A reason given while the composer is
   * still usable — unresolved setup, say — is shown too, so the explanation
   * never depends on the input also being disabled.
   */
  const statusHint = busy
    ? `Waiting for the response — Stop to cancel${
        disabledReason ? ` · ${disabledReason}` : ""
      }`
    : (disabledReason ??
      (disabled
        ? "Sending is paused right now"
        : "Enter ↵ · Shift+Enter newline"));

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

      {selectionOpen ? (
        <div className="composer__selection" data-testid="composer-user-selection">
          <label htmlFor={`${id}-selection`}>
            Selected context for the next message
          </label>
          <textarea
            id={`${id}-selection`}
            value={userSelection}
            maxLength={MAX_USER_SELECTION_CHARS}
            rows={3}
            disabled={disabled || busy}
            placeholder="Paste or type the exact text to include for this turn…"
            onChange={(event) => setUserSelection(event.target.value)}
          />
          <div className="composer__selection-meta">
            <span>
              Explicit client evidence · one turn only · not inferred from the viewport
            </span>
            <span>
              {userSelection.length.toLocaleString()} / {MAX_USER_SELECTION_CHARS.toLocaleString()}
            </span>
          </div>
        </div>
      ) : null}

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
                  groups.map((group) => (
                    <optgroup key={group.key} label={group.label}>
                      {group.options.map((m) => (
                        <option
                          key={m.selection_key}
                          value={m.selection_key}
                          // A profile the user disabled tools on cannot be
                          // overridden per model; a learned model rejection can
                          // be retried, so that option stays selectable.
                          disabled={
                            !m.tools_enabled &&
                            m.tools_disabled_reason === "profile"
                          }
                        >
                          {m.label}
                          {m.is_default ? " · default" : ""}
                          {!m.tools_enabled ? " · tools unavailable" : ""}
                          {m.availability === "configured_unverified"
                            ? " · availability unverified"
                            : ""}
                          {m.hidden ? " · hidden" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))
                )}
              </select>
            </label>
          ) : null}

          {curated.truncated > 0 ? (
            <span className="composer__capability" role="status">
              {curated.truncated} more model
              {curated.truncated === 1 ? "" : "s"} not listed — narrow the
              inventory in Settings → AI
            </span>
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

          {selected && !selected.tools_enabled ? (
            <span className="composer__capability" role="status">
              <span>
                {selected.tools_disabled_reason === "profile"
                  ? "Tools are off for this provider"
                  : "This model rejected native tools"}
              </span>
              {selected.tools_disabled_reason === "model" &&
              onRetryModelTools ? (
                <button
                  type="button"
                  className="composer__chip"
                  disabled={busy || retryingTools}
                  title={`Re-test native tool support for ${selected.label}`}
                  onClick={() => {
                    setRetryingTools(true);
                    // Reporting the failure is the caller's job (App surfaces
                    // it); swallowing it here only stops an unhandled
                    // rejection, and the button must return to rest either way.
                    void Promise.resolve(onRetryModelTools(selected))
                      .catch(() => {})
                      .finally(() => setRetryingTools(false));
                  }}
                >
                  {retryingTools ? "Retrying…" : "Retry tools"}
                </button>
              ) : null}
            </span>
          ) : null}

          {allowUserSelection ? (
            <button
              type="button"
              className={`composer__chip${selectionOpen || userSelection ? " is-on" : ""}`}
              aria-expanded={selectionOpen}
              aria-controls={`${id}-selection`}
              disabled={busy}
              title="Explicitly include selected text in the next ordinary turn"
              onClick={() => setSelectionOpen((open) => !open)}
            >
              Context{userSelection ? " · selected" : ""}
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
            data-kind={disabled || busy || disabledReason ? "status" : "keys"}
            role={disabled || busy || disabledReason ? "status" : undefined}
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
