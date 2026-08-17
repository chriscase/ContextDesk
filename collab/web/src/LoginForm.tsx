import { useState, type FormEvent } from "react";

export function LoginForm(props: {
  onSuccess: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = String(data.get("username") ?? "");
    const password = String(data.get("password") ?? "");
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setError("Sign-in failed.");
        return;
      }
      form.reset();
      props.onSuccess();
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login" onSubmit={(e) => void onSubmit(e)}>
      <label className="login__label">
        Username
        <input className="login__input" name="username" autoComplete="username" required />
      </label>
      <label className="login__label">
        Password
        <input
          className="login__input"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      {error ? <p className="login__error">{error}</p> : null}
      <div className="login__actions">
        <button className="login__submit" type="submit" disabled={pending}>
          Sign in
        </button>
      </div>
    </form>
  );
}
