import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useEffect, useId, useState } from "react";
import { HelpTip } from "../HelpTip";

/** Optional setup help shown as a ? icon next to the label. */
export type FieldHelp = {
  label: string;
  title: string;
  body: ReactNode;
};

type BaseProps = {
  label: string;
  hint?: string;
  error?: string | null;
  ok?: string | null;
  pending?: string | null;
  id: string;
  help?: FieldHelp;
};

function describedByIds(
  id: string,
  hint?: string,
  error?: string | null,
  ok?: string | null,
  pending?: string | null,
): string | undefined {
  const parts = [
    hint && !error && !ok && !pending ? `${id}-hint` : null,
    pending ? `${id}-pending` : null,
    error ? `${id}-error` : null,
    ok && !error ? `${id}-ok` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

export function Field({
  label,
  hint,
  error,
  ok,
  pending,
  id,
  help,
  children,
}: BaseProps & { children: ReactNode }) {
  const invalid = Boolean(error);
  return (
    <div className="field" data-invalid={invalid ? "true" : "false"}>
      <div className="field__label-row">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {help ? (
          <HelpTip label={help.label} title={help.title}>
            {help.body}
          </HelpTip>
        ) : null}
      </div>
      {children}
      {hint && !error && !ok && !pending ? (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {pending ? (
        <span className="field__pending" id={`${id}-pending`} role="status" aria-live="polite">
          {pending}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
      {ok && !error ? (
        <span className="field__ok" id={`${id}-ok`} role="status">
          {ok}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  ok,
  pending,
  id,
  help,
  ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      ok={ok}
      pending={pending}
      id={id}
      help={help}
    >
      <input
        id={id}
        className="field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds(id, hint, error, ok, pending)}
        {...rest}
      />
    </Field>
  );
}

export function SecretField({
  label,
  hint,
  error,
  ok,
  pending,
  id,
  help,
  ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  const h = hint ?? "Stored in the OS keychain — never written to a plain config file.";
  return (
    <Field
      label={label}
      hint={h}
      error={error}
      ok={ok}
      pending={pending}
      id={id}
      help={help}
    >
      <input
        id={id}
        className="field__control"
        type="password"
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds(id, h, error, ok, pending)}
        {...rest}
      />
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  help,
  children,
  ...rest
}: BaseProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} hint={hint} error={error} id={id} help={help}>
      <select
        id={id}
        className="field__control"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds(id, hint, error, null, null)}
        {...rest}
      >
        {children}
      </select>
    </Field>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  id,
  help,
  ...rest
}: BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint} error={error} id={id} help={help}>
      <textarea
        id={id}
        className="field__control"
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedByIds(id, hint, error, null, null)}
        {...rest}
      />
    </Field>
  );
}

export function ToggleField({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
  help,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  help?: FieldHelp;
}) {
  return (
    <div className="field">
      <div className="toggle-row">
        <label className="toggle" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{label}</span>
        </label>
        {help ? (
          <HelpTip label={help.label} title={help.title}>
            {help.body}
          </HelpTip>
        ) : null}
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

type PathPickerProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  ok?: string | null;
  pending?: string | null;
  value: string;
  onChange: (path: string) => void;
  onPick?: () => void | Promise<void>;
  pickLabel?: string;
};

/** Path field with optional native folder picker button (host-provided onPick). */
export function PathField({
  id,
  label,
  hint,
  error,
  ok,
  pending,
  value,
  onChange,
  onPick,
  pickLabel = "Browse…",
}: PathPickerProps) {
  return (
    <Field label={label} hint={hint} error={error} ok={ok} pending={pending} id={id}>
      <div className="field-row">
        <input
          id={id}
          className="field__control"
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
        {onPick ? (
          <button type="button" className="btn btn--ghost" onClick={() => void onPick()}>
            {pickLabel}
          </button>
        ) : null}
      </div>
    </Field>
  );
}

/**
 * Debounced async validator: runs `validate` after `delayMs` of value stability.
 * Returns { error, ok, pending } for Field props.
 */
export function useDebouncedAsyncCheck(
  value: string,
  validate: (v: string) => Promise<{ error?: string | null; ok?: string | null }>,
  delayMs = 400,
  enabled = true,
): { error: string | null; ok: string | null; pending: string | null } {
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const seq = useState(() => ({ n: 0 }))[0];
  // Always call latest validate without re-subscribing on identity churn.
  const validateRef = useState(() => ({ fn: validate }))[0];
  validateRef.fn = validate;

  useEffect(() => {
    if (!enabled) {
      setError(null);
      setOk(null);
      setPending(null);
      return;
    }
    let cancelled = false;
    setPending("Checking…");
    setError(null);
    setOk(null);
    const t = window.setTimeout(() => {
      seq.n += 1;
      const my = seq.n;
      void validateRef.fn(value).then((r) => {
        if (cancelled || my !== seq.n) return;
        setPending(null);
        setError(r.error ?? null);
        setOk(r.ok ?? null);
      });
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [value, delayMs, enabled, seq, validateRef]);

  return { error, ok, pending };
}

/** Convenience unique id when parent does not supply one. */
export function useFieldId(prefix: string): string {
  const reactId = useId();
  return `${prefix}-${reactId}`;
}
