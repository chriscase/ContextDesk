import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type BaseProps = {
  label: string;
  hint?: string;
  error?: string | null;
  ok?: string | null;
  pending?: string | null;
  id: string;
};

export function Field({
  label,
  hint,
  error,
  ok,
  pending,
  id,
  children,
}: BaseProps & { children: ReactNode }) {
  const invalid = Boolean(error);
  return (
    <div className="field" data-invalid={invalid ? "true" : "false"}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && !error && !ok && !pending ? (
        <span className="field__hint">{hint}</span>
      ) : null}
      {pending ? (
        <span className="field__pending" role="status">
          {pending}
        </span>
      ) : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
      {ok && !error ? <span className="field__ok">{ok}</span> : null}
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
  ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint} error={error} ok={ok} pending={pending} id={id}>
      <input id={id} className="field__control" {...rest} />
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
  ...rest
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field
      label={label}
      hint={hint ?? "Stored in the OS keychain — never written to a plain config file."}
      error={error}
      ok={ok}
      pending={pending}
      id={id}
    >
      <input id={id} className="field__control" type="password" autoComplete="off" {...rest} />
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  children,
  ...rest
}: BaseProps & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      <select id={id} className="field__control" {...rest}>
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
  ...rest
}: BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      <textarea id={id} className="field__control" rows={3} {...rest} />
    </Field>
  );
}
